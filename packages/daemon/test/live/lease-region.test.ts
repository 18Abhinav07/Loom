import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { acquire, expired, holders, release } from '../../src/lease.js';

let db: LoomDb; let g: LoomGraph;
const R = ['a.py::f::definition#0', 'a.py::g::definition#0'];
beforeAll(async () => {
  db = await LoomDb.connect(); g = db.graph(`loom:test:lease-${process.pid}`);
  await g.query('UNWIND $r AS id CREATE (:Region {id: id, path: "a.py"})', { r: R });
  await g.query('UNWIND ["x","y"] AS a CREATE (:Agent {id: a})');
});
afterAll(async () => { await g.drop(); await db.close(); });

test('leases target Region nodes; write blocks write; contract blocks contract; expiry frees', async () => {
  expect(await acquire(g, 'x', [R[0]], 'write', 't1')).toBe(1);
  expect(await acquire(g, 'y', [R[0]], 'write', 't2')).toBe(0);
  expect((await holders(g, 'y', [R[0]], 'write')).map((h) => h.holder)).toEqual(['x']);
  expect(await acquire(g, 'y', [R[1]], 'contract', 't2')).toBe(1);
  expect(await acquire(g, 'x', [R[1]], 'contract', 't1')).toBe(0);
  expect((await expired(g, Date.now() + 11 * 60_000)).map((e) => e.symbol).sort()).toEqual([...R].sort());
  expect(await release(g, 'x')).toEqual([]);
});

test('an unknown label is refused (the label is interpolated into Cypher)', async () => {
  await expect(acquire(g, 'x', [R[0]], 'write', 't', Date.now(), 1000, 'Region) DETACH DELETE (s' as any)).rejects.toThrow(/label/);
});
