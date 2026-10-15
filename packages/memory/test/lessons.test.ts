import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { indexRepo } from '../src/indexrepo.js';
import { addLesson, lessonsFor } from '../src/lessons.js';
import { finishSession, readActive, startSession } from '../src/session.js';
import { closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const R = 'a.py::f::definition#0';

test('a lesson is a .loom event and a graph node ON the region; it only exists in its own repo graph (C1)', async () => {
  const r1 = repo({ 'a.py': 'def f():\n    return 1\n' }); ensureLoomDir(r1, CFG);
  const r2 = repo({ 'a.py': 'def f():\n    return 1\n' }); ensureLoomDir(r2, CFG);
  const g1 = await testGraph(); const g2 = await testGraph();
  await indexRepo(g1, r1); await indexRepo(g2, r2);
  await addLesson(g1, r1, null, R, 'run test_f after changing f', 'manual');
  expect((await lessonsFor(g1, [R])).map((l) => l.text)).toEqual(['run test_f after changing f']);
  expect(await lessonsFor(g2, [R])).toEqual([]);                    // same region id, other repo: nothing leaks
  expect(sh(r1, 'status', '--porcelain', '-uall')).toMatch(/\.loom\/sessions\//);
  await g1.drop(); await g2.drop();
});

test('startSession writes session+agent events and the active file; finishSession writes a handoff from the transcript and clears it', async () => {
  const r = repo({ 'a.py': 'def f():\n    return 1\n' }); ensureLoomDir(r, CFG); const g = await testGraph(); await indexRepo(g, r, { baseline: true });
  const { sid, briefing } = await startSession(g, r, { person: 'a@t', kind: 'interactive' });
  expect(readActive(r)).toMatchObject({ sid, writer: 'main' });
  expect(briefing).toMatch(/^\[loom\] Since your last sync/);
  const tp = join(r, '..', `t-${sid}.jsonl`);
  writeFileSync(tp, [JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done: f now returns 1. Left: tests.' }] } })].join('\n'));
  const out = await finishSession(g, r, { transcriptPath: tp });
  expect(out.uncommitted).toBe(true);
  expect(readActive(r)).toBeNull();
  const lines = readFileSync(join(r, `.loom/sessions/${sid}.main.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type)).toEqual(['session', 'agent', 'handoff']);
  expect(lines[2].summary).toBe('Done: f now returns 1. Left: tests.');
  const c = await finishSession(g, r, { commit: true });
  expect(c.uncommitted).toBe(false);
  expect(sh(r, 'log', '-1', '--format=%s')).toBe(`loom: session ${sid} records`);
  expect(sh(r, 'show', '--name-only', '--format=', 'HEAD').split('\n').every((f) => f.startsWith('.loom/'))).toBe(true);
  await g.drop();
});
