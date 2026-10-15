// P4: test mapping, the runner, claims with evidence and mutation strength (plan 04 Tasks 1–2).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { Coordinator } from '../src/coordinator.js';
import { Lessons } from '../src/lessons.js';
import { mapTests, runTests, testCfg, testLabel, type TestCfg } from '../src/verify.js';
import { git, gitTree } from './helpers.js';

export const M = 'pkg/m.py';
export const MSRC = 'def f(x):\n    return x + 1\n\n\ndef g(x):\n    return x\n\n\ndef h(x):\n    return x\n';
export const TSRC = 'import unittest\nfrom pkg import m\n\n\nclass T(unittest.TestCase):\n'
  + '    def test_f(self):\n        self.assertEqual(m.f(1), 2)\n\n    def test_none(self):\n        pass\n';
export const CFG: TestCfg = { command: 'cd tests && PYTHONPATH=.. python3 -m unittest {labels}', label: '{module_dotted}.{Class}.{method}', root: 'tests' };
export const fixture = (extra: Record<string, string> = {}) => gitTree({
  [M]: MSRC, 'pkg/__init__.py': '', 'tests/__init__.py': '', 'tests/test_m.py': TSRC,
  '.loom/config.json': JSON.stringify({ run: 'x', dirs: ['pkg'], test: CFG }), ...extra,
});

test('1.1 mapTests finds the test that calls f, and nothing for g; labels follow the template', async () => {
  const r = fixture();
  const map = await mapTests(r, [`${M}::f`, `${M}::g`], CFG);
  expect(map.get(`${M}::f`)?.map((t) => t.label)).toEqual(['test_m.T.test_f']);
  expect(map.get(`${M}::g`) ?? []).toEqual([]);
  expect(testLabel('tests/a/test_x.py', 'test_top', CFG)).toBe('a.test_x.test_top');
  expect(testLabel('tests/a/test_x.py', 'C.test_m', { ...CFG, label: '{path}::{Class}::{method}' })).toBe('tests/a/test_x.py::C::test_m');
});

test('1.2 runTests passes, fails with a tail, and times out', async () => {
  const r = fixture();
  expect(await runTests(r, CFG, ['test_m.T.test_f'])).toMatchObject({ ok: true });
  const bad = fixture({ 'tests/test_m.py': TSRC.replace('m.f(1), 2', 'm.f(1), 3') });
  const out = await runTests(bad, CFG, ['test_m.T.test_f']);
  expect(out.ok).toBe(false);
  expect(out.tail).toContain('FAIL');
  const t0 = Date.now();
  expect((await runTests(r, { ...CFG, command: 'sleep 5', timeoutS: 1 }, [])).ok).toBe(false);
  expect(Date.now() - t0).toBeLessThan(3000);
});

test('1.3 testCfg reads .loom/config.json test; a repo without one has none', () => {
  expect(testCfg(fixture())).toMatchObject({ root: 'tests', command: CFG.command });
  expect(testCfg(mkdtempSync(join(tmpdir(), 'loom-none-')))).toBeNull();
  expect(testCfg(gitTree({ '.loom/config.json': JSON.stringify({ test: { command: 'x' } }) }))).toMatchObject({ root: '.', label: '{module_dotted}.{Class}.{method}' });
});

const WEAK = 'import unittest\nfrom pkg import m\n\n\nclass G(unittest.TestCase):\n    def test_g(self):\n        m.g(1)\n';
let db: LoomDb; let g: LoomGraph; let c: Coordinator; let wa: string; let wb: string; let L: Lessons;
beforeAll(async () => {
  db = await LoomDb.connect(); g = db.graph(`test:verify:${Date.now()}`);
  L = new Lessons(db.graph(`test:lessons:${Date.now()}`));
  c = await Coordinator.create(g, 'v1', undefined, L);
  await c.indexBase(fixture(), ['pkg']);
  wa = fixture({ 'tests/test_g.py': WEAK }); wb = fixture();
  await c.registerAgent('A', 'claude', wa); await c.registerAgent('B', 'claude', wb);
});
afterAll(async () => { await g.drop(); await L.g.drop(); await db.close(); });
const edit = async (agent: string, wt: string, text: string) => { writeFileSync(join(wt, M), text); await c.onEdit(agent, wt, M); };
const fp = (wt: string) => createHash('md5').update(git(wt, 'status', '--porcelain') + readFileSync(join(wt, M), 'utf8')
  + git(wt, 'worktree', 'list')).digest('hex');

