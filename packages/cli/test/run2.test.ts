// P3 Task 7: v2 `loom run` — agents land one at a time onto the run's landed branch through the daemon's merge queue;
// a stopped agent is resumed on a wake, or with the reason its work could not land.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { startServer } from '../../daemon/src/server.js';
import { exitCode, usageLimited, type RunReport } from '../src/run.js';
import { runPlan2 } from '../src/run2.js';
import type { Plan } from '@loom/planner';

const ROOT = resolve(__dirname, '..', '..', '..');
const FAKE = join(__dirname, 'fake-claude.mjs');
const M = 'pkg/m.py';
const SRC = 'def f(x):\n    return x\n\n\ndef g():\n    return f(1)\n\n\ndef h(y):\n    return y\n';
let db: LoomDb; let srv: Awaited<ReturnType<typeof startServer>>; let url: string;
const runs: string[] = [];
const log = mkdtempSync(join(tmpdir(), 'loom-fake2-'));
process.env.FAKE_LOG = log;

beforeAll(async () => {
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: null, recordDir: mkdtempSync(join(tmpdir(), 'loom-rec-')) });
  url = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => {
  await srv.close();
  for (const r of runs) await db.graph(r).drop().catch(() => {});
  await db.close();
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-run2-'));
  mkdirSync(join(d, dirname(M)), { recursive: true }); writeFileSync(join(d, M), SRC);
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'base');
  return d;
}
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const task = (id: string, scope: string, fake: Record<string, unknown>) =>
  ({ id, title: `task ${id}`, prompt: `do ${id}\nFAKE: ${JSON.stringify(fake)}`, scope: [`${M}::${scope}`] });
