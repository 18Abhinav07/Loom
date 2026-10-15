import { expect, test } from 'vitest';
import { buildEdges, regionize } from '../../src/regions/index.js';

const files = async (fs: Record<string, string>) => Promise.all(Object.entries(fs).map(([p, t]) => regionize(p, t)));
const fmt = (es: ReturnType<typeof buildEdges>['edges']) => es.map((e) => `${e.kind} ${e.from.split('::').slice(0, 2).join('::')} -> ${e.to.split('::').slice(0, 2).join('::')} (${e.via})`).sort();

test('python: same-file, self., import (from/relative/module), unique-name, unresolved, TESTS, CONTAINS', async () => {
  const fs = await files({
    'pkg/__init__.py': '',
    'pkg/util.py': 'def helper():\n    return 1\n\n\ndef only_here():\n    return 2\n',
    'pkg/text.py': [
      'from .util import helper', 'import pkg.util', '', '',
      'def slug(v):', '    return helper() + pkg.util.helper() + only_here() + missing()', '', '',
      'class T:', '    def a(self):', '        return self.b()', '', '    def b(self):', '        return slug(1)', '',
    ].join('\n'),
    'tests/test_text.py': 'from pkg.text import slug\n\n\ndef test_slug():\n    assert slug(1)\n',
  });
  const { edges, unresolved } = buildEdges(fs);
  expect(fmt(edges)).toEqual([
    'CALLS pkg/text.py::T.a -> pkg/text.py::T.b (same_file)',
    'CALLS pkg/text.py::T.b -> pkg/text.py::slug (same_file)',
    'CALLS pkg/text.py::slug -> pkg/util.py::helper (import)',
    'CALLS pkg/text.py::slug -> pkg/util.py::only_here (unique_name)',
    'CALLS tests/test_text.py::test_slug -> pkg/text.py::slug (import)',
    'CONTAINS pkg/text.py::T -> pkg/text.py::T.a (same_file)',
    'CONTAINS pkg/text.py::T -> pkg/text.py::T.b (same_file)',
    'IMPORTS pkg/text.py::imports -> pkg/util.py::helper (import)',
    'IMPORTS tests/test_text.py::imports -> pkg/text.py::slug (import)',
    'TESTS tests/test_text.py::test_slug -> pkg/text.py::slug (import)',
  ]);
  expect(unresolved).toBe(1); // missing()
});

test('typescript: named and namespace imports, this., new, spec files', async () => {
  const fs = await files({
    'src/x.ts': 'export function a(n: number) { return n; }\nexport class Foo { constructor() {} }\n',
    'src/y.ts': "import { a as b } from './x';\nimport * as X from './x.js';\nexport function f() { return b(1) + X.a(2); }\nexport class K {\n  m() { return this.n(); }\n  n() { return new Foo(); }\n}\n",
    'src/y.spec.ts': "import { f } from './y';\nexport function t() { f(); }\n",
  });
  expect(fmt(buildEdges(fs).edges)).toEqual([
    'CALLS src/y.spec.ts::t -> src/y.ts::f (import)',
    'CALLS src/y.ts::K.m -> src/y.ts::K.n (same_file)',
    'CALLS src/y.ts::K.n -> src/x.ts::Foo (unique_name)',
    'CALLS src/y.ts::f -> src/x.ts::a (import)',
    'CONTAINS src/y.ts::K -> src/y.ts::K.m (same_file)',
    'CONTAINS src/y.ts::K -> src/y.ts::K.n (same_file)',
    'IMPORTS src/y.spec.ts::imports -> src/y.ts::f (import)',
    'IMPORTS src/y.ts::imports -> src/x.ts::a (import)',
    'TESTS src/y.spec.ts::t -> src/y.ts::f (import)',
  ]);
});
