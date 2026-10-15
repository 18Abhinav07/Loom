// P3 Task 5: `loom run --plan` spawn mode — worktrees, hub pre-grant, commit on exit, wake/resume, merge (plan 03 Task 5).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { startServer } from '../../daemon/src/server.js';
import { mergeCheck } from '../../daemon/src/mergecheck.js';
import { exitCode, runPlan, type RunReport } from '../src/run.js';
import type { Plan } from '@loom/planner';

const ROOT = resolve(__dirname, '..', '..', '..');
const FAKE = join(__dirname, 'fake-claude.mjs');
const M = 'pkg/m.py';
const SRC = 'def f(x):\n    return x\n\n\ndef g():\n    return f(1)\n\n\ndef h(y):\n    return y\n';
let db: LoomDb; let srv: Awaited<ReturnType<typeof startServer>>; let url: string;
const runs: string[] = [];
const log = mkdtempSync(join(tmpdir(), 'loom-fake-'));
process.env.FAKE_LOG = log;

beforeAll(async () => {
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: null, recordDir: mkdtempSync(join(tmpdir(), 'loom-rec-')) });
  url = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  for (const r of runs) { await db.graph(r).drop().catch(() => {}); await db.graph(`trace:${r}`).drop().catch(() => {}); }
  await db.close();
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-run-'));
  mkdirSync(join(d, dirname(M)), { recursive: true }); writeFileSync(join(d, M), SRC);
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'base');
  return d;
}
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const task = (id: string, scope: string, fake: Record<string, unknown>) =>
  ({ id, title: `task ${id}`, prompt: `do ${id}\nFAKE: ${JSON.stringify(fake)}`, scope: [`${M}::${scope}`] });
async function go(r: string, plan: Plan, blind = false): Promise<RunReport> {
  const run = `test:run:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`; runs.push(run);
  return runPlan({ repo: r, plan, run, url, claudeBin: FAKE, blind,
    hookCmd: `node ${join(ROOT, 'packages/hook/dist/loom-hook.cjs')}`, mcpPath: join(ROOT, 'packages/mcp/dist/loom-mcp.cjs'), pollMs: 200 });
}
const worker = (rep: RunReport, a: string) => rep.workers.find((w) => w.agent === a)!;

test('5.1 two tasks on different functions: two commits, clean merge, tests pass', async () => {
  const r = repo();
  const rep = await go(r, { test: `python3 -c "import pkg.m"`, tasks: [
    task('t1', 'f', { edit: [M, '    return x\n', '    return x + 0\n'] }),
    task('t2', 'h', { edit: [M, '    return y\n', '    return y * 1\n'] })] });
  expect(rep.workers.map((w) => [w.agent, w.exit, Boolean(w.commit)])).toEqual([['t1', 0, true], ['t2', 0, true]]);
  expect(rep.merge).toMatchObject({ conflict: null, testsPassed: true });
  const merged = git(r, 'log', '--format=%H%n%B', rep.merge.branch);
  for (const w of rep.workers) expect(merged).toContain(w.commit);
  expect(merged.match(/Loom-Run: /g)).toHaveLength(2);
  expect(readFileSync(join(r, '.loom/wt', rep.run.replace(/[^\w-]/g, '').slice(-8), '_merge', M), 'utf8')).toMatch(/x \+ 0[\s\S]*y \* 1/);
  expect(exitCode(rep)).toBe(0);
  // a second run on the same repo gets its own worktrees
  expect(exitCode(await go(r, { tasks: [task('t1', 'f', {})] }))).toBe(0);
});

