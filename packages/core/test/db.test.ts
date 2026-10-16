import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, ensureSchema, type LoomGraph } from '../src/index.js';

let db: LoomDb; let g: LoomGraph;
beforeAll(async () => { db = await LoomDb.connect(); g = db.graph(`test:core:${Date.now()}`); await ensureSchema(g); });
afterAll(async () => { await g.drop(); await db.close(); });

test('parameterized write and read round-trip', async () => {
  await g.query('UNWIND $rows AS r MERGE (s:Symbol {id: r.id}) SET s.name = r.name', { rows: [{ id: 'a.py::f', name: 'f' }] });
  const rows = await g.query<{ name: string }>('MATCH (s:Symbol {id: $id}) RETURN s.name AS name', { id: 'a.py::f' });
  expect(rows).toEqual([{ name: 'f' }]);
});

test('ensureSchema is idempotent', async () => { await ensureSchema(g); });

test('a database number in the URL selects a separate keyspace: a graph in /2 is not listed in /3', async () => {
  const [a, b] = [await LoomDb.connect('redis://127.0.0.1:6379/2'), await LoomDb.connect('redis://127.0.0.1:6379/3')];
  const name = `test:dbsel:${Date.now()}`;
  await a.graph(name).query('CREATE (:X)');
  try {
    expect(await a.list()).toContain(name);
    expect(await b.list()).not.toContain(name);
  } finally { await a.graph(name).drop(); await a.close(); await b.close(); }
});
