import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { addLesson, ensureLoomDir, indexRepo } from '@loom/memory';
import { Live, type LiveAgent } from '../../src/live/live.js';
import type { Stale } from '../../src/live/stale.js';

const A_PY = 'def f(x):\n    return x\n\n\ndef g():\n    return f(1)\n\n\ndef h():\n    return g()\n\n\ndef k():\n    return 0\n';
const T_PY = 'from a import f\n\n\ndef test_f():\n    assert f(1) == 1\n';
const F = 'a.py::f::definition#0', G = 'a.py::g::definition#0', H = 'a.py::h::definition#0', K = 'a.py::k::definition#0';
const TF = 'tests/test_a.py::test_f::definition#0';
const T0 = 1_000_000_000_000;
const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();

let db: LoomDb; let g: LoomGraph; let root: string; let n = 0; let clock = T0;
let live: Live;
const now = () => clock;
const put = (f: string, s: string) => { mkdirSync(join(root, dirname(f)), { recursive: true }); writeFileSync(join(root, f), s); };
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const body = (agent: string, old: string, nu: string, file = 'a.py') => live.preEdit(agent, { file, edits: [{ old, new: nu }] });
const agent = (id: string, person: string, o: Partial<LiveAgent> = {}): LiveAgent =>
  ({ id, person, worktree: root, top: root, upstream: null, run: null, task: `t-${id}`, scope: [], ...o });
const leases = (a: string) => g.query<{ id: string }>('MATCH (:Agent {id: $a})-[:LEASED]->(r:Region) RETURN r.id AS id ORDER BY id', { a });

beforeAll(async () => { db = await LoomDb.connect(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  clock = T0;
  root = mkdtempSync(join(tmpdir(), 'loom-live-'));
  put('a.py', A_PY); put('tests/test_a.py', T_PY);
  sh(root, 'init', '-q', '-b', 'main');
  ensureLoomDir(root, { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true });
  g = db.graph(`loom:test:live-${process.pid}-${n++}`);
  await indexRepo(g, root);
  sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'base');
  sh(root, 'branch', 'up');
  live = new Live(g, { now });
  for (const a of [agent('x', 'P1'), agent('y', 'P2'), agent('z', 'P1'), agent('w', 'P3'), agent('v', 'P4')]) await live.register(a);
});
afterEach(async () => { await g.drop(); });

test('lease: x edits f body → allow; y edits f → deny naming x and x\'s task', async () => {
  expect(await body('x', 'return x', 'return x + 1')).toMatchObject({ allow: true });
  const d = await body('y', 'return x', 'return x * 2');
  expect(d.allow).toBe(false);
  if (!d.allow) { expect(d.reason).toContain('agent x'); expect(d.reason).toContain('t-x'); }
  expect(await leases('x')).toEqual([{ id: F }]);
  expect(await leases('y')).toEqual([]);
});

test('same person, two sessions: z (same person as x) is denied on f too', async () => {
  await body('x', 'return x', 'return x + 1');
  expect((await body('z', 'return x', 'return x - 1')).allow).toBe(false);
});

test('created function: y adds h2 → allow without a lease', async () => {
  expect(await body('y', 'def k():', 'def h2():\n    return 2\n\n\ndef k():')).toMatchObject({ allow: true });
  expect(await leases('y')).toEqual([]);
});

test('lessons on touched regions arrive as context on allow', async () => {
  await addLesson(g, root, null, F, 'f must stay pure: callers cache it', 'manual');
  const r = await body('x', 'return x', 'return x + 1');
  expect(r.allow).toBe(true);
  if (r.allow) expect(r.context).toContain('f must stay pure');
  const r2 = await body('y', 'return 0', 'return 1');
  if (r2.allow) expect(r2.context).toBeUndefined();
});

test('postEdit on a contract change of f → a notice for the holder of g (1 hop CALLS) and tests/test_a.py (TESTS), none for x itself (RC6)', async () => {
  expect((await body('y', 'return f(1)', 'return f(2)')).allow).toBe(true);
  expect((await body('w', 'assert f(1) == 1', 'assert f(2) == 2', 'tests/test_a.py')).allow).toBe(true);
  expect((await body('v', 'return 0', 'return 5')).allow).toBe(true);
  expect((await live.preEdit('x', { file: 'a.py', edits: [{ old: 'def f(x):', new: 'def f(x, y=0):' }] })).allow).toBe(true);
  put('a.py', read('a.py').replace('def f(x):', 'def f(x, y=0):'));
  expect(await live.postEdit('x', 'a.py')).toEqual({ changed: [F], notices: 2 });
  const ny = await live.takeNotices('y');
  expect(ny).toHaveLength(1);
  expect(ny[0].text).toContain('f(x, y=0)');
  expect(await live.takeNotices('w')).toHaveLength(1);
  expect(await live.takeNotices('v')).toEqual([]);   // k does not depend on f
  expect(await live.takeNotices('x')).toEqual([]);
});

