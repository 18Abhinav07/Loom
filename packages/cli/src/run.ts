// loom run --plan: one headless claude per task in its own worktree, stopped workers resumed on wake, branches merged in plan order.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plan, PlanTask } from '@loom/planner';
import { exclude, mergeHooks, pyDirs } from './loom.js';

export interface RunOpts {
  repo: string; plan: Plan; run?: string; model?: string; claudeBin?: string; url?: string; maxParallel?: number; resumeOnce?: boolean;
  hookCmd: string; mcpPath: string; pollMs?: number;
  /** The no-Loom baseline: same worktrees, prompts, parallel launch and merge; no hooks, MCP, leases, wakes or daemon calls. */
  blind?: boolean;
}
export interface WorkerReport { agent: string; task: string; exit: number; sessionId?: string; resumed: number; commit?: string; lands?: string[] }
export interface RunReport {
  run: string; workers: WorkerReport[];
  merge: { branch: string; conflict: string | null; testsPassed: boolean | null; testOutputTail: string };
}

export const SUFFIX = "\n\nYou are one of several agents working in parallel on this repo, coordinated by Loom. [loom] notices about other "
  + "agents' changes arrive on their own in your context and clear once your code fits them; you need no tool call to fetch or "
  + 'acknowledge them. If Loom denies an edit, follow its message. Do not commit; Loom commits your work when you finish.';
// Blind agents still know they are not alone; they just have no channel to the others.
export const SUFFIX_BLIND = "\n\nYou are one of several agents working in parallel on this repo; other agents may be changing shared code at the "
  + 'same time, and all changes will be merged together when everyone finishes. Do not commit; your work is committed when you finish.';
const TOOLS = ['Edit', 'Write', 'MultiEdit', 'Read', 'Grep', 'Glob', 'Bash(git:*)', 'Bash(python:*)', 'mcp__loom__*'];
const KEEP_OUT = ['.', ':!.claude', ':!.loom-mcp.json'];
/** A worker waiting along a chain of holders (A, then B, then C) is resumed once per landing. */
export const MAX_RESUMES = 3;

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** 0 only when every worker exited 0, the merge was clean, and the tests (if any) passed. */
export function exitCode(r: RunReport): number {
  return r.workers.every((w) => w.exit === 0) && !r.merge.conflict && r.merge.testsPassed !== false ? 0 : 1;
}

export interface SpawnOpts { id: string; wt: string; prompt: string; resume?: string; rep: WorkerReport; runDir: string;
  model?: string; claudeBin?: string; env: NodeJS.ProcessEnv; blind?: boolean }
/** One headless claude in its worktree; stream-json goes to <runDir>/<id>.jsonl and the first session id onto the report. */
export function spawnClaude(s: SpawnOpts): Promise<number> {
  return new Promise<number>((done) => {
    const args = ['-p', s.prompt, ...(s.resume ? ['--resume', s.resume] : []), '--model', s.model ?? 'sonnet', '--output-format', 'stream-json',
      '--verbose', '--setting-sources', 'project,local', ...(s.blind ? [] : ['--mcp-config', join(s.wt, '.loom-mcp.json')]),
      '--permission-mode', 'acceptEdits', '--allowedTools', ...(s.blind ? TOOLS.filter((t) => !t.startsWith('mcp__')) : TOOLS)];
    const bin = s.claudeBin?.includes('/') ? resolve(s.claudeBin) : s.claudeBin ?? 'claude';   // workers run in their worktree
    const p = spawn(bin, args, { cwd: s.wt, stdio: ['ignore', 'pipe', 'pipe'], env: s.env });
    const out = createWriteStream(join(s.runDir, `${s.id}.jsonl`), { flags: 'a' });
    const err = createWriteStream(join(s.runDir, `${s.id}.err`), { flags: 'a' });
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      out.write(d);
      if (s.rep.sessionId) return;
      buf += d.toString();
      for (const line of buf.split('\n').slice(0, -1)) {
        try { const j = JSON.parse(line); if (j.type === 'system' && j.subtype === 'init' && j.session_id) { s.rep.sessionId = j.session_id; break; } } catch { /* partial or non-JSON line */ }
      }
    });
    p.stderr.pipe(err);
    p.on('error', (e) => { err.write(`spawn failed: ${String(e)}\n`); });
    p.on('close', (code) => { out.end(); err.end(); done(code ?? 1); });
  });
}

