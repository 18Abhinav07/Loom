import { expect, test } from 'vitest';
import { diffFile, indexPython } from '../src/index.js';

const BASE = 'def phone2numeric(phone):\n    return phone.upper()\n\ndef _private(x):\n    return x\n';

test('signature change is a contract change with before/after sigs', async () => {
  const next = await indexPython('t.py', BASE.replace('(phone):', '(phone, *, strict):'));
  const ch = diffFile(await indexPython('t.py', BASE), next);
  expect(ch).toHaveLength(1);
  expect(ch[0].kind).toBe('contract');
  expect(ch[0].symbol.sig).toBe('def phone2numeric(phone)');
  expect(ch[0].after!.sig).toBe('def phone2numeric(phone, *, strict)');
});

test('rename is removed + renamedTo (same body)', async () => {
  const ch = diffFile(await indexPython('t.py', BASE), await indexPython('t.py', BASE.replace('def phone2numeric', 'def phone2numeric_v2')));
  const rm = ch.find((c) => c.kind === 'removed')!;
  expect(rm.symbol.name).toBe('phone2numeric');
  expect(rm.renamedTo!.name).toBe('phone2numeric_v2');
});

test('rettype: behavior change with body diff and the new wrapper class as related', async () => {
  const next = 'class _CoordT:\n    def __init__(self, text):\n        self.text = text\n\n' +
    BASE.replace('return phone.upper()', 'return _CoordT(phone.upper())');
  const ch = diffFile(await indexPython('t.py', BASE), await indexPython('t.py', next));
  const b = ch.find((c) => c.kind === 'behavior')!;
  expect(b.symbol.name).toBe('phone2numeric');
  expect(b.bodyDiff).toContain('+     return _CoordT(phone.upper())');
  expect(b.related.join('\n')).toContain('self.text = text');
});

test('private body-only edits are not reported', async () => {
  const ch = diffFile(await indexPython('t.py', BASE), await indexPython('t.py', BASE.replace('return x', 'return x + 0')));
  expect(ch.filter((c) => c.kind !== 'added')).toEqual([]);
});
