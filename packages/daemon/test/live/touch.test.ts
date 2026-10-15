import { expect, test } from 'vitest';
import { touched } from '../../src/live/touch.js';
const A = 'def f(x):\n    return x\n\ndef g():\n    return f(1)\n';

test('body edit → write on that region only', async () => {
  expect(await touched('a.py', A, A.replace('return x', 'return x + 1'))).toEqual({ ids: ['a.py::f::definition#0'], created: [], mode: 'write' });
});
test('signature edit → contract', async () => {
  expect((await touched('a.py', A, A.replace('f(x)', 'f(x, y=0)'))).mode).toBe('contract');
});
test('new function → created, nothing to lease; new file → no lease', async () => {
  const r = await touched('a.py', A, `${A}\ndef h():\n    return 2\n`);
  expect(r.ids.filter((i) => i.includes('::h::'))).toEqual([]);
  expect(r.created).toContain('a.py::h::definition#0');
  expect((await touched('b.py', null, 'def z():\n    pass\n')).mode).toBeNull();
});
test('an edit that breaks the parse still names the region (shifted map)', async () => {
  const r = await touched('a.py', A, A.replace('return x', 'return (x'));
  expect(r.ids).toContain('a.py::f::definition#0');
  expect(r.mode).not.toBeNull();
});
test('tests/ files are regions too (RC4)', async () => {
  expect((await touched('tests/test_a.py', 'def test_f():\n    assert 1\n', 'def test_f():\n    assert 2\n')).ids).toEqual(['tests/test_a.py::test_f::definition#0']);
});