test('notice text is built at delivery: f changes twice before y reads → y sees the latest signature (RC3)', async () => {
  await body('y', 'return f(1)', 'return f(2)');
  await live.preEdit('x', { file: 'a.py', edits: [{ old: 'def f(x):', new: 'def f(x, y=0):' }] });
  put('a.py', read('a.py').replace('def f(x):', 'def f(x, y=0):'));
  await live.postEdit('x', 'a.py');
  put('a.py', read('a.py').replace('def f(x, y=0):', 'def f(x, *, y=0):'));
  await live.postEdit('x', 'a.py');
  const ny = await live.takeNotices('y');
  expect(ny).toHaveLength(1);
  expect(ny[0].text).toContain('f(x, *, y=0)');
  expect(ny[0].text).not.toContain('after:  def f(x, y=0)');
  expect(await live.takeNotices('y')).toEqual([]);   // delivered once
});

test('RC5: 3rd denial within 60 s → "stop editing R; you will be woken"; the 4th is a bare deny', async () => {
  await body('x', 'return x', 'return x + 1');
  const d1 = await body('y', 'return x', 'return x * 2'); clock += 10_000;
  const d2 = await body('y', 'return x', 'return x * 3'); clock += 10_000;
  const d3 = await body('y', 'return x', 'return x * 4'); clock += 10_000;
  const d4 = await body('y', 'return x', 'return x * 5');
  for (const d of [d1, d2]) expect(!d.allow && d.reason.includes('agent x')).toBe(true);
  expect(!d3.allow && d3.reason).toMatch(/stop editing f; you will be woken/);
  expect(d4).toEqual({ allow: false, reason: '[loom] wait for the wake on f.' });
});

test('RC5: denials spread over more than 60 s do not trip the back-off', async () => {
  await body('x', 'return x', 'return x + 1');
  for (let i = 0; i < 3; i++) { const d = await body('y', 'return x', `return x * ${i}`); expect(!d.allow && d.reason).not.toMatch(/stop editing/); clock += 31_000; }
});

test('RC6: x lands f → y (waiting) gets a wake; x gets none', async () => {
  await body('x', 'return x', 'return x + 1');
  await body('y', 'return x', 'return x * 2');
  await live.land('x', [F]);
  const ny = await live.takeNotices('y');
  expect(ny.map((m) => m.kind)).toEqual(['wake']);
  expect(ny[0].text).toContain('has landed');
  expect(await live.takeNotices('x')).toEqual([]);
  expect((await body('y', 'return x', 'return x * 2')).allow).toBe(true);   // the lease is free
});

test('land marks waiters and lease/scope holders syncPending; others not', async () => {
  await live.register(agent('s', 'P5', { scope: [F] }));
  await body('x', 'return x', 'return x + 1');
  await body('y', 'return x', 'return x * 2');   // waits on f
  await body('v', 'return 0', 'return 5');       // holds k only
  expect(await live.land('x', [F])).toEqual(['s', 'y']);
  const rows = await g.query<{ id: string; p: boolean }>('MATCH (a:Agent) RETURN a.id AS id, coalesce(a.syncPending, false) AS p ORDER BY id');
  expect(rows.filter((r) => r.p).map((r) => r.id)).toEqual(['s', 'y']);
});

test('version check: a stale region denies once with the summary; ack → allow', async () => {
  const st: Stale = { region: F, version: 'v9', by: 'Q@t', task: 'T-7', decision: 'f returns ints', summary: 'f changed on up by Q@t (task T-7): f returns ints' };
  const fake = async (gg: LoomGraph, _t: string, ids: string[], o: { me: { agent: string } }) => {
    const acked = await gg.query<{ v: string }>('MATCH (:Agent {id: $a})-[k:ACKED]->(:Region {id: $r}) RETURN k.version AS v', { a: o.me.agent, r: F });
    return ids.includes(F) && !acked.some((k) => k.v === 'v9') ? [st] : [];
  };
  live = new Live(g, { now, stale: fake });
  await live.register(agent('i', 'P6', { upstream: 'up' }));
  const d = await body('i', 'return x', 'return x + 1');
  expect(d.allow).toBe(false);
  if (d.allow) return;
  expect(d.reason).toContain(st.summary);
  const id = /ack_notice (\S+)/.exec(d.reason)?.[1];
  expect(id).toBeTruthy();
  await live.ack('i', id!);
  expect((await body('i', 'return x', 'return x + 1')).allow).toBe(true);

  await live.register(agent('r1', 'P7', { upstream: 'up', run: 'run-1' }));
  await live.release('i');
  const dr = await body('r1', 'return x', 'return x + 2');
  expect(!dr.allow && dr.reason).toMatch(/your file now contains it, re-read f/);
  expect((await body('r1', 'return x', 'return x + 2')).allow).toBe(true);   // denied once only
});

