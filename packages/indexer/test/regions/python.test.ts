import { expect, test } from 'vitest';
import { checkInvariants, regionize } from '../../src/regions/index.js';

const SRC = [
  '"""Module doc."""',
  'import os',
  'from .x import y as z',
  '',
  '# helper',
  'def a(p, q=1) -> int:',
  '    return p + q',
  '',
  '',
  '@dec',
  'def b():',
  '    def inner():',
  '        pass',
  '    return inner()',
  '',
  '',
  'class C(Base):',
  '    """Doc."""',
  '    attr = 1',
  '',
  '    # m comment',
  '    def m(self):',
  '        return self.n()',
  '',
  '    def n(self):',
  '        return a(1)',
  '',
  'X = 1',
  '',
].join('\n');

const rows = (fr: Awaited<ReturnType<typeof regionize>>) => fr.regions.map((r) => [r.kind, r.qname, fr.text.slice(r.start, r.end)]);

test('python: kinds, comment/decorator attachment, containers, imports run, gaps', async () => {
  const fr = await regionize('pkg/mod.py', SRC);
  expect(fr.pack).toBe('python@1');
  expect(fr.degraded).toBe(false);
  expect(rows(fr)).toEqual([
    ['gap', 'gap@start', '"""Module doc."""\n'],
    ['imports', 'imports', 'import os\nfrom .x import y as z\n'],
    ['gap', 'gap@after:imports', '\n'],
    ['definition', 'a', '# helper\ndef a(p, q=1) -> int:\n    return p + q\n'],
    ['gap', 'gap@after:a', '\n\n'],
    ['definition', 'b', '@dec\ndef b():\n    def inner():\n        pass\n    return inner()\n'],
    ['gap', 'gap@after:b', '\n\n'],
    ['container', 'C', 'class C(Base):\n    """Doc."""\n    attr = 1\n\n'],
    ['definition', 'C.m', '    # m comment\n    def m(self):\n        return self.n()\n'],
    ['gap', 'gap@after:C.m', '\n'],
    ['definition', 'C.n', '    def n(self):\n        return a(1)\n'],
    ['gap', 'gap@after:C.n', '\n'],
    ['definition', 'X', 'X = 1\n'],
  ]);
  expect(checkInvariants(fr)).toEqual([]);
});

test('python: ids, sigs, masked hash ignores the name', async () => {
  const fr = await regionize('pkg/mod.py', SRC);
  const by = Object.fromEntries(fr.regions.map((r) => [r.qname, r]));
  expect(by.a.id).toBe('pkg/mod.py::a::definition#0');
  expect(by['C.m'].id).toBe('pkg/mod.py::C.m::definition#0');
  expect(by.a.sig).toBe('a(p, q=1) -> int');
  expect(by.b.sig).toBe('b()');
  expect(by.C.sig).toBe('C(Base)');
  expect(by.X.sig).toBeNull();
  const renamed = await regionize('pkg/mod.py', SRC.replace('def a(p, q=1)', 'def a2(p, q=1)'));
  const a2 = renamed.regions.find((r) => r.qname === 'a2')!;
  expect(a2.hash).not.toBe(by.a.hash);
  expect(a2.masked).toBe(by.a.masked);
  expect(fr.regions.every((r) => !/::\d|#\d+.*\d+:\d+/.test(r.id.replace(/#\d+$/, '')))).toBe(true);
});

test('python: duplicates get #n; nested classes recurse; class without members is one definition', async () => {
  const src = 'def f():\n    pass\n\ndef f():\n    pass\n\nclass E:\n    x = 1\n\nclass O:\n    class I:\n        def k(self):\n            pass\n';
  const fr = await regionize('d.py', src);
  expect(fr.regions.filter((r) => r.kind !== 'gap').map((r) => r.id)).toEqual([
    'd.py::f::definition#0', 'd.py::f::definition#1', 'd.py::E::definition#0',
    'd.py::O::container#0', 'd.py::O.I::container#0', 'd.py::O.I.k::definition#0',
  ]);
  expect(checkInvariants(fr)).toEqual([]);
});

test('python: two statements on one line never overlap (Review Focus 1)', async () => {
  const fr = await regionize('s.py', 'a = 1; b = 2\nc = 3\n');
  expect(checkInvariants(fr)).toEqual([]);
  expect(fr.regions.map((r) => r.qname)).toEqual(['a', 'c']);
  expect(fr.warnings.some((w) => w.startsWith('overlap: b'))).toBe(true);
});

test('python: deterministic, and an ERROR parse without a last clean map is one degraded file region', async () => {
  const a = await regionize('pkg/mod.py', SRC);
  const b = await regionize('pkg/mod.py', SRC);
  expect(b.regions).toEqual(a.regions);
  const bad = await regionize('pkg/mod.py', SRC.replace('def b():', 'def b(:'));
  expect(bad.degraded).toBe(true);
  expect(bad.regions.map((r) => r.id)).toEqual(['pkg/mod.py::file::file#0']);
});