interface Worker { t: PlanTask; wt: string; branch: string; rep: WorkerReport; running: boolean }

export async function runPlan(o: RunOpts): Promise<RunReport> {
  const repo = resolve(o.repo);
  const url = o.url ?? 'http://127.0.0.1:4318';
  const run = o.run ?? `loom-${Date.now().toString(36)}`;
  const run8 = run.replace(/[^\w-]/g, '').slice(-8);
  const base = git(repo, 'rev-parse', o.plan.base ?? 'HEAD');
  const cfgPath = join(repo, '.loom', 'config.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  // commits need an identity; a fresh machine or CI checkout may not have one
  const who = spawnSync('git', ['config', 'user.email'], { cwd: repo }).status === 0 ? [] : ['-c', 'user.name=Loom', '-c', 'user.email=loom@localhost'];
  const runDir = join(repo, '.loom', 'runs', run.replace(/[^\w.-]+/g, '_'));
  mkdirSync(runDir, { recursive: true });
  exclude(repo, ['.loom/']);

  const post = async (path: string, body: unknown, agent?: string) => {
    if (o.blind) return { hubs: [], hubOwner: {} };   // no daemon in the baseline
    const r = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(agent ? { 'x-loom-agent': agent, 'x-loom-run': run } : {}) } });
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(`${path}: ${j.error ?? r.status}`);
    return j;
  };
  await post('/admin/runs', { run, root: repo, dirs: cfg.dirs ?? pyDirs(repo), baseKey: `${repo}@${base}` });
  const plan = await post('/plan', { run, cwd: repo, plan: o.plan });

  const workers = new Map<string, Worker>();
  for (const t of o.plan.tasks) {
    const wt = join(repo, '.loom', 'wt', run8, t.id); const branch = `loom/${run8}/${t.id}`;
    git(repo, 'worktree', 'add', '-q', wt, '-b', branch, base);
    if (!o.blind) mergeHooks(join(wt, '.claude', 'settings.local.json'), o.hookCmd);
    if (!o.blind) writeFileSync(join(wt, '.loom-mcp.json'), JSON.stringify({ mcpServers: { loom: { command: 'node', args: [o.mcpPath],
      env: { LOOM_URL: url, LOOM_RUN: run, LOOM_AGENT: t.id } } } }, null, 2));
    await post('/admin/agents', { run, agent: t.id, harness: 'claude', worktree: wt });
    await post('/mcp/claim_task', { cwd: wt, args: { id: t.id, title: t.title, prompt: t.prompt } }, t.id);
    // spec §5.7.4: the task that changes a hub owns it — write then contract leaves a sticky write lease flagged contract
    const hubs = plan.hubs.filter((h: string) => plan.hubOwner[h] === t.id);
    for (const mode of hubs.length ? ['write', 'contract'] : []) await post('/mcp/lease', { cwd: wt, args: { symbols: hubs, mode } }, t.id);
    workers.set(t.id, { t, wt, branch, running: false, rep: { agent: t.id, task: t.id, exit: -1, resumed: 0 } });
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;   // the subscription login, never a paid key

  const claude = (w: Worker, prompt: string, resume?: string) => spawnClaude({ id: w.t.id, wt: w.wt, prompt, resume, rep: w.rep, runDir,
    model: o.model, claudeBin: o.claudeBin, env: o.blind ? env : { ...env, LOOM_RUN: run, LOOM_AGENT: w.t.id, LOOM_URL: url }, blind: o.blind });

  /** Spec §5.1: the worker is gone — commit what it left, land it, release its leases (non-zero marks the task failed). */
  const finish = async (w: Worker, code: number) => {
    if (git(w.wt, 'status', '--porcelain', '--', ...KEEP_OUT)) {
      git(w.wt, 'add', '-A', '--', ...KEEP_OUT);
      git(w.wt, ...who, 'commit', '-q', '-m', w.t.title, '-m', `Loom-Run: ${run}`);
      const sha = git(w.wt, 'rev-parse', 'HEAD');
      const files = git(w.wt, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean);
      await post('/admin/landed', { run, agent: w.t.id, sha, files, message: `${w.t.title}\n\nLoom-Run: ${run}` });
      w.rep.commit = sha;
    }
    await post('/admin/exit', { run, agent: w.t.id, code });
    w.rep.exit = code;
  };

  const queue: (() => Promise<void>)[] = [];
  const launch = (w: Worker, prompt: string, resume?: string) => {
    w.running = true;
    queue.push(async () => { try { await finish(w, await claude(w, prompt, resume)); } finally { w.running = false; } });
  };
  for (const w of workers.values()) launch(w, w.t.prompt + (o.blind ? SUFFIX_BLIND : SUFFIX));

  /** Bring what has landed into a stopped worker's checkout, so its resumed edits build on it and merge cleanly later. */
  const sync = (w: Worker): string => {
    const clash: string[] = [];
    for (const o of workers.values()) {
      if (o === w || !o.rep.commit) continue;
      try { git(w.wt, ...who, 'merge', '--no-edit', o.branch); } catch { spawnSync('git', ['merge', '--abort'], { cwd: w.wt }); clash.push(o.t.id); }
    }
    return clash.length ? `\n\n[loom] ${clash.join(', ')}'s landed work conflicts with yours and is not in your checkout; keep your change compatible with it.` : '';
  };

  /** Spec §5.6 spawn mode: an exited worker holding a pending wake notice is resumed with it, on a synced checkout. */
  let over = false;
  const handled = new Set<string>();
  const checkWakes = async () => {
    if (over || o.blind || o.resumeOnce === false) return;
    const ns: { id: string; agent: string; kind?: string; status: string; text: string }[] =
      await (await fetch(`${url}/runs/${encodeURIComponent(run)}/notices`)).json().catch(() => []);
    for (const n of ns) {
      const w = workers.get(n.agent);
      if (n.kind !== 'wake' || n.status !== 'pending' || handled.has(n.id) || !w || w.running || w.rep.resumed >= MAX_RESUMES || !w.rep.sessionId) continue;
      handled.add(n.id);
      w.rep.resumed++;
      launch(w, n.text + sync(w), w.rep.sessionId);
    }
  };

  const max = Math.max(1, o.maxParallel ?? workers.size);
  let active = 0;
  await new Promise<void>((allDone) => {
    const pump = () => {
      while (active < max && queue.length) {
        const job = queue.shift()!; active++;
        job().catch((e) => console.error(`[loom] worker failed: ${String(e)}`))
          .then(() => checkWakes().catch(() => {}))          // look for wakes before this slot counts as free
          .finally(() => { active--; pump(); });
      }
      if (!active && !queue.length) { over = true; clearInterval(timer); allDone(); }
    };
    const timer = setInterval(() => void checkWakes().catch(() => {}).then(pump), o.pollMs ?? 5000);
    pump();
  });

  const mwt = join(repo, '.loom', 'wt', run8, '_merge'); const branch = `loom/${run8}/merged`;
  git(repo, 'worktree', 'add', '-q', mwt, '-b', branch, base);
  let conflict: string | null = null;
  for (const w of workers.values()) {
    try { git(mwt, ...who, 'merge', '--no-ff', '--no-edit', w.branch); } catch {
      conflict = `${w.branch}: ${git(mwt, 'diff', '--name-only', '--diff-filter=U').split('\n').join(', ')}`;
      git(mwt, 'merge', '--abort');
      break;
    }
  }
  const testCmd: string | undefined = o.plan.test ?? cfg.test?.command;
  let testsPassed: boolean | null = null; let testOutputTail = '';
  if (!conflict && testCmd) {
    const r = spawnSync('sh', ['-c', testCmd], { cwd: mwt, encoding: 'utf8', env });
    testsPassed = r.status === 0;
    testOutputTail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-40).join('\n');
  }
  return { run, workers: [...workers.values()].map((w) => w.rep), merge: { branch, conflict, testsPassed, testOutputTail } };
}