test('unseen: a Bash write to g\'s body → unleased_write notice to the holder of h (g\'s caller); the holder of f (g\'s callee) gets none', async () => {
  await body('x', 'return x', 'return x + 1');   // x holds f
  await body('v', 'return g()', 'return g() + 1');   // v holds h, which calls g
  put('a.py', read('a.py').replace('return f(1)', 'return f(3)'));
  expect(await live.unseen('y')).toEqual(['a.py']);
  const nv = await live.takeNotices('v');
  expect(nv.map((m) => m.kind)).toEqual(['unleased_write']);
  expect(nv[0].text).toContain('g');
  expect(await live.takeNotices('x')).toEqual([]);
  expect(await live.unseen('y')).toEqual([]);   // same blob: already seen
});

test('sweep after restart: a new Live on the same graph frees an expired lease and wakes its waiter', async () => {
  await body('x', 'return x', 'return x + 1');
  await body('y', 'return x', 'return x * 2');
  clock += 11 * 60_000;
  const fresh = new Live(g, { now });
  await fresh.sweep();
  expect(await leases('x')).toEqual([]);
  const ny = await fresh.takeNotices('y');
  expect(ny.map((m) => m.kind)).toEqual(['wake']);
  expect(ny[0].text).toContain('lapsed');
});

test('release on SessionEnd frees every lease of that agent', async () => {
  await body('x', 'return x', 'return x + 1');
  await body('x', 'return 0', 'return 1');
  expect(await leases('x')).toEqual([{ id: F }, { id: K }]);
  await live.release('x');
  expect(await leases('x')).toEqual([]);
  expect((await body('y', 'return x', 'return x * 2')).allow).toBe(true);
});

test('handover on a pending sync: syncIfPending merges the landed branch into the worktree', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'loom-live-wt-'));
  sh(root, 'worktree', 'add', '-q', '-b', 'agent-y', join(wt, 'y'));
  await live.register(agent('q', 'P8', { worktree: join(wt, 'y'), upstream: 'main' }));
  put('a.py', read('a.py').replace('return 0', 'return 7')); sh(root, 'commit', '-qam', 'landed k');
  await g.query("MATCH (a:Agent {id: 'q'}) SET a.syncPending = true");
  expect((await live.syncIfPending('q'))?.status).toBe('clean');
  expect(readFileSync(join(wt, 'y', 'a.py'), 'utf8')).toContain('return 7');
  expect(await live.syncIfPending('q')).toBeNull();
});

// Live coordination A–C: calls written while agents work are graph edges at once, so a signature change and a new call
// to it find each other in whichever order they happen; the function an agent creates is its own leased region.
const U = 'a.py::u::definition#0';
async function ownWorktree(id: string): Promise<string> {
  const d = join(mkdtempSync(join(tmpdir(), 'loom-live-wt-')), id);
  sh(root, 'worktree', 'add', '-q', '-b', `agent-${id}`, d);
  await live.register(agent(id, 'P9', { worktree: d }));
  return d;
}
async function edit(id: string, wt: string, old: string, nu: string) {
  expect((await live.preEdit(id, { file: 'a.py', edits: [{ old, new: nu }] })).allow).toBe(true);
  writeFileSync(join(wt, 'a.py'), readFileSync(join(wt, 'a.py'), 'utf8').replace(old, nu));
  return live.postEdit(id, 'a.py');
}
const addCaller = (wt: string) => edit('q', wt, 'def k():', 'def u(v):\n    return f(v)\n\n\ndef k():');
const strictF = () => edit('x', root, 'def f(x):', 'def f(x, *, strict):');

test('contract first: q writes a new call to f while x holds f under a signature change → q is told the pending signature, x is told of the new caller; q leases u', async () => {
  await strictF();
  const wt = await ownWorktree('q');
  await addCaller(wt);
  const nq = await live.takeNotices('q');
  expect(nq.map((m) => m.kind)).toEqual(['contract_use']);
  expect(nq[0].text).toContain('agent x');
  expect(nq[0].text).toContain('f(x, *, strict)');
  expect(nq[0].text).toContain('lands second');
  const nx = await live.takeNotices('x');
  expect(nx.map((m) => m.kind)).toEqual(['new_caller']);
  expect(nx[0].text).toMatch(/agent q[\s\S]* u\b/);
  expect(await leases('q')).toEqual([{ id: U }]);
});

test('caller first: q has written u calling f, then x changes f\'s signature → q (through its lease on u) gets the change, x gets the new caller', async () => {
  const wt = await ownWorktree('q');
  await addCaller(wt);
  expect(await live.takeNotices('q')).toEqual([]);
  await strictF();
  const nq = await live.takeNotices('q');
  expect(nq.map((m) => m.kind)).toEqual(['change']);
  expect(nq[0].text).toContain('f(x, *, strict)');
  expect(nq[0].text).toContain('lands second');
  expect(nq[0].text).not.toContain('AFTER version');
  const nx = await live.takeNotices('x');
  expect(nx.map((m) => m.kind)).toEqual(['new_caller']);
  expect(nx[0].text).toMatch(/agent q[\s\S]* u\b/);
});

test('no false alarm: a body-only change of f tells x nothing about q\'s new caller', async () => {
  const wt = await ownWorktree('q');
  await addCaller(wt);
  await edit('x', root, '    return x\n', '    return x + 1\n');
  expect(await live.takeNotices('x')).toEqual([]);
});
