import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { indexRepo } from '../src/indexrepo.js';
import { closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: ['node_modules', '.venv', 'dist', 'build', '.git'], testCmd: null, share: true };
const FILES = {
  'pkg/text.py': 'import re\n\ndef slugify(v):\n    return re.sub("x", "", v)\n\ndef title(v):\n    return slugify(v).title()\n',
  'tests/test_text.py': 'from pkg.text import slugify\n\ndef test_slugify():\n    assert slugify("a") == "a"\n',
  'node_modules/x.js': 'function nope() {}\n',
};

test('indexRepo writes Regions, CODE edges, the lock, and one baseline Version per region at HEAD', async () => {
  const r = repo(FILES); ensureLoomDir(r, CFG); const g = await testGraph();
  const s = await indexRepo(g, r, { baseline: true });
  expect(s).toMatchObject({ files: 2, reparsed: 2, degraded: [] });
  const [{ n }] = await g.query<{ n: number }>('MATCH (r:Region) RETURN count(r) AS n');
  expect(n).toBe(s.regions);
  const calls = await g.query<{ a: string; b: string }>('MATCH (a:Region)-[:CALLS]->(b:Region) RETURN a.qname AS a, b.qname AS b ORDER BY a');
  expect(calls).toContainEqual({ a: 'title', b: 'slugify' });
  expect(await g.query('MATCH (:Region {qname: "test_slugify"})-[:TESTS]->(:Region {qname: "slugify"}) RETURN 1')).toHaveLength(1);
  const head = sh(r, 'rev-parse', 'HEAD');
  const [{ v }] = await g.query<{ v: number }>('MATCH (r:Region)-[:HEAD]->(x:Version {external: true}) WHERE $h IN x.commits RETURN count(x) AS v', { h: head });
  expect(v).toBe(s.regions);
  expect(readFileSync(join(r, '.loom/regions.lock'), 'utf8')).toMatch(/pkg\/text\.py/);
  await g.drop();
});

test('second run with an unchanged lock reparses nothing; one edited file reparses one and keeps ids', async () => {
  const r = repo(FILES); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true });
  expect((await indexRepo(g, r)).reparsed).toBe(0);
  writeFileSync(join(r, 'pkg/text.py'), FILES['pkg/text.py'].replace('"x"', '"y"'));
  const s = await indexRepo(g, r);
  expect(s.reparsed).toBe(1);
  const ids = await g.query<{ id: string }>('MATCH (r:Region {path: "pkg/text.py"}) WHERE NOT coalesce(r.tombstoned, false) RETURN r.id AS id ORDER BY id');
  expect(ids.map((x) => x.id)).toContain('pkg/text.py::slugify::definition#0');
  await g.drop();
});

test('a deleted function is tombstoned, not deleted; a pure rename gets RENAMED_FROM', async () => {
  const r = repo(FILES); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true });
  writeFileSync(join(r, 'pkg/text.py'), 'import re\n\ndef slugify2(v):\n    return re.sub("x", "", v)\n');
  await indexRepo(g, r);
  const [t] = await g.query<{ tomb: boolean }>('MATCH (r:Region {qname: "title"}) RETURN r.tombstoned AS tomb');
  expect(t.tomb).toBe(true);
  expect(await g.query('MATCH (:Region {qname: "slugify2"})-[:RENAMED_FROM]->(:Region {qname: "slugify"}) RETURN 1')).toHaveLength(1);
  await g.drop();
});
