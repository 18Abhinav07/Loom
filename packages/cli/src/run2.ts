// P3 Task 7, the v2 `loom run`: one headless claude per task in its own worktree; each lands through the daemon's merge queue onto
// the run's landed branch as soon as it stops (R6.1). A stopped worker is resumed when a wake reaches it, or with the reason its work
// could not land. The run's result is the landed branch itself; nothing is merged at the end.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { handover } from '@loom/daemon';
import type { PlanTask } from '@loom/planner';
import { exclude, mergeHooks, pyDirs } from './loom.js';
import { MAX_RESUMES, spawnClaude, SUFFIX, type RunOpts, type RunReport, type WorkerReport } from './run.js';

type Status = 'landed' | 'empty' | 'conflict' | 'tests_failed' | 'contract_break';
interface Worker { t: PlanTask; wt: string; branch: string; rep: WorkerReport; running: boolean; status: Status | null; tail: string }

/** Computed at call time: run.ts and this module import each other through loom.ts. */
const suffix2 = () => SUFFIX.replace('Loom commits your work when you finish.',
  'Loom commits your work and lands it on the shared branch when you finish; if it cannot land, you are resumed with the reason.');

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** POST with no client timeout: a landing runs the tests, which can outlast fetch's 300 s header timeout. */
function post(url: string, path: string, body: unknown): Promise<any> {
  return new Promise((ok, fail) => {
    const req = request(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let j: any; try { j = JSON.parse(s); } catch { j = { error: s }; }
        if ((res.statusCode ?? 500) >= 400 || j?.ok === false) fail(new Error(`${path}: ${j?.error ?? res.statusCode}`)); else ok(j);
      });
    });
    req.on('error', fail);
    req.end(JSON.stringify(body));
  });
}

