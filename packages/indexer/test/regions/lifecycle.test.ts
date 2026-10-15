import { expect, test } from 'vitest';
import { diffRegions, regionize } from '../../src/regions/index.js';

const SRC = 'def a():\n    return 1\n\n\ndef b():\n    return 2\n';
const ids = async (s: string) => (await regionize('f.py', s)).regions;

test('body edit is an update only', async () => {
  expect(diffRegions(await ids(SRC), await ids(SRC.replace('return 1', 'return 10')))).toEqual({
    updated: ['f.py::a::definition#0'], created: [], tombstoned: [], renamed: [] });
});

test('a pure rename is detected with its trailing gap; history continues', async () => {
  const d = diffRegions(await ids(SRC), await ids(SRC.replace('def a()', 'def a2()')));
  expect(d.renamed).toEqual([
    { from: 'f.py::a::definition#0', to: 'f.py::a2::definition#0' },
    { from: 'f.py::gap@after:a::gap#0', to: 'f.py::gap@after:a2::gap#0' },
  ]);
  expect([d.created, d.tombstoned, d.updated]).toEqual([[], [], []]);
});

test('rename plus a body change is delete + create (exact match only)', async () => {
  const d = diffRegions(await ids(SRC), await ids(SRC.replace('def a():\n    return 1', 'def a2():\n    return 9')));
  expect(d.renamed).toEqual([{ from: 'f.py::gap@after:a::gap#0', to: 'f.py::gap@after:a2::gap#0' }].filter(() => false));
  expect(d.created).toContain('f.py::a2::definition#0');
  expect(d.tombstoned).toContain('f.py::a::definition#0');
});

test('two candidates with the same masked hash: no rename', async () => {
  const two = 'def p():\n    pass\n\n\ndef q():\n    pass\n';
  const d = diffRegions(await ids(two), await ids(two.replace('def p', 'def r').replace('def q', 'def s')));
  expect(d.renamed.filter((r) => !r.from.includes('gap@'))).toEqual([]);
  expect(d.created).toEqual(expect.arrayContaining(['f.py::r::definition#0', 'f.py::s::definition#0']));
});

test('new and removed functions', async () => {
  const d = diffRegions(await ids(SRC), await ids(`${SRC}\n\ndef c():\n    return 3\n`));
  expect(d.created).toEqual(['f.py::gap@after:b::gap#0', 'f.py::c::definition#0']);
  const e = diffRegions(await ids(SRC), await ids('def a():\n    return 1\n'));
  expect(e.tombstoned).toEqual(['f.py::gap@after:a::gap#0', 'f.py::b::definition#0']);
});
