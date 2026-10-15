import { afterAll, expect, test } from 'vitest';
import { currentVersion } from '../src/versions.js';
import { closeDb, repo, sh, testGraph, write } from './helpers.js';

afterAll(closeDb);

test('currentVersion follows a moving ref (a fetch moves origin/main; the answer must move with it)', async () => {
  const r = repo({ 'a.py': 'x = 1\n' }); const c1 = sh(r, 'rev-parse', 'HEAD');
  write(r, { 'a.py': 'x = 2\n' }); sh(r, 'commit', '-qam', 'two'); const c2 = sh(r, 'rev-parse', 'HEAD');
  sh(r, 'branch', 'up', c1);
  const g = await testGraph();
  await g.query(`CREATE (rg:Region {id: 'R'}), (:Version {id: 'v1', at: 1, commits: [$c1]})-[:OF]->(rg), (:Version {id: 'v2', at: 2, commits: [$c2]})-[:OF]->(rg)`, { c1, c2 });
  expect(await currentVersion(g, r, 'R', 'up')).toBe('v1');
  sh(r, 'branch', '-f', 'up', c2);
  expect(await currentVersion(g, r, 'R', 'up')).toBe('v2');
  await g.drop();
});
