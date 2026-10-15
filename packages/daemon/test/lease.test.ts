import { afterEach, beforeEach, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { acquire, expired, holders, release, renew } from '../src/lease.js';

let db: LoomDb; let g: LoomGraph;
beforeEach(async () => {
  db = await LoomDb.connect(); g = db.graph(`test:lease:${Date.now()}:${Math.random()}`);
  await g.query(`UNWIND ['A','B','C'] AS id CREATE (:Agent {id: id})`);
  await g.query(`UNWIND ['a','b'] AS id CREATE (:Symbol {id: id})`);
});
afterEach(async () => { await g.drop(); await db.close(); });

test('spec 5.2 outcomes, all-or-nothing, matrix', async () => {
  expect(await acquire(g, 'B', ['a'], 'contract', 't')).toBe(1);
  expect(await acquire(g, 'C', ['a'], 'contract', 't')).toBe(0);           // contract vs contract
  expect(await acquire(g, 'C', ['a'], 'write', 't')).toBe(1);              // body-only write vs contract: allowed
  expect(await acquire(g, 'A', ['a'], 'write', 't')).toBe(0);              // write vs C's write
  expect(await acquire(g, 'C', ['b'], 'write', 't')).toBe(1);
  expect(await acquire(g, 'B', ['a', 'b'], 'contract', 't')).toBe(0);      // b held by C: nothing written
  const [r] = await g.query<{ n: number }>(`MATCH (:Agent {id:'B'})-[l:LEASED]->(:Symbol {id:'b'}) RETURN count(l) AS n`);
  expect(r.n).toBe(0);
  expect(await acquire(g, 'B', ['a'], 'contract', 't')).toBe(1);           // a body write admitted under B's contract never locks B out of it
  expect(await acquire(g, 'A', ['a'], 'contract', 't')).toBe(0);           // ...but still blocks a contract B does not hold
  await release(g, 'C', ['a']);
  expect(await acquire(g, 'B', ['a', 'zz'], 'contract', 't')).toBe(0);     // unknown symbol denies all
  const h = await holders(g, 'A', ['a'], 'contract');
  expect(h.map((x) => x.holder)).toEqual(['B']);
});

test('mode is sticky: a body edit after a contract keeps the contract flag', async () => {
  await acquire(g, 'B', ['a'], 'contract', 't');
  await acquire(g, 'B', ['a'], 'write', 't');
  const [r] = await g.query<{ mode: string; contract: boolean }>(`MATCH (:Agent {id:'B'})-[l:LEASED]->() RETURN l.mode AS mode, l.contract AS contract`);
  expect(r).toEqual({ mode: 'write', contract: true });
  expect(await acquire(g, 'C', ['a'], 'write', 't')).toBe(0);
});

test('expiry, renew and release', async () => {
  const t = 1_000_000;
  await acquire(g, 'B', ['a'], 'contract', 't', t);
  expect(await acquire(g, 'C', ['a'], 'contract', 't', t + 11 * 60_000)).toBe(1);   // B lapsed
  await renew(g, 'C', t + 20 * 60_000);
  expect((await expired(g, t + 25 * 60_000)).filter((x) => x.agent === 'C')).toEqual([]);
  expect(await expired(g, t + 31 * 60_000)).toEqual([{ agent: 'C', symbol: 'a', contract: true }]);
  await acquire(g, 'B', ['a', 'b'], 'write', 't');
  expect((await release(g, 'B', ['b'])).sort()).toEqual(['b']);
  expect(await release(g, 'B')).toEqual(['a']);
});
