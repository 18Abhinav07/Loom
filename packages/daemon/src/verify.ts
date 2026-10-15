// Spec §5.9: claims are checked against tests that exercise the changed symbols; mutation says how much those tests prove.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { applyMutant, indexPython, mutants } from '@loom/indexer';

export interface TestCfg { command: string; label: string; root: string; timeoutS?: number }
export interface TestSym { id: string; file: string; qname: string; label: string }
export interface ClaimResult {
  task: string; state: 'VERIFIED' | 'STALE' | 'UNKNOWN' | 'FAIL'; strength: number | null; blindSpots: string[];
  missing?: string; labels: string[]; failing?: string[];
}
const TAIL = 4096;
const MAX_MUTANT_RUNS = 25;
const MAX_SPLIT = 20;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const short = (sid: string) => sid.slice(sid.indexOf('::') + 2).split('.').pop()!;

/** The repo's `.loom/config.json` `test` section, or null when it has none. */
export function testCfg(repo: string): TestCfg | null {
  const p = join(repo, '.loom', 'config.json');
  if (!existsSync(p)) return null;
  try {
    const t = JSON.parse(readFileSync(p, 'utf8')).test;
    if (!t?.command) return null;
    return { label: '{module_dotted}.{Class}.{method}', root: '.', ...t };
  } catch { return null; }
}

/** A runner label from the template; an empty `{Class}` drops with its separator. */
export function testLabel(file: string, qname: string, cfg: TestCfg): string {
  const dot = qname.lastIndexOf('.');
  const cls = dot < 0 ? '' : qname.slice(0, dot);
  const method = qname.slice(dot + 1);
  const mod = relative(cfg.root, file).replace(/\.py$/, '').replace(/\/__init__$/, '').replaceAll('/', '.');
  const out = cfg.label.replace('{module_dotted}', mod).replace('{path}', file).replace('{method}', method);
  return cls ? out.replace('{Class}', cls) : out.replace(/(\.|::)\{Class\}|\{Class\}(\.|::)/, '');
}

const grepFiles = (cwd: string, name: string, root: string): string[] => {
  try {
    return execFileSync('git', ['grep', '-l', '-w', '--untracked', '-e', name, '--', root], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter((f) => f.endsWith('.py'));
  } catch { return []; }   // exit 1: no match
};

/** Test functions (`test*`) under the test root whose calls reach each symbol. */
export async function mapTests(worktree: string, sids: string[], cfg: TestCfg): Promise<Map<string, TestSym[]>> {
  const out = new Map<string, TestSym[]>();
  const name = short;
  const files = new Set(sids.flatMap((s) => grepFiles(worktree, name(s), cfg.root)));
  for (const f of files) {
    const idx = await indexPython(f, readFileSync(join(worktree, f), 'utf8'));
    const tests = new Map(idx.symbols.filter((s) => s.kind !== 'class' && s.name.startsWith('test')).map((s) => [s.id, s]));
    for (const sid of sids) {
      const hit = new Set(idx.calls.filter((c) => tests.has(c.from)
        && (c.to.includes(sid) || (!c.to.length && c.callee.split('.').pop() === name(sid)))).map((c) => c.from));
      for (const t of hit) {
        const s = tests.get(t)!;
        out.set(sid, [...(out.get(sid) ?? []), { id: s.id, file: f, qname: s.qname, label: testLabel(f, s.qname, cfg) }]);
      }
    }
  }
  return out;
}

export async function writeExercises(g: LoomGraph, map: Map<string, TestSym[]>) {
  const rows = [...map].flatMap(([sid, ts]) => ts.map((t) => ({ sid, ...t })));
  if (rows.length) await g.query(`UNWIND $rows AS r MATCH (s:Symbol {id: r.sid})
    MERGE (t:Symbol {id: r.id}) SET t.isTest = true, t.label = r.label, t.file = r.file, t.qname = r.qname, t.kind = 'test'
    MERGE (t)-[:EXERCISES]->(s)`, { rows });
}

/** The configured command with `{labels}`, in its own process group so a timeout kills the whole tree. */
export function runTests(cwd: string, cfg: TestCfg, labels: string[]): Promise<{ ok: boolean; tail: string; ms: number }> {
  const t0 = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise((done) => {
    const p = spawn('sh', ['-c', cfg.command.replace('{labels}', labels.join(' '))], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = ''; let timedOut = false;
    const keep = (d: Buffer) => { tail = (tail + d.toString()).slice(-TAIL); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* already gone */ } }, (cfg.timeoutS ?? 300) * 1000);
    const end = (code: number | null) => {
      clearTimeout(timer);
      done({ ok: code === 0 && !timedOut, tail: timedOut ? `${tail}\n[loom] test command timed out after ${cfg.timeoutS ?? 300}s` : tail, ms: Date.now() - t0 });
    };
    p.on('error', (e) => { tail += String(e); end(1); });
    p.on('close', end);
  });
}

