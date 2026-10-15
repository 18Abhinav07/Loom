import { expect, test } from 'vitest';
import { gitMergeFile, regionMerge } from '../../src/regions/index.js';

const BASE = 'def a():\n    return 1\ndef b():\n    return 2\n';

test('adjacent edits in two functions: git conflicts, regionMerge merges exactly', async () => {
  const ours = BASE.replace('return 1', 'return 10');
  const theirs = BASE.replace('def b():', 'def b(x=0):');
  expect(gitMergeFile(BASE, ours, theirs).clean).toBe(false);
  expect(await regionMerge('m.py', BASE, ours, theirs)).toEqual({ status: 'merged', text: 'def a():\n    return 10\ndef b(x=0):\n    return 2\n' });
});

test('one blank line apart, git already merges (scope of the claim)', () => {
  const base = 'def a():\n    return 1\n\ndef b():\n    return 2\n';
  expect(gitMergeFile(base, base.replace('return 1', 'return 10'), base.replace('def b():', 'def b(x=0):')).clean).toBe(true);
});

test('same region changed differently on the same lines: conflict on that region', async () => {
  const r = await regionMerge('m.py', BASE, BASE.replace('return 1', 'return 10'), BASE.replace('return 1', 'return 11'));
  expect(r).toEqual({ status: 'conflict', regions: [{ id: 'm.py::a::definition#0', kind: 'text' }] });
});

test('imports are union-merged', async () => {
  const base = 'import os\n\n\ndef a():\n    return 1\n';
  const r = await regionMerge('m.py', base, base.replace('import os\n', 'import os\nimport re\n'), base.replace('import os\n', 'import os\nimport sys\n'));
  expect(r).toEqual({ status: 'merged', text: 'import os\nimport re\nimport sys\n\n\ndef a():\n    return 1\n' });
});

test('delete vs modify is a kind-D conflict', async () => {
  const base = 'def a():\n    return 1\n\n\ndef b():\n    return 2\n';
  const r = await regionMerge('m.py', base, 'def a():\n    return 1\n', base.replace('return 2', 'return 20'));
  expect(r.status).toBe('conflict');
  expect((r as { regions: unknown[] }).regions).toContainEqual({ id: 'm.py::b::definition#0', kind: 'delete' });
});

test('both sides append a function at the end: both kept, theirs placed after its predecessor (Review Focus 5)', async () => {
  const base = 'def a():\n    return 1\n';
  const r = await regionMerge('m.py', base, `${base}\n\ndef x():\n    return 2\n`, `${base}\n\ndef y():\n    return 3\n`);
  expect(r.status).toBe('merged');
  const t = (r as { text: string }).text;
  expect(t).toContain('def x():');
  expect(t).toContain('def y():');
});

test('degraded side → unsupported', async () => {
  expect((await regionMerge('m.py', BASE, 'def a(:\n', BASE)).status).toBe('unsupported');
});
