// Spec §5.11 merge-check: fork the run graph (GRAPH.COPY), lay both agents' commits onto the fork, ask Cypher which
// new calls cross the other agent's changed contracts, then merge for real and run the tests to score the prediction.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChangeRec, FileIndex, LoomDb, LoomGraph, ParamSpec } from '@loom/core';
import { callSatisfies, diffFile, indexPython } from '@loom/indexer';
import type { Lessons } from './lessons.js';
import { mapTests, runTests, writeExercises, type TestCfg } from './verify.js';

export interface Prediction { caller: string; callee: string; by: string; reason: string; path: string[] }
export interface MergeCheck {
  commits: { a: string; b: string }; textual: string | null;
  predicted: Prediction[]; atRisk: { caller: string; callee: string; reason: string }[];
  failing: string[]; confirmed: number; falsePositives: number; misses: number;
  /** Set when one side has no commits since the merge base: there is no merge to check. */
  nothing?: string;
}

const MAX_LABELS = 60;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const name = (sid: string) => sid.slice(sid.indexOf('::') + 2);

/** The agent's commit: HEAD of its worktree, else its `loom run` branch, else `agent` read as a plain git ref. */
async function commitOf(g: LoomGraph, repo: string, run: string, agent: string): Promise<string> {
  const [a] = await g.query<{ wt: string | null }>(`MATCH (a:Agent {id: $agent}) RETURN a.worktree AS wt`, { agent });
  if (a?.wt && existsSync(a.wt)) { try { return git(a.wt, 'rev-parse', 'HEAD'); } catch { /* fall through */ } }
  try { return git(repo, 'rev-parse', '--verify', '-q', `loom/${run.replace(/[^\w-]/g, '').slice(-8)}/${agent}^{commit}`); }
  catch { /* not an agent branch: try a plain git ref */ }
  try { return git(repo, 'rev-parse', '--verify', '-q', `${agent}^{commit}`); }
  catch { throw new UnknownSide(`${agent} is neither an agent of run ${run} nor a git ref`); }
}

export class UnknownSide extends Error {}

/** What one commit changed since the merge base, symbol by symbol, with the new file indexes for its calls. */
async function changesOf(repo: string, base: string, sha: string): Promise<{ changes: ChangeRec[]; after: FileIndex[] }> {
  const show = (rev: string, f: string) => { try { return git(repo, 'show', `${rev}:${f}`); } catch { return null; } };
  const changes: ChangeRec[] = []; const after: FileIndex[] = [];
  for (const f of git(repo, 'diff', '--name-only', base, sha, '--', '*.py').split('\n').filter(Boolean)) {
    const a = show(base, f); const b = show(sha, f);
    const prev = a === null ? undefined : await indexPython(f, a);
    const next = b === null ? undefined : await indexPython(f, b);
    changes.push(...diffFile(prev, next));
    if (next) after.push(next);
  }
  return { changes, after };
}

/** Lay one agent's commit onto the fork: new signatures, removals, and its own call edges tagged `by`. */
async function materialise(fork: LoomGraph, agent: string, c: { changes: ChangeRec[]; after: FileIndex[] }) {
  const sym = (s: ChangeRec['symbol']) => ({ id: s.id, file: s.file, name: s.name, qname: s.qname, sig: s.sig });
  await fork.query(`UNWIND $rows AS r MERGE (s:Symbol {id: r.id}) ON CREATE SET s.file = r.file, s.name = r.name, s.qname = r.qname
    SET s.sig = r.sig, s.removed = r.removed`, { rows: c.changes.map((ch) => ({ ...sym(ch.after ?? ch.symbol), id: ch.symbol.id, removed: ch.kind === 'removed' })) });
  await fork.query(`UNWIND $rows AS r MATCH (s:Symbol {id: r.sid})
    CREATE (:Change {mc: true, agent: $agent, kind: r.kind, symbol: r.sid, sig: r.sig, params: r.params})-[:OF]->(s)`,
  { agent, rows: c.changes.filter((ch) => ch.kind !== 'added').map((ch) => ({
    sid: ch.symbol.id, kind: ch.kind, sig: ch.after?.sig ?? '', params: JSON.stringify(ch.after?.params ?? null) })) });
  const mine = new Set(c.changes.filter((ch) => ch.kind !== 'removed').map((ch) => ch.symbol.id));
  const rows = c.after.flatMap((i) => i.calls).filter((k) => mine.has(k.from)).flatMap((k) => k.to.slice(0, 1).map((to) => ({
    from: k.from, to, argc: k.argc, kwargs: k.kwargs, star: k.star, dstar: k.dstar, method: k.method })));
  await fork.query(`UNWIND $rows AS r MATCH (a:Symbol {id: r.from}), (b:Symbol {id: r.to})
    MERGE (a)-[e:CALLS {by: $agent}]->(b) SET e.argc = r.argc, e.kwargs = r.kwargs, e.star = r.star, e.dstar = r.dstar, e.method = r.method`, { agent, rows });
}

