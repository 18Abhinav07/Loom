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
