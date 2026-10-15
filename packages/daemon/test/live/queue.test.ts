// R6.1: the merge queue moves the landed branch only for work that merges and passes its tests; landed never moves otherwise.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { landOne, MergeQueue } from '../../src/live/queue.js';
import { git, gitTree } from '../helpers.js';

const A_PY = 'def f(x):\n    return x\n\n\ndef g():\n    return 0\n';
let db: LoomDb; let g: LoomGraph;
beforeAll(async () => { db = await LoomDb.connect(); g = db.graph(`qt-${Date.now()}`); });
afterAll(async () => { await g.drop().catch(() => {}); await db.close(); });

function repo() {
  const r = gitTree({ 'a.py': A_PY });
  git(r, 'branch', 'landed');
  const wt = (id: string) => { const w = mkdtempSync(join(tmpdir(), `q-${id}-`)); git(r, 'worktree', 'add', '-q', '-b', id, w); return w; };
  return { r, x: wt('x'), y: wt('y') };
}
const job = (r: string, wt: string, agent: string, testCmd: string | null = null) => ({ repo: r, wt, landed: 'landed', agent, title: agent, testCmd, g });
const rev = (r: string) => git(r, 'rev-parse', 'landed').trim();

test('same line changed two ways: the second lands as conflict, landed keeps the first', async () => {
  const { r, x, y } = repo();
  writeFileSync(join(x, 'a.py'), A_PY.replace('return x', 'return x + 1'));
  writeFileSync(join(y, 'a.py'), A_PY.replace('return x', 'return x * 2'));
  const a = await landOne(job(r, x, 'x'));
  expect(a).toMatchObject({ status: 'landed', regions: ['a.py::f::definition#0'] });
  const b = await landOne(job(r, y, 'y'));
  expect(b.status).toBe('conflict');
  expect(rev(r)).toBe(a.sha);
  expect(git(y, 'status', '--porcelain').trim()).toBe('');   // the failed merge was aborted; y keeps its commit
});

test('failing tests: tests_failed with the output tail, landed does not move; different regions of one file both land', async () => {
  const { r, x, y } = repo();
  const before = rev(r);
  writeFileSync(join(x, 'a.py'), A_PY.replace('return 0', 'return 1'));
  const t = await landOne(job(r, x, 'x', 'echo boom-from-tests; exit 1'));
  expect(t.status).toBe('tests_failed');
  expect(t.tail).toContain('boom-from-tests');
  expect(rev(r)).toBe(before);
  const q = new MergeQueue();
  writeFileSync(join(y, 'a.py'), A_PY.replace('return x', 'return x + 1'));
  const [ax, ay] = await Promise.all([q.enqueue(() => landOne(job(r, x, 'x', 'true'))), q.enqueue(() => landOne(job(r, y, 'y', 'true')))]);
  expect([ax.status, ay.status]).toEqual(['landed', 'landed']);
  const final = git(r, 'show', 'landed:a.py');
  expect(final).toContain('return x + 1');
  expect(final).toContain('return 1');
});