export async function mergeCheck(db: LoomDb, run: string, a: string, b: string,
  o: { repo: string; cfg: TestCfg | null; lessons?: Lessons }): Promise<MergeCheck> {
  const g = db.graph(run);
  const ca = await commitOf(g, o.repo, run, a); const cb = await commitOf(g, o.repo, run, b);
  const base = git(o.repo, 'merge-base', ca, cb);
  const out: MergeCheck = { commits: { a: ca, b: cb }, textual: null, predicted: [], atRisk: [], failing: [], confirmed: 0, falsePositives: 0, misses: 0 };
  const idle = ca === base ? a : cb === base ? b : null;
  if (idle) return { ...out, nothing: `${idle} has no commits since ${base.slice(0, 8)}` };
  const fork = db.graph(`fork:${run}:${Date.now()}`);
  const mwt = join(o.repo, '.loom', 'wt', run.replace(/[^\w-]/g, '').slice(-8), '_mc');
  const ch = { [a]: await changesOf(o.repo, base, ca), [b]: await changesOf(o.repo, base, cb) };
  try {
    await g.copy(fork.name);
    await materialise(fork, a, ch[a]); await materialise(fork, b, ch[b]);
    const rows = await fork.query<{ caller: string; callee: string; by: string; changer: string; kind: string; sig: string; params: string;
      argc: number; kwargs: string[]; star: boolean; dstar: boolean; method: boolean }>(
      `MATCH (caller:Symbol)-[e:CALLS]->(callee:Symbol)<-[:OF]-(c:Change {mc: true})
       WHERE e.by IS NOT NULL AND e.by <> c.agent
       RETURN caller.id AS caller, callee.id AS callee, e.by AS by, c.agent AS changer, c.kind AS kind, c.sig AS sig, c.params AS params,
         e.argc AS argc, e.kwargs AS kwargs, coalesce(e.star, false) AS star, coalesce(e.dstar, false) AS dstar, coalesce(e.method, false) AS method
       ORDER BY caller, callee`);
    for (const r of rows) {
      const call = `${name(r.callee).split('.').pop()}(${r.argc} positional${r.kwargs?.length ? `, ${r.kwargs.join(', ')}=` : ''})`;
      if (r.kind === 'behavior') { out.atRisk.push({ caller: r.caller, callee: r.callee, reason: `${r.changer} changed the body of ${name(r.callee)}` }); continue; }
      const ok = r.kind === 'removed' ? false
        : callSatisfies({ argc: r.argc, kwargs: r.kwargs ?? [], star: r.star, dstar: r.dstar, method: r.method }, JSON.parse(r.params) as ParamSpec);
      const reason = r.kind === 'removed' ? `${r.by} calls ${name(r.callee)}, which ${r.changer} removed`
        : `${r.by} calls ${call} but ${r.changer} changed it to \`${r.sig}\``;
      if (ok === false) out.predicted.push({ caller: r.caller, callee: r.callee, by: r.by, reason, path: [r.caller, r.callee] });
      else if (ok === 'unknown') out.atRisk.push({ caller: r.caller, callee: r.callee, reason });
    }

    // Actual: merge both commits for real and run the tests that exercise anything either agent changed.
    if (existsSync(mwt)) { try { git(o.repo, 'worktree', 'remove', '--force', mwt); } catch { /* stale */ } }
    mkdirSync(dirname(mwt), { recursive: true });
    git(o.repo, 'worktree', 'add', '-q', '--detach', mwt, base);
    const who = ['-c', 'user.email=loom@localhost', '-c', 'user.name=loom'];
    for (const sha of [ca, cb]) {
      try { git(mwt, ...who, 'merge', '--no-ff', '--no-edit', sha); } catch {
        out.textual = git(mwt, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean).join(', ') || 'merge failed';
        return out;
      }
    }
    if (!o.cfg) return out;
    const sids = [...new Set([...ch[a].changes, ...ch[b].changes].filter((c) => c.kind !== 'removed').map((c) => c.symbol.id))];
    const map = await mapTests(mwt, sids, o.cfg);
    await writeExercises(g, map);
    const bySym = new Map<string, Set<string>>();                         // label -> symbols it exercises
    for (const [sid, ts] of map) for (const t of ts) bySym.set(t.label, (bySym.get(t.label) ?? new Set()).add(sid));
    for (const label of [...bySym.keys()].sort().slice(0, MAX_LABELS)) if (!(await runTests(mwt, o.cfg, [label])).ok) out.failing.push(label);

    const hit = (p: Prediction, label: string) => bySym.get(label)!.has(p.caller) || bySym.get(label)!.has(p.callee);
    for (const p of out.predicted) {
      const label = out.failing.find((l) => hit(p, l));
      if (!label) { out.falsePositives++; continue; }
      out.confirmed++;
      await o.lessons?.record('T2', [p.callee, p.caller],
        `${name(p.caller)} and ${name(p.callee)} were changed in parallel by different agents and broke: ${label}.`, run);
    }
    out.misses = out.failing.filter((l) => !out.predicted.some((p) => hit(p, l))).length;
    return out;
  } finally {
    await fork.drop().catch(() => {});
    if (existsSync(mwt)) { try { git(o.repo, 'worktree', 'remove', '--force', mwt); } catch { /* best effort */ } }
  }
}
