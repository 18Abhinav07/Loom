import { expect, test } from 'vitest';
import { applyMutant, indexPython, mutants } from '../src/index.js';

const SRC = `from django.utils.functional import keep_lazy_text
from django.utils import html as H

@keep_lazy_text
def phone2numeric(phone):
    # map letters
    return phone.upper()

def phone2numeric_clean(phone):
    return phone2numeric(phone.replace(" ", ""), strict=False) + H.escape(phone)

class Box:
    """Holds things
    for later."""
    def get(self, k=1):
        return self.other(k)
    def other(self, k):
        return k
`;

test('symbols, signatures, exported, ranges', async () => {
  const idx = await indexPython('django/utils/text.py', SRC);
  const ids = idx.symbols.map((s) => s.id);
  expect(ids).toEqual([
    'django/utils/text.py::phone2numeric',
    'django/utils/text.py::phone2numeric_clean',
    'django/utils/text.py::Box',
    'django/utils/text.py::Box.get',
    'django/utils/text.py::Box.other',
  ]);
  const p = idx.symbols[0];
  expect(p.sig).toBe('def phone2numeric(phone)');
  expect(p.startLine).toBe(4); // decorator line
  expect(p.exported).toBe(true);
  expect(p.doc).toBeUndefined();
  expect(idx.symbols[2].doc).toBe('Holds things\n    for later.');
});

test('calls are resolved through same-file defs, module aliases and self', async () => {
  const idx = await indexPython('django/utils/text.py', SRC);
  const c = idx.calls.filter((x) => x.from.endsWith('::phone2numeric_clean'));
  const p2n = c.find((x) => x.callee === 'phone2numeric')!;
  expect(p2n.to).toEqual(['django/utils/text.py::phone2numeric']);
  expect(p2n.argc).toBe(1);
  expect(p2n.kwargs).toEqual(['strict']);
  expect(c.find((x) => x.callee === 'H.escape')!.to).toContain('django/utils/html.py::escape');
  const self = idx.calls.find((x) => x.from.endsWith('::Box.get'))!;
  expect(self.to).toEqual(['django/utils/text.py::Box.other']);
});

test('comments and whitespace do not change bodyHash; a signature edit changes sigHash only', async () => {
  const a = await indexPython('m.py', 'def f(a):\n    return a\n');
  const b = await indexPython('m.py', 'def f(a):\n    # note\n    return  a\n');
  const c = await indexPython('m.py', 'def f(a, *, strict):\n    return a\n');
  expect(b.symbols[0].bodyHash).toBe(a.symbols[0].bodyHash);
  expect(c.symbols[0].sigHash).not.toBe(a.symbols[0].sigHash);
  expect(c.symbols[0].bodyHash).toBe(a.symbols[0].bodyHash);
});

test('mutants: one per operator inside the symbol, each still parses with the symbol present', async () => {
  const src = 'def other(n):\n    return n < 9\n\n\ndef f(xs, n):\n    if n > 0:\n        xs = sorted(xs, reverse=True)\n    return xs[:n + 1]\n';
  const f = (await indexPython('m.py', src)).symbols.find((s) => s.name === 'f')!;
  const ms = await mutants(src, f);
  expect(ms.map((m) => m.op).sort()).toEqual(['arg', 'cmp', 'const', 'not', 'ret']);
  expect(ms.every((m) => m.start > src.indexOf('def f'))).toBe(true);   // nothing from other()
  const out = Object.fromEntries(ms.map((m) => [m.op, applyMutant(src, m).slice(src.indexOf('def f'))]));
  expect(out.cmp).toContain('if n <= 0:');
  expect(out.not).toContain('if not (n > 0):');
  expect(out.ret).toContain('return None');
  expect(out.const).toContain('if n > 1:');
  expect(out.arg).toContain('sorted(xs)');
  for (const m of ms) expect((await indexPython('m.py', applyMutant(src, m))).symbols.map((s) => s.name)).toContain('f');
});