/** The worktree's own config, else the main checkout's (`.loom/` is not in worktrees). */
export function cfgFor(worktree: string): TestCfg | null {
  const own = testCfg(worktree);
  if (own) return own;
  try { return testCfg(dirname(git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'))); } catch { return null; }
}

/** A detached checkout of the worktree's HEAD plus its uncommitted files: mutants are applied here, never in the agent's tree. */
function scratchOf(worktree: string): { dir: string; done: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'loom-mut-'));
  const dir = join(parent, 'wt');
  git(worktree, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
  const done = () => {
    try { git(worktree, 'worktree', 'remove', '--force', dir); } catch { /* removed below */ }
    rmSync(parent, { recursive: true, force: true });
    try { git(worktree, 'worktree', 'prune'); } catch { /* best effort */ }
  };
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8' });
    for (const line of status.split('\n').filter(Boolean)) {
      if (line.slice(0, 2).includes('D')) continue;
      const f = line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '');
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(worktree, f), join(dir, f));
    }
  } catch (e) { done(); throw e; }
  return { dir, done };
}

/** Spec §5.9: run the tests that exercise the agent's changed symbols, then mutate each one to see if those tests notice. */
export async function verifyClaim(g: LoomGraph, o: { agent: string; task: string; worktree?: string; cfg: TestCfg | null; mutate?: boolean; evidence?: string }): Promise<ClaimResult> {
  const { agent, task } = o;
  const syms = await g.query<{ id: string; file: string }>(`MATCH (c:Change {agent: $agent})-[:OF]->(s:Symbol)
    WHERE c.kind IN ['contract', 'behavior'] RETURN DISTINCT s.id AS id, s.file AS file ORDER BY id`, { agent });
  let r: ClaimResult = { task, state: 'UNKNOWN', strength: null, blindSpots: [], labels: [] };
  let run: { ok: boolean; tail: string } | null = null;
  const cover: { sid: string; bodyHash: string; strength: number | null }[] = [];
  if (!o.worktree) r.missing = 'agent has no worktree';
  else if (!o.cfg) r.missing = 'no test command: add "test" to .loom/config.json';
  else if (!syms.length) r.missing = 'no changed symbols to verify';
  else {
    const wt = o.worktree; const cfg = o.cfg;
    const map = await mapTests(wt, syms.map((s) => s.id), cfg);
    await writeExercises(g, map);
    const unmapped = syms.filter((s) => !map.get(s.id)?.length).map((s) => short(s.id));
    const labels = [...new Set([...map.values()].flat().map((t) => t.label))];
    r.labels = labels;
    if (!labels.length) r.missing = `no test exercises ${unmapped.join(', ')}`;
    else {
      const t0 = Date.now();
      run = await runTests(wt, cfg, labels);
      // a mutant on a loop guard can spin forever: give each at most 3× the baseline (≥ 10 s); a timeout counts as killed
      const mcfg = { ...cfg, timeoutS: Math.min(cfg.timeoutS ?? 300, Math.max(10, Math.ceil((3 * (Date.now() - t0)) / 1000))) };
      const hashes = new Map<string, string>();
      for (const f of new Set(syms.map((s) => s.file))) {
        if (!existsSync(join(wt, f))) continue;
        for (const s of (await indexPython(f, readFileSync(join(wt, f), 'utf8'))).symbols) hashes.set(s.id, s.bodyHash);
      }
      const mapped = syms.filter((s) => map.get(s.id)?.length);
      if (!run.ok) {
        const failing = labels.length === 1 ? labels : [];
        for (const l of labels.length > 1 ? labels.slice(0, MAX_SPLIT) : []) if (!(await runTests(wt, cfg, [l])).ok) failing.push(l);
        r = { ...r, state: 'FAIL', failing: failing.length ? failing : labels, missing: `tests failing: ${(failing.length ? failing : labels).join(' ')}` };
        for (const s of mapped) cover.push({ sid: s.id, bodyHash: hashes.get(s.id) ?? '', strength: null });
      } else {
        let killed = 0; let applied = 0; let budget = MAX_MUTANT_RUNS;
        const scratch = o.mutate === false ? null : scratchOf(wt);
        try {
          for (const s of mapped) {
            let k = 0; let a = 0;
            if (scratch && existsSync(join(wt, s.file))) {
              const src = readFileSync(join(wt, s.file), 'utf8');
              const rec = (await indexPython(s.file, src)).symbols.find((x) => x.id === s.id);
              const ls = [...new Set(map.get(s.id)!.map((t) => t.label))];
              for (const m of rec ? await mutants(src, rec) : []) {
                if (budget-- <= 0) break;
                writeFileSync(join(scratch.dir, s.file), applyMutant(src, m));
                a++; if (!(await runTests(scratch.dir, mcfg, ls)).ok) k++;
              }
              writeFileSync(join(scratch.dir, s.file), src);
            }
            killed += k; applied += a;
            if (a > 0 && k === 0) r.blindSpots.push(s.id);
            cover.push({ sid: s.id, bodyHash: hashes.get(s.id) ?? '', strength: a ? k / a : null });
          }
        } finally { scratch?.done(); }
        r.strength = applied ? killed / applied : null;
        if (unmapped.length) r.missing = `no test exercises ${unmapped.join(', ')}`;
        else r.state = 'VERIFIED';
      }
    }
  }
  const t = Date.now();
  await g.query(`MERGE (c:Claim {task: $task, agent: $agent})
    SET c.state = $state, c.strength = $strength, c.blindSpots = $blind, c.missing = $missing, c.labels = $labels, c.evidence = $evidence, c.at = $t
    WITH c OPTIONAL MATCH (t:Task {id: $task}) FOREACH (_ IN CASE WHEN t IS NULL THEN [] ELSE [1] END | MERGE (c)-[:CLAIMS]->(t))`,
  { task, agent, state: r.state, strength: r.strength, blind: r.blindSpots, missing: r.missing ?? null, labels: r.labels, evidence: o.evidence ?? '', t });
  if (run) {
    let commit = '';
    try { commit = git(o.worktree!, 'rev-parse', 'HEAD'); } catch { /* not a repo */ }
    await g.query(`MATCH (c:Claim {task: $task, agent: $agent})
      CREATE (r:TestRun {id: $id, commit: $commit, result: $result, at: $t, labels: $labels, tail: $tail, stale: false, agent: $agent})-[:SUPPORTS]->(c)
      WITH r UNWIND $cover AS v MATCH (s:Symbol {id: v.sid}) CREATE (r)-[e:COVERS {bodyHash: v.bodyHash}]->(s) SET e.strength = v.strength`,
    { task, agent, id: `TR:${agent}:${t}`, commit, result: run.ok ? 'pass' : 'fail', t, labels: r.labels, tail: run.tail.slice(-TAIL), cover });
  }
  return r;
}

/** Spec §5.6 rule 3: what is missing from a claim, or null when its evidence stands. A repo with no test command is not the agent's to fix. */
/** Gaps on Loom's side, not the agent's: blocking Stop on them only burns turns. */
const LOOM_SIDE = ['no test command', 'agent has no worktree', 'no changed symbols to verify'];

export function claimGap(c: { state: string; strength: number | null; blindSpots: string[] | null; missing: string | null }): string | null {
  if (c.state !== 'VERIFIED') return LOOM_SIDE.some((g) => c.missing?.startsWith(g)) ? null : c.missing ?? c.state;
  const blind = c.blindSpots ?? [];
  if (blind.length) return `blind spot: tests still pass when ${blind.map(short).join(', ')} is mutated. Add an assertion on its result.`;
  if (c.strength === 0) return 'blind spot: no mutant of the change made a test fail. Add an assertion on its result.';
  return null;
}
