import { expect, test } from 'vitest';
import { applyEdits, predictLease } from '../src/predict.js';

const SRC = 'def slugify(value, allow_unicode=False):\n    return value\n\ndef _helper(x):\n    return x\n';

test('signature change → contract; body change → write; nothing → null', async () => {
  const sig = applyEdits(SRC, { file: 't.py', edits: [{ old: 'allow_unicode=False)', new: 'allow_unicode=False, *, strict)' }] })!;
  expect(await predictLease('t.py', SRC, sig)).toEqual({ sids: ['t.py::slugify'], mode: 'contract' });
  const body = applyEdits(SRC, { file: 't.py', edits: [{ old: '    return x', new: '    return x * 2' }] })!;
  expect(await predictLease('t.py', SRC, body)).toEqual({ sids: ['t.py::_helper'], mode: 'write' });   // private symbols lease too
  const added = SRC + '\ndef new(y):\n    return y\n';
  expect(await predictLease('t.py', SRC, added)).toEqual({ sids: [], mode: null });                   // new symbols need no lease
  expect(await predictLease('t.py', SRC, SRC.replace('def _helper', 'def _helper2'))).toMatchObject({ mode: 'contract' }); // removal
});

test('applyEdits: not found → null; replace_all; whole-file content', () => {
  expect(applyEdits(SRC, { file: 't.py', edits: [{ old: 'nope', new: 'x' }] })).toBeNull();
  expect(applyEdits('a a', { file: 't.py', edits: [{ old: 'a', new: 'b', all: true }] })).toBe('b b');
  expect(applyEdits(SRC, { file: 't.py', content: 'x = 1\n' })).toBe('x = 1\n');
});
