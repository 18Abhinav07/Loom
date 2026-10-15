import { expect, test } from 'vitest';
import { callSatisfies, indexPython } from '../src/index.js';

const SRC = `def f(a, b=1, /, c=2, *, strict, k=3): pass
def g(x, *args, **kw): pass
def h(value, allow_unicode=False): pass
class C:
    def m(self, x, *, y): pass
    @staticmethod
    def s(x): pass
def callers(o):
    f(1, strict=True)
    f(1, 2, 3, strict=True, k=4)
    f(1)
    f(1, b=2, strict=True)
    h(*o)
    o.m(1, y=2)
    h(1, 2, 3)
    h(value=1, allow_unicode=True)
    h(1, value=2)
`;

test('parameters are parsed per kind, with defaults; self marked on non-static methods', async () => {
  const idx = await indexPython('m.py', SRC);
  const p = (q: string) => idx.symbols.find((s) => s.qname === q)!.params!;
  expect(p('f')).toEqual({ posonly: [{ name: 'a', default: false }, { name: 'b', default: true }], pos: [{ name: 'c', default: true }],
    vararg: false, kwonly: [{ name: 'strict', default: false }, { name: 'k', default: true }], kwarg: false, self: false });
  expect(p('g')).toMatchObject({ pos: [{ name: 'x', default: false }], vararg: true, kwarg: true, kwonly: [] });
  expect(p('C.m').self).toBe(true);
  expect(p('C.s').self).toBe(false);
  expect(idx.symbols.find((s) => s.qname === 'C')!.params).toBeUndefined();
});

test('callSatisfies follows Python binding rules (spec 5.12)', async () => {
  const idx = await indexPython('m.py', SRC);
  const sig = (q: string) => idx.symbols.find((s) => s.qname === q)!.params;
  const calls = idx.calls.filter((c) => c.from === 'm.py::callers');
  const at = (i: number) => calls[i];
  expect(callSatisfies(at(0), sig('f'))).toBe(true);           // f(1, strict=True)
  expect(callSatisfies(at(1), sig('f'))).toBe(true);           // all filled
  expect(callSatisfies(at(2), sig('f'))).toBe(false);          // missing required kw-only strict (the STALE signature case)
  expect(callSatisfies(at(3), sig('f'))).toBe(false);          // b is positional-only
  expect(callSatisfies(at(4), sig('h'))).toBe('unknown');      // *args at the call site
  expect(at(5).method).toBe(true);
  expect(callSatisfies(at(5), sig('C.m'))).toBe(true);         // self dropped for a bound call
  expect(callSatisfies(at(6), sig('h'))).toBe(false);          // too many positionals
  expect(callSatisfies(at(7), sig('h'))).toBe(true);
  expect(callSatisfies(at(8), sig('h'))).toBe(false);          // value given twice
  expect(callSatisfies(at(0), undefined)).toBe('unknown');     // class / unknown target
});
