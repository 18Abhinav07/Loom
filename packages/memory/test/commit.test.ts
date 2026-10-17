import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { parseEvents, sessionFile } from '../src/events.js';
import { ulid } from '../src/ids.js';
import { indexRepo } from '../src/indexrepo.js';
import { postCommit, preCommit } from '../src/commit.js';
import { activeSession, writeActive } from '../src/session.js';
import { closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const SRC = 'def f():\n    return 1\n\ndef g():\n    return 2\n';

async function setup() {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG);
  const g = await testGraph(); await indexRepo(g, r, { baseline: true });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'loom init');
  const sid = ulid(); writeActive(r, { sid, writer: 'main', by: 'main', task: 'T1' });
  return { r, g, sid };
}
const events = (r: string, sid: string) => parseEvents(readFileSync(join(r, sessionFile(r, sid, 'main')), 'utf8').split('\n')).events;

test('pre-commit versions the INDEX text (partial staging), stages the session file and the lock', async () => {
  const { r, g, sid } = await setup();
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 10'));
  sh(r, 'add', 'a.py');
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 10').replace('return 2', 'return 20'));   // unstaged
  const out = await preCommit(r, g);
  expect(out.versions).toBe(1);
  const [v] = events(r, sid).filter((e) => e.type === 'version');
  expect(v).toMatchObject({ region: 'a.py::f::definition#0', by: 'main', task: 'T1', deleted: false });
  expect(v.prev).toEqual([(await g.query<{ id: string }>(`MATCH (:Region {id: 'a.py::f::definition#0'})-[:HEAD]->(v) RETURN v.id AS id`))[0].id]);
  const staged = sh(r, 'diff', '--cached', '--name-only').split('\n');
  expect(staged).toEqual(expect.arrayContaining(['.loom/regions.lock', sessionFile(r, sid, 'main'), 'a.py']));
  await g.drop();
});

test('real commit through installed hooks: post-commit links versions to the Commit and moves HEAD', async () => {
  const { r, g, sid } = await setup();
  writeFileSync(join(r, 'a.py'), SRC.replace('return 2', 'return 3'));
  sh(r, 'add', 'a.py'); await preCommit(r, g); sh(r, 'commit', '-qm', 'edit g'); await postCommit(r, g);
  const head = sh(r, 'rev-parse', 'HEAD');
  const [row] = await g.query<{ id: string; c: string[] }>(`MATCH (:Region {id: 'a.py::g::definition#0'})-[:HEAD]->(v)-[:IN]->(:Commit {sha: $head})
    RETURN v.id AS id, v.commits AS c`, { head });
  expect(row.id).toBe(events(r, sid).find((e) => e.type === 'version')!.id);
  await g.drop();
});

test('graph down (g = null): pre-commit still writes version events (prev empty) and exits cleanly', async () => {
  const { r, sid } = await setup();
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 5')); sh(r, 'add', 'a.py');
  expect((await preCommit(r, null)).versions).toBe(1);
  expect(events(r, sid).find((e) => e.type === 'version')!.prev).toEqual([]);
});

test('no active session → pre-commit writes nothing (the commit is reconciled as external at sync)', async () => {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG); const g = await testGraph(); await indexRepo(g, r, { baseline: true });
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 5')); sh(r, 'add', 'a.py');
  expect((await preCommit(r, g)).versions).toBe(0);
  await g.drop();
});

test('deleting a function writes deleted:true; a pure rename writes renamed_from', async () => {
  const { r, g, sid } = await setup();
  writeFileSync(join(r, 'a.py'), 'def f2():\n    return 1\n'); sh(r, 'add', 'a.py');
  await preCommit(r, g);
  const vs = events(r, sid).filter((e) => e.type === 'version');
  expect(vs).toContainEqual(expect.objectContaining({ region: 'a.py::g::definition#0', deleted: true }));
  expect(vs).toContainEqual(expect.objectContaining({ region: 'a.py::f2::definition#0', renamed_from: 'a.py::f::definition#0' }));
  await g.drop();
});

test('the lock records the real staged blob sha (bytes untouched, trailing newline kept)', async () => {
  const { r, g } = await setup();
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 7')); sh(r, 'add', 'a.py');
  await preCommit(r, g);
  expect(readFileSync(join(r, '.loom/regions.lock'), 'utf8')).toContain(sh(r, 'rev-parse', ':a.py'));
  await g.drop();
});

// Final review I5: two sessions in one checkout. A commit is credited to the session whose claude process is an ancestor of the
// committing process, not to whichever session started last.
test('pre-commit picks the active session whose recorded pids are nearest ancestors of the committer', async () => {
  const { r, g } = await setup();
  const a = ulid(), b = ulid();
  writeActive(r, { sid: a, writer: 'lead', by: 'lead', task: null, claude: 'A', pids: [process.pid, 1] }, 'A');
  await new Promise((ok) => setTimeout(ok, 20));
  writeActive(r, { sid: b, writer: 'main', by: 'main', task: null, claude: 'B', pids: [999_999, 1] }, 'B');   // started later
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 11')); sh(r, 'add', 'a.py');
  expect((await preCommit(r, g)).versions).toBe(1);
  const lead = parseEvents(readFileSync(join(r, sessionFile(r, a, 'lead')), 'utf8').split('\n')).events;
  expect(lead.filter((e) => e.type === 'version')).toHaveLength(1);
});

test('activeSession with ancestors: nearest match wins; a shared far ancestor (the terminal app) does not decide it', () => {
  const r = repo({ 'x.py': 'x = 1\n' });
  writeActive(r, { sid: 'S1', writer: 'lead', by: 'lead', task: null, claude: 'A', pids: [100, 50, 7] }, 'A');
  writeActive(r, { sid: 'S2', writer: 'main', by: 'main', task: null, claude: 'B', pids: [200, 60, 7] }, 'B');
  expect(activeSession(r, null, [900, 100, 50, 7])?.sid).toBe('S1');
  expect(activeSession(r, null, [900, 60, 7])?.sid).toBe('S2');
});