test('5.2 the hub owner owns the hub: the other task\'s edit to its body is denied, then retried on the owner\'s merged code', async () => {
  const r = repo();
  const retry = { edit: [M, '    return x\n', '    return x or 0\n'] };
  const rep = await go(r, { tasks: [
    task('t1', 'f', { sleep: 1500, edit: [M, 'def f(x):', 'def f(x, strict=False):'] }),
    task('t2', 'g', { ...retry, resumes: [retry] })] });
  expect(worker(rep, 't1').commit).toBeTruthy();
  const out = readFileSync(join(r, '.loom/runs', rep.run.replace(/[^\w.-]+/g, '_'), 't2.jsonl'), 'utf8');
  expect(out).toContain('leased by agent t1');
  expect(out).toContain('finish now');
  // the denial is a wait: t2 is resumed when t1 lands, with t1's commit merged into its checkout, and its retry lands
  expect(worker(rep, 't2')).toMatchObject({ exit: 0, resumed: 1 });
  expect(git(r, 'show', `${worker(rep, 't2').commit}:${M}`)).toMatch(/def f\(x, strict=False\):\n    return x or 0/);
  expect(rep.merge.conflict).toBeNull();
  // --blind: the same plan with no Loom at all — no hooks, no MCP, no leases, no daemon run; agents still told they work in parallel
  const b = await go(r, { tasks: [
    task('t1', 'f', { sleep: 300, edit: [M, 'def f(x):', 'def f(x, strict=False):'] }),
    task('t2', 'g', { edit: [M, '    return x\n', '    return x or 0\n'] })] }, true);
  expect(b.workers.map((w) => [w.agent, w.exit, Boolean(w.commit)])).toEqual([['t1', 0, true], ['t2', 0, true]]);
  const args = readFileSync(join(log, 't2.args'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).pop()!;
  expect(args).not.toContain('--mcp-config');
  expect(args[args.indexOf('-p') + 1]).toMatch(/several agents working in parallel/);
  expect(args.join(' ')).not.toMatch(/loom/i);
  const wt2 = join(r, '.loom/wt', b.run.replace(/[^\w-]/g, '').slice(-8), 't2');
  expect([existsSync(join(wt2, '.claude/settings.local.json')), existsSync(join(wt2, '.loom-mcp.json'))]).toEqual([false, false]);
});

test('5.3 a worker that fails keeps its commit, frees its leases, and fails the run', async () => {
  const r = repo();
  const rep = await go(r, { tasks: [task('t1', 'f', { edit: [M, '    return x\n', '    return x - 0\n'], exit: 3 })] });
  expect(worker(rep, 't1')).toMatchObject({ exit: 3 });
  expect(worker(rep, 't1').commit).toBeTruthy();
  expect((await (await fetch(`${url}/status?run=${encodeURIComponent(rep.run)}`)).json()).leases).toEqual([]);
  expect(exitCode(rep)).toBe(1);
});

test('5.4 a stopped worker is resumed when the holder lands, again along a chain of holders', async () => {
  const r = repo();
  const rep = await go(r, { tasks: [
    task('t1', 'f', { sleep: 1500, edit: [M, 'def f(x):', 'def f(x, strict=False):'] }),
    task('t2', 'g', { read: M, stop: true })] });
  expect(worker(rep, 't2').resumed).toBe(1);
  const calls = readFileSync(join(log, 't2.args'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
  const again = calls.find((a) => a.includes('--resume'))!;
  expect(again[again.indexOf('--resume') + 1]).toBe('fake-t2');
  expect(again[again.indexOf('-p') + 1]).toContain('has landed');
  // workers are told notices come by themselves; no bookkeeping tool calls are asked of them
  const first = calls.filter((a) => !a.includes('--resume')).pop()!;
  expect(first[first.indexOf('-p') + 1]).toMatch(/arrive on their own/);
  expect(first[first.indexOf('-p') + 1]).not.toMatch(/record_decision|ack_notice/);
  // t3 waits on t1 (f), then on t2 (h): two resumes, each on a checkout carrying what has landed so far
  const c = repo();
  const chain = await go(c, { tasks: [
    task('t1', 'f', { sleep: 1500, edit: [M, 'def f(x):', 'def f(x, strict=False):'] }),
    task('t2', 'h', { edit: [M, '    return y\n', '    return y * 1\n'], hold: 3500 }),
    task('t3', 'g', { edit: [M, '    return x\n', '    return x or 0\n'], resumes: [
      { edits: [[M, '    return x\n', '    return x or 0\n'], [M, 'def h(y):', 'def h(y, z=0):']] },
      { edit: [M, 'def h(y):', 'def h(y, z=0):'] }] })] });
  expect(worker(chain, 't3')).toMatchObject({ exit: 0, resumed: 2 });
  expect(chain.merge.conflict).toBeNull();
  const merged = readFileSync(join(c, '.loom/wt', chain.run.replace(/[^\w-]/g, '').slice(-8), '_merge', M), 'utf8');
  expect(merged).toMatch(/def f\(x, strict=False\):\n    return x or 0[\s\S]*def h\(y, z=0\):\n    return y \* 1/);
}, 20_000);

test('5.5 merge-check forks the run graph: a caller added against the old contract is predicted and confirmed by its test', async () => {
  const T = 'tests/test_m.py';
  const TS = 'import unittest\nfrom pkg import m\n\n\nclass T(unittest.TestCase):\n    def test_h(self):\n        self.assertEqual(m.h(2), 2)\n';
  const cfg = { command: 'cd tests && PYTHONPATH=.. python3 -m unittest {labels}', label: '{module_dotted}.{Class}.{method}', root: 'tests' };
  const pair = async (call: string) => {
    const r = repo();
    mkdirSync(join(r, 'tests')); writeFileSync(join(r, T), TS);
    git(r, 'add', '-A'); git(r, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tests');
    const rep = await go(r, { tasks: [
      task('t1', 'f', { edits: [[M, 'def f(x):', 'def f(x, *, strict):'], [M, 'return f(1)', 'return f(1, strict=False)']] }),
      task('t2', 'h', { edits: [[M, 'def h(y):', `def g2():\n    return ${call}\n\n\ndef h(y):`],
        [T, '    def test_h(self):', '    def test_g2(self):\n        self.assertEqual(m.g2(), 1)\n\n    def test_h(self):']] })] });
    expect(rep.workers.map((w) => Boolean(w.commit))).toEqual([true, true]);
    git(r, 'branch', 'side', rep.workers[1].commit!);
    return { mc: await mergeCheck(db, rep.run, 't1', 't2', { repo: r, cfg }), side: () => mergeCheck(db, rep.run, 't1', 'side', { repo: r, cfg }),
      none: () => mergeCheck(db, rep.run, 't1', git(r, 'merge-base', rep.workers[0].commit!, rep.workers[1].commit!).trim(), { repo: r, cfg }) };
  };
  const { mc: bad, side, none } = await pair('f(1)');
  expect(await none()).toMatchObject({ nothing: expect.stringContaining('no commits since') });   // b at the merge base: nothing to check, no fork
  await expect(mergeCheck(db, 'r', 't1', 'nosuch-ref', { repo: repo(), cfg })).rejects.toThrow(/neither an agent .* nor a git ref/);
  expect(bad).toMatchObject({ textual: null, failing: ['test_m.T.test_g2'], confirmed: 1, falsePositives: 0, misses: 0 });
  expect(await side()).toMatchObject({ confirmed: 1, falsePositives: 0, misses: 0 });   // b may be any git ref, not only an agent
  expect(bad.predicted.map((p) => `${p.caller.split('::')[1]}->${p.callee.split('::')[1]}:${p.by}`)).toEqual(['g2->f:t2']);
  const { mc: good } = await pair('f(1, strict=False)');
  expect(good).toMatchObject({ predicted: [], failing: [], confirmed: 0, falsePositives: 0, misses: 0 });
  expect((await db.list()).filter((n) => n.startsWith('fork:'))).toEqual([]);
}, 60_000);