async function go(r: string, plan: Plan): Promise<RunReport> {
  const run = `t2-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; runs.push(run);
  return runPlan2({ repo: r, plan, run, url, claudeBin: FAKE,
    hookCmd: `node ${join(ROOT, 'packages/hook/dist/loom-hook.cjs')}`, mcpPath: join(ROOT, 'packages/mcp/dist/loom-mcp.cjs'), pollMs: 200 });
}
const worker = (rep: RunReport, a: string) => rep.workers.find((w) => w.agent === a)!;
const merged = (r: string, rep: RunReport) => readFileSync(join(r, '.loom/wt', rep.run.replace(/[^\w-]/g, '').slice(-8), '_merge', M), 'utf8');

test('three tasks on different functions: each lands on the landed branch; _merge is the landed branch; tests pass', async () => {
  const r = repo();
  const rep = await go(r, { test: `python3 -c "import pkg.m"`, tasks: [
    task('a', 'f', { edit: [M, '    return x\n', '    return x + 0\n'] }),
    task('b', 'g', { edit: [M, '    return f(1)\n', '    return f(2)\n'] }),
    task('c', 'h', { edit: [M, '    return y\n', '    return y * 1\n'] })] });
  expect(rep.workers.map((w) => [w.agent, w.exit, Boolean(w.commit)])).toEqual([['a', 0, true], ['b', 0, true], ['c', 0, true]]);
  for (const w of rep.workers) expect(execFileSync('git', ['merge-base', '--is-ancestor', w.commit!, rep.merge.branch], { cwd: r }).length).toBe(0);
  expect(rep.merge).toMatchObject({ conflict: null, testsPassed: true });
  expect(merged(r, rep)).toMatch(/x \+ 0[\s\S]*f\(2\)[\s\S]*y \* 1/);
  expect(git(r, 'ls-tree', '-r', '--name-only', rep.merge.branch).split('\n')).toEqual([M]);   // the run's own files never land
  expect(rep.workers.map((w) => w.resumed)).toEqual([0, 0, 0]);
  expect(exitCode(rep)).toBe(0);
});

test('same function: the second is denied, woken when the first lands, resumed on the landed code, and lands its retry', async () => {
  const r = repo();
  const retry = { edit: [M, '    return x + 1\n', '    return (x + 1) * 2\n'] };
  const rep = await go(r, { tasks: [
    task('a', 'f', { edit: [M, '    return x\n', '    return x + 1\n'], hold: 1500 }),
    task('b', 'f', { sleep: 500, edit: [M, '    return x\n', '    return x * 2\n'], resumes: [retry] })] });
  const out = readFileSync(join(r, '.loom/runs', rep.run.replace(/[^\w.-]+/g, '_'), 'b.jsonl'), 'utf8');
  expect(out).toContain('leased by agent a');
  expect(worker(rep, 'b')).toMatchObject({ exit: 0, resumed: 1 });
  expect(merged(r, rep)).toContain('return (x + 1) * 2');
  expect(rep.merge.conflict).toBeNull();
});

test('work that fails the landing tests does not land; the agent is resumed with the test output and lands its fix', async () => {
  const r = repo();
  const fix = { edit: [M, '    return x + 1\n', '    return x * 1\n'] };
  const rep = await go(r, { test: `python3 -c "import pkg.m as m; assert m.f(1) == 1, 'f-broke-' + str(m.f(1))"`, tasks: [
    task('a', 'f', { edit: [M, '    return x\n', '    return x + 1\n'], resumes: [fix] })] });
  const args = readFileSync(join(log, 'a.args'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(args.at(-1).join(' ')).toContain('f-broke-2');
  expect(worker(rep, 'a')).toMatchObject({ exit: 0, resumed: 1, lands: ['tests_failed', 'landed'] });
  expect(merged(r, rep)).toContain('return x * 1');
  expect(rep.merge).toMatchObject({ conflict: null, testsPassed: true });
});

test('t1 shape: b adds a caller of f while a makes f\'s keyword required; the tests miss it; a lands last, gets contract_break and fixes the caller', async () => {
  const r = repo();
  const fix = { edit: [M, '    return f(y)\n', '    return f(y, strict=False)\n'] };
  const rep = await go(r, { test: `python3 -c "import pkg.m"`, tasks: [
    task('a', 'f', { edits: [[M, 'def f(x):', 'def f(x, *, strict):'], [M, 'return f(1)', 'return f(1, strict=False)']], hold: 1500, resumes: [fix] }),
    task('b', 'h', { edit: [M, 'def h(y):', 'def u(y):\n    return f(y)\n\n\ndef h(y):'] })] });
  const args = readFileSync(join(log, 'a.args'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(args.at(-1).join(' ')).toMatch(/pkg\/m\.py:\d+ u calls f/);
  expect(worker(rep, 'a')).toMatchObject({ exit: 0, resumed: 1, lands: ['contract_break', 'landed'] });
  expect(worker(rep, 'b')).toMatchObject({ exit: 0, resumed: 0, lands: ['landed'] });
  expect(merged(r, rep)).toContain('return f(y, strict=False)');
  expect(rep.merge).toMatchObject({ conflict: null, testsPassed: true });
});

test('x1 r0 shape: c lands a call to k before b has landed k; c is parked, not resumed, and lands when b does', async () => {
  const r = repo();
  const N = 'pkg/n.py';
  writeFileSync(join(r, N), 'from pkg.m import f\n\n\ndef v():\n    return f(1)\n');
  git(r, 'add', N); git(r, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'n');
  const rep = await go(r, { test: `python3 -c "import pkg.m"`, tasks: [
    task('b', 'g', { sleep: 1500, edit: [M, 'def g():', 'def k(z):\n    return z\n\n\ndef g():'] }),
    { ...task('c', 'v', { edits: [[N, 'import f\n', 'import f, k\n'], [N, 'return f(1)', 'return f(1) + k(2)']] }), scope: [`${N}::v`] }] });
  expect(worker(rep, 'c')).toMatchObject({ exit: 0, resumed: 0, lands: ['contract_break', 'landed'] });
  expect(worker(rep, 'b')).toMatchObject({ lands: ['landed'] });
  expect(merged(r, rep)).toContain('def k(z):');
  expect(readFileSync(join(r, '.loom/wt', rep.run.replace(/[^\w-]/g, '').slice(-8), '_merge', N), 'utf8')).toContain('k(2)');
  expect(rep.merge).toMatchObject({ conflict: null, testsPassed: true });
});

test('a parked worker whose callee never lands is resumed with the reason once no one else is running, and the run ends', async () => {
  const r = repo();
  const N = 'pkg/n.py';
  writeFileSync(join(r, N), 'from pkg.m import f\n\n\ndef v():\n    return f(1)\n');
  git(r, 'add', N); git(r, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'n');
  const fix = { edits: [[N, 'import f, k\n', 'import f\n'], [N, 'return f(1) + k(2)', 'return f(1) + 2']] };
  const rep = await go(r, { test: `python3 -c "import pkg.m"`, tasks: [
    task('b', 'g', { sleep: 1500 }),   // b finishes with nothing to land: no landing will ever bring k
    { ...task('c', 'v', { edits: [[N, 'import f\n', 'import f, k\n'], [N, 'return f(1)', 'return f(1) + k(2)']], resumes: [fix] }), scope: [`${N}::v`] }] });
  expect(worker(rep, 'b')).toMatchObject({ lands: ['empty'] });
  expect(worker(rep, 'c')).toMatchObject({ resumed: 1, lands: ['contract_break', 'landed'] });
  const args = readFileSync(join(log, 'c.args'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(args.at(-1).join(' ')).toMatch(/k does not exist in the merged code/);
  expect(rep.merge).toMatchObject({ conflict: null, testsPassed: true });
});

test('usageLimited: only error lines that say the limit was hit', () => {
  expect(usageLimited('{"type":"result","is_error":true,"result":"Claude AI usage limit reached|1792200000"}')).toBe(true);
  expect(usageLimited('{"type":"assistant","error":"rate_limit","message":{"content":[{"type":"text","text":"You\'ve hit your limit · resets 2:30am"}]}}')).toBe(true);
  expect(usageLimited('{"type":"result","is_error":true,"result":"done"}')).toBe(false);
  expect(usageLimited('{"type":"result","is_error":false,"result":"I added a usage limit check"}')).toBe(false);
  expect(usageLimited('not json')).toBe(false);
});

test('a worker that hits the usage limit is paused, not landed or resumed', async () => {
  const r = repo();
  const rep = await go(r, { tasks: [task('a', 'f', { limit: true })] });
  expect(worker(rep, 'a')).toMatchObject({ paused: 'usage limit', resumed: 0, lands: [] });
  expect(exitCode(rep)).toBe(1);
});

test('B2: the test command comes from .loom/config.json testCmd when the plan has none', async () => {
  const r = repo();
  mkdirSync(join(r, '.loom'), { recursive: true });
  writeFileSync(join(r, '.loom/config.json'), JSON.stringify({ testCmd: `python3 -c "import pkg.m"` }));
  const rep = await go(r, { tasks: [task('a', 'f', { edit: [M, '    return x\n', '    return x + 0\n'] })] });
  expect(rep.merge).toMatchObject({ conflict: null, testsPassed: true });
});

test('B2: work that adds a compile error does not land; the agent is resumed with the new errors and lands its fix', async () => {
  const r = repo();
  const fix = { edit: [M, '    return x  # BROKEN\n', '    return x\n'] };
  const compile = `if grep -q BROKEN ${M}; then echo "${M}:2:5: error: BROKEN is not defined"; exit 1; fi`;
  const rep = await go(r, { compile, tasks: [task('a', 'f', { edit: [M, '    return x\n', '    return x  # BROKEN\n'], resumes: [fix] })] });
  const args = readFileSync(join(log, 'a.args'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(args.at(-1).join(' ')).toContain('BROKEN is not defined');
  expect(args.at(-1).join(' ')).toContain('compiler');
  expect(worker(rep, 'a')).toMatchObject({ exit: 0, resumed: 1, lands: ['compile_failed', 'landed'] });
  expect(merged(r, rep)).not.toContain('BROKEN');
});
