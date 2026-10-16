// Live coordination D: a landing whose merged code has a call that no longer fits the signature it calls does not land
// (contract_break), whichever side changed — the signature or the call — and names the call sites.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { landOne } from '../../src/live/queue.js';
import { git, gitTree } from '../helpers.js';

const A_PY = 'def f(x):\n    return x\n\n\ndef g():\n    return f(1)\n';
let db: LoomDb; let g: LoomGraph;
beforeAll(async () => { db = await LoomDb.connect(); g = db.graph(`ct-${Date.now()}`); });
afterAll(async () => { await g.drop().catch(() => {}); await db.close(); });

const put = (d: string, f: string, s: string) => { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), s); };
function repo(files: Record<string, string> = { 'pkg/a.py': A_PY }) {
  const r = gitTree(files);
  git(r, 'branch', 'landed');
  const wt = (id: string) => { const w = mkdtempSync(join(tmpdir(), `c-${id}-`)); git(r, 'worktree', 'add', '-q', '-b', id, w); return w; };
  return { r, x: wt('x'), y: wt('y') };
}
const land = (r: string, wt: string, agent: string) => landOne({ repo: r, wt, landed: 'landed', agent, title: agent, testCmd: 'true', g });
const rev = (r: string) => git(r, 'rev-parse', 'landed').trim();

test('signature changed after a new caller landed: the second lander gets contract_break naming the caller; landed does not move', async () => {
  const { r, x, y } = repo();
  put(y, 'pkg/a.py', A_PY + '\n\ndef u(v):\n    return f(v)\n');                          // y adds a caller of f
  expect((await land(r, y, 'y')).status).toBe('landed');
  const before = rev(r);
  put(x, 'pkg/a.py', A_PY.replace('def f(x):', 'def f(x, *, strict):').replace('f(1)', 'f(1, strict=False)'));
  const res = await land(r, x, 'x');
  expect(res.status).toBe('contract_break');
  expect(res.tail).toMatch(/pkg\/a\.py:\d+ u calls f/);
  expect(res.tail).not.toMatch(/ g calls f/);                                                // x updated g itself
  expect(rev(r)).toBe(before);
});

test('new caller written against the old signature after the change landed: contract_break for the caller\'s agent', async () => {
  const { r, x, y } = repo();
  put(x, 'pkg/a.py', A_PY.replace('def f(x):', 'def f(x, *, strict):').replace('f(1)', 'f(1, strict=False)'));
  expect((await land(r, x, 'x')).status).toBe('landed');
  put(y, 'pkg/b.py', 'from pkg.a import f\n\n\ndef w():\n    return f(2)\n');
  const res = await land(r, y, 'y');
  expect(res.status).toBe('contract_break');
  expect(res.tail).toMatch(/pkg\/b\.py:\d+ w calls f/);
});

test('a call to a function that does not exist in the merged code: contract_break', async () => {
  const { r, y } = repo();
  put(y, 'pkg/c.py', 'from pkg.a import missing\n\n\ndef z():\n    return missing(1)\n');
  const res = await land(r, y, 'y');
  expect(res.status).toBe('contract_break');
  expect(res.tail).toContain('missing does not exist');
});

test('no false alarms: a body-only change, a compatible signature change, and a **kwargs call all land', async () => {
  const { r, x, y } = repo({ 'pkg/a.py': A_PY + '\n\ndef h(**kw):\n    return f(**kw)\n' });
  put(x, 'pkg/a.py', A_PY.replace('return x', 'return x + 0').replace('def f(x):', 'def f(x, y=0):') + '\n\ndef h(**kw):\n    return f(**kw)\n');
  expect((await land(r, x, 'x')).status).toBe('landed');
  put(y, 'pkg/d.py', 'import os\n\n\ndef e():\n    return os.path.join("a", "b")\n');   // calls outside the repo are not judged
  expect((await land(r, y, 'y')).status).toBe('landed');
});

test('a test that calls with the wrong arguments on purpose, inside raises(TypeError), lands; the same call elsewhere does not', async () => {
  const neg = (body: string) => `from pkg.a import f\nimport pytest\nimport unittest\n\n\n${body}`;
  const { r, y } = repo();
  put(y, 'tests/test_f.py', neg('def test_extra():\n    with pytest.raises(TypeError):\n        f(1, 2)\n\n\n'
    + 'class T(unittest.TestCase):\n    def test_none(self):\n        with self.assertRaises((TypeError, ValueError)):\n            f()\n'));
  expect((await land(r, y, 'y')).status).toBe('landed');
  const { r: r2, y: y2 } = repo();
  put(y2, 'tests/test_f.py', neg('def test_extra():\n    with pytest.raises(ValueError):\n        f(1, 2)\n    f(1, 2)\n'));
  const res = await land(r2, y2, 'y');
  expect(res.status).toBe('contract_break');                                             // ValueError is not what a bad call raises
  expect(res.tail.match(/test_extra calls f/g)).toHaveLength(2);
});

test('a function passed to map/filter/key= is called by them: a reference that no longer fits is a contract_break (t1 loom r2)', async () => {
  const { r, x, y } = repo();
  put(x, 'pkg/a.py', A_PY.replace('def f(x):', 'def f(x, *, strict):').replace('f(1)', 'f(1, strict=False)'));
  expect((await land(r, x, 'x')).status).toBe('landed');
  put(y, 'pkg/b.py', 'from pkg.a import f\n\n\ndef w(xs):\n    return "/".join([*map(f, xs)])\n\n\ndef k(xs):\n    return sorted(xs, key=f)\n');
  const res = await land(r, y, 'y');
  expect(res.status).toBe('contract_break');
  expect(res.tail).toMatch(/pkg\/b\.py:\d+ w calls f/);
  expect(res.tail).toMatch(/pkg\/b\.py:\d+ k calls f/);
});

test('no false alarm: map/filter/key= with a function that fits, or two iterables for a two-argument function, lands', async () => {
  const { r, y } = repo({ 'pkg/a.py': A_PY + '\n\ndef two(a, b):\n    return a\n' });
  put(y, 'pkg/b.py', 'from pkg.a import f, two\n\n\ndef w(xs):\n    return list(map(f, xs)) + list(filter(f, xs)) + sorted(xs, key=f) + list(map(two, xs, xs))\n');
  expect((await land(r, y, 'y')).status).toBe('landed');
});