export async function runPlan2(o: RunOpts): Promise<RunReport> {
  const repo = resolve(o.repo);
  const url = o.url ?? 'http://127.0.0.1:4318';
  const run = o.run ?? `loom-${Date.now().toString(36)}`;
  const run8 = run.replace(/[^\w-]/g, '').slice(-8);
  const base = git(repo, 'rev-parse', o.plan.base ?? 'HEAD');
  const cfgPath = join(repo, '.loom', 'config.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  const testCmd: string | null = o.plan.test ?? cfg.test?.command ?? null;
  const runDir = join(repo, '.loom', 'runs', run.replace(/[^\w.-]+/g, '_'));
  mkdirSync(runDir, { recursive: true });
  exclude(repo, ['.loom/']);

  const landed = `loom/${run8}/landed`;
  git(repo, 'branch', landed, base);
  await post(url, '/admin/v2/runs', { run, repo, landed, dirs: cfg.dirs ?? pyDirs(repo), test: testCmd });

  const workers = new Map<string, Worker>();
  for (const t of o.plan.tasks) {
    const wt = join(repo, '.loom', 'wt', run8, t.id); const branch = `loom/${run8}/${t.id}`;
    git(repo, 'worktree', 'add', '-q', wt, '-b', branch, base);
    mergeHooks(join(wt, '.claude', 'settings.local.json'), o.hookCmd);
    writeFileSync(join(wt, '.loom-mcp.json'), JSON.stringify({ mcpServers: { loom: { command: 'node', args: [o.mcpPath],
      env: { LOOM_URL: url, LOOM_RUN: run, LOOM_AGENT: t.id } } } }, null, 2));
    await post(url, '/admin/v2/agents', { run, agent: t.id, worktree: wt, task: t.id, title: t.title, scope: t.scope ?? [] });
    workers.set(t.id, { t, wt, branch, running: false, status: null, tail: '', rep: { agent: t.id, task: t.id, exit: -1, resumed: 0 } });
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;   // the subscription login, never a paid key
  const claude = (w: Worker, prompt: string, resume?: string) => spawnClaude({ id: w.t.id, wt: w.wt, prompt, resume, rep: w.rep, runDir,
    model: o.model, claudeBin: o.claudeBin, env: { ...env, LOOM_RUN: run, LOOM_AGENT: w.t.id, LOOM_URL: url } });

  const queue: (() => Promise<void>)[] = [];
  const launch = (w: Worker, prompt: string, resume?: string) => {
    w.running = true;
    queue.push(async () => { try { await finish(w, await claude(w, prompt, resume)); } finally { w.running = false; } });
  };

  /** The worker stopped: land its work. Work that cannot land goes back to it, on the landed code, with the reason. */
  const finish = async (w: Worker, code: number) => {
    w.rep.exit = code;
    const r: { status: Status; sha: string | null; tail: string } = await post(url, '/admin/v2/land', { run, agent: w.t.id });
    w.status = r.status; w.tail = r.tail;
    if (r.status === 'landed') { w.rep.commit = r.sha!; return; }
    if (r.status === 'empty') return;
    if (w.rep.resumed >= MAX_RESUMES || !w.rep.sessionId) return;
    const h = await handover(w.wt, landed);
    const why = r.status === 'tests_failed'
      ? `[loom] your work did not land: the tests failed after merging it with the landed work. Fix it so the tests pass. Output:\n${r.tail}`
      : r.status === 'contract_break'
        ? `[loom] your work did not land: merged with the landed work, some ${r.tail}\nThe landed work is in your checkout now. Fix every listed call site (or the signature) so they fit, then finish.`
        : `[loom] your work did not land: it conflicts with work another agent landed.`;
    const files = h.status === 'conflict' ? `\nThe landed work is merged into your checkout; resolve the conflict markers in ${h.files.join(', ')}, keeping both changes' intent.` : '';
    w.rep.resumed++;
    launch(w, why + files, w.rep.sessionId);
  };

  /** A stopped worker holding a pending wake is resumed with it, on a checkout that has the landed work. */
  let over = false;
  const handled = new Set<string>();
  const checkWakes = async () => {
    if (over || o.resumeOnce === false) return;
    const ns: { id: string; agent: string; kind?: string; status: string }[] =
      await (await fetch(`${url}/runs/${encodeURIComponent(run)}/notices`)).json().catch(() => []);
    for (const n of ns) {
      const w = workers.get(n.agent);
      if (n.kind !== 'wake' || n.status !== 'pending' || handled.has(n.id) || !w || w.running || w.rep.resumed >= MAX_RESUMES || !w.rep.sessionId) continue;
      handled.add(n.id);
      w.running = true;   // claimed before the awaits below, so a second poll cannot resume it twice
      const { text } = await post(url, '/admin/v2/take', { run, agent: w.t.id });
      const h = await handover(w.wt, landed);
      const clash = h.status === 'conflict' ? `\n\n[loom] the landed work is merged into your checkout; resolve the conflict markers in ${h.files.join(', ')}.` : '';
      w.rep.resumed++;
      launch(w, (text || '[loom] the code you were waiting on has landed; it is in your checkout now. Continue your task.') + clash, w.rep.sessionId);
    }
  };

  for (const w of workers.values()) launch(w, w.t.prompt + suffix2());
  const max = Math.max(1, o.maxParallel ?? workers.size);
  let active = 0;
  await new Promise<void>((allDone) => {
    const pump = () => {
      while (active < max && queue.length) {
        const job = queue.shift()!; active++;
        job().catch((e) => console.error(`[loom] worker failed: ${String(e)}`))
          .then(() => checkWakes().catch(() => {}))
          .finally(() => { active--; pump(); });
      }
      if (!active && !queue.length) { over = true; clearInterval(timer); allDone(); }
    };
    const timer = setInterval(() => void checkWakes().catch(() => {}).then(pump), o.pollMs ?? 5000);
    pump();
  });

  // The run's result is the landed branch; work that never landed is reported, not merged in.
  const mwt = join(repo, '.loom', 'wt', run8, '_merge');
  git(repo, 'worktree', 'add', '-q', '--detach', mwt, landed);
  const lost = [...workers.values()].filter((w) => w.status === 'conflict' || w.status === 'tests_failed' || w.status === 'contract_break');
  const conflict = lost.length ? lost.map((w) => `${w.branch}: not landed (${w.status})`).join('; ') : null;
  let testsPassed: boolean | null = null; let testOutputTail = '';
  if (testCmd) {
    const r = spawnSync('sh', ['-c', testCmd], { cwd: mwt, encoding: 'utf8', env, maxBuffer: 1 << 28 });
    testsPassed = r.status === 0;
    testOutputTail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-40).join('\n');
  }
  return { run, workers: [...workers.values()].map((w) => w.rep), merge: { branch: landed, conflict, testsPassed, testOutputTail } };
}