test('2.1 claim_done verifies: strength from mutants, a weak test is a blind spot, rule 3 names it, an edit stales it', async () => {
  await edit('A', wa, MSRC.replace('return x + 1', 'return 1 + x'));
  const before = fp(wa);
  expect(await c.claimDone('A', 't1')).toMatchObject({ state: 'VERIFIED', strength: 1, blindSpots: [], labels: ['test_m.T.test_f'] });
  expect(fp(wa)).toBe(before);                                       // mutants never touch the agent's worktree

  await edit('A', wa, MSRC.replace('return x + 1', 'return 1 + x').replace('return x\n\n\ndef h', 'return x * 1\n\n\ndef h'));
  const weak = await c.claimDone('A', 't1');
  expect(weak).toMatchObject({ state: 'VERIFIED', strength: 0.5, blindSpots: [`${M}::g`] });
  const d = await c.stopGate('A', false);
  expect(d).toMatchObject({ block: true, rule: 'claim' });
  expect(d.block && d.reason).toContain('blind spot: tests still pass when g is mutated');

  writeFileSync(join(wa, 'tests/test_g.py'), WEAK.replace('m.g(1)', 'self.assertEqual(m.g(2), 2)'));
  expect(await c.claimDone('A', 't1')).toMatchObject({ state: 'VERIFIED', strength: 1, blindSpots: [] });
  expect(await c.stopGate('A', false)).toEqual({ block: false });
  const [run] = await g.query<{ n: number }>(`MATCH (r:TestRun)-[:SUPPORTS]->(:Claim {agent: 'A'}) RETURN count(r) AS n`);
  expect(run.n).toBe(3);

  await edit('A', wa, MSRC.replace('return x + 1', 'return 2 + x - 1'));
  const [cl] = await g.query<{ s: string }>(`MATCH (c:Claim {agent: 'A'}) RETURN c.state AS s`);
  expect(cl.s).toBe('STALE');
  expect((await c.stopGate('A', false)) as any).toMatchObject({ block: true, rule: 'claim', reason: expect.stringContaining('evidence stale') });
});

test('2.2 no test exercises the change → UNKNOWN with the missing hop; a failing test → FAIL', async () => {
  await edit('B', wb, MSRC.replace('def h(x):\n    return x', 'def h(x):\n    return x or 0'));
  expect(await c.claimDone('B', 't2')).toMatchObject({ state: 'UNKNOWN', strength: null, missing: 'no test exercises h' });
  await edit('B', wb, MSRC.replace('return x + 1', 'return x + 2'));
  const r = await c.claimDone('B', 't2');
  expect(r).toMatchObject({ state: 'FAIL' });
  expect(r.missing).toContain('tests failing: test_m.T.test_f');

  const wf = fixture(); await c.registerAgent('F', 'claude', wf);      // adds a function, changes nothing: a gap F cannot fix never blocks Stop
  await edit('F', wf, MSRC + '\n\ndef k(x):\n    return x\n');
  expect(await c.claimDone('F', 't2')).toMatchObject({ state: 'UNKNOWN', missing: 'no changed symbols to verify' });
  expect(await c.stopGate('F', false)).toEqual({ block: false });

  const LOOP = MSRC.replace('def h(x):\n    return x', 'def h(x):\n    i = 0\n    while i != 4:\n        i += 2\n    return x + i');
  const wg = fixture({ 'tests/test_h.py': 'import unittest\nfrom pkg import m\n\n\nclass H(unittest.TestCase):\n    def test_h(self):\n        self.assertEqual(m.h(1), 5)\n' });
  await c.registerAgent('G', 'claude', wg);
  await edit('G', wg, LOOP);                                            // the const mutant (i = 1) never ends: cut at 3× baseline, not timeoutS
  const t0 = Date.now();
  expect(await c.claimDone('G', 't2')).toMatchObject({ state: 'VERIFIED', strength: 1 });
  expect(Date.now() - t0).toBeLessThan(25_000);
}, 60_000);

test('3.1 T3: a FAIL after an unresolved notice is a lesson; an agent of a fresh run touching that file is told once', async () => {
  const wc = fixture(); const wd = fixture();
  await c.registerAgent('C', 'claude', wc); await c.registerAgent('D', 'claude', wd);
  const CALLS_G = MSRC.replace('return x + 1', 'return g(x) + 1');
  await edit('D', wd, CALLS_G);                                       // D's f now calls g
  await edit('C', wc, MSRC.replace('def g(x):', 'def g(x, y):'));    // C changes g's contract → notice to D
  expect((await c.takeNotices('D')).map((n) => n.text).join()).toContain('g');
  await edit('D', wd, CALLS_G.replace('def g(x):', 'def g(x, y):'));  // D pulls C's g but never adapts f
  expect(await c.claimDone('D', 't3')).toMatchObject({ state: 'FAIL' });
  const [l] = await L.about([`${M}::g`]);
  expect(l.text).toBe('D was told g changed but f was not adapted; test_m.T.test_f failed.');

  const g2 = db.graph(`test:verify2:${Date.now()}`);
  try {
    const c2 = await Coordinator.create(g2, 'v2', undefined, L);
    await c2.indexBase(fixture(), ['pkg']);
    await c2.registerAgent('E', 'claude', fixture());
    expect(await c2.pendingLessons('E')).toBeNull();                  // no scope yet: nothing to say
    await c2.onRead('E', M);
    expect(await c2.pendingLessons('E')).toBe(`[loom] lessons:\n- ${l.text}`);
    expect(await c2.pendingLessons('E')).toBeNull();                  // once per agent
  } finally { await g2.drop(); }
});
