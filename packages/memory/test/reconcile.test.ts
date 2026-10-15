import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { indexRepo } from '../src/indexrepo.js';
import { importSessions } from '../src/importer.js';
import { reconcile } from '../src/reconcile.js';
import { as, closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const SRC = 'def f():\n    return 1\n\ndef g():\n    return 2\n';

test('a commit made outside Loom becomes an external Version BY the git author; idempotent', async () => {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true }); const base = sh(r, 'rev-parse', 'HEAD');
  writeFileSync(join(r, 'a.py'), SRC.replace('return 2', 'return 9')); as('bob')(r, 'commit', '-qam', 'bob edits g', '--no-verify');
  const c = sh(r, 'rev-parse', 'HEAD');
  expect(await reconcile(g, r, base, 'HEAD')).toMatchObject({ commits: 1, versions: 1, capped: false });
  expect(await reconcile(g, r, base, 'HEAD')).toMatchObject({ versions: 0 });
  expect(await g.query(`MATCH (v:Version {id: $id, external: true})-[:BY]->(:Person {id: 'bob@t'}) MATCH (v)-[:OF]->(:Region {id: 'a.py::g::definition#0'}) RETURN 1`,
    { id: `ext:${c}:a.py::g::definition#0` })).toHaveLength(1);
  await g.drop();
});

test('a region already versioned by a .loom event in that commit gets no external version', async () => {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true }); const base = sh(r, 'rev-parse', 'HEAD');
  const { appendEvent } = await import('../src/events.js'); const { ulid } = await import('../src/ids.js');
  writeFileSync(join(r, 'a.py'), SRC.replace('return 2', 'return 9'));
  appendEvent(r, ulid(), 'main', { type: 'version', region: 'a.py::g::definition#0', hash: 'h', sig: 'g()', deleted: false, degraded: false, prev: [], by: 'main', task: null });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'loom edit');
  await importSessions(g, r, null);
  expect((await reconcile(g, r, base, 'HEAD')).versions).toBe(0);
  await g.drop();
});

test('past the cap: one external version per region for the whole range, by "N authors"', async () => {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true }); const base = sh(r, 'rev-parse', 'HEAD');
  for (let i = 0; i < 5; i++) { writeFileSync(join(r, 'a.py'), SRC.replace('return 1', `return ${i + 10}`)); as(i % 2 ? 'x' : 'y')(r, 'commit', '-qam', `c${i}`); }
  const out = await reconcile(g, r, base, 'HEAD', 3);
  expect(out).toMatchObject({ capped: true, versions: 1 });
  expect(await g.query(`MATCH (v:Version {external: true, range: true})-[:BY]->(p:Person {id: '2 authors'}) RETURN 1`)).toHaveLength(1);
  await g.drop();
});
