// P3 Task 2: Task/Decision/Commit nodes, why(), and the batched trace ledger (plan 03 Task 2).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { Coordinator } from '../src/coordinator.js';
import { TraceWriter } from '../src/trace.js';
import { renderWhy, why } from '../src/why.js';
import { git, gitTree } from './helpers.js';

const F = 'django/utils/text.py';
const SID = `${F}::phone2numeric`;
const TEXT = 'def phone2numeric(phone):\n    return phone.upper()\n\ndef other(x):\n    return x\n';
let db: LoomDb; let g: LoomGraph; let c: Coordinator; let wa: string;

beforeEach(async () => {
  db = await LoomDb.connect(); g = db.graph(`test:why:${Date.now()}:${Math.random()}`);
  const base = gitTree({ [F]: TEXT }); wa = gitTree({ [F]: TEXT });
  c = await Coordinator.create(g, 'r1');
  await c.indexBase(base, ['django']);
  await c.registerAgent('A', 'claude', wa);
  await c.checkCommit('A', wa);                 // first look records the base HEAD
});
afterEach(async () => { await g.drop(); await db.close(); });

const strictEdit = async () => {
  writeFileSync(join(wa, F), TEXT.replace('(phone):', '(phone, *, strict):'));
  await c.onEdit('A', wa, F);
};

test('2.1 decision → task → agent → change → commit', async () => {
  await c.claimTask('A', { id: 'T1', title: 'strict slugify' });
  await c.recordDecision('A', 'strict flag so callers choose', [SID]);
  await strictEdit();
  git(wa, 'commit', '-qam', 'strict phone2numeric');
  await c.checkCommit('A', wa);
  const r = await why(g, SID);
  expect(r.chains).toHaveLength(1);
  expect(r.chains[0]).toMatchObject({
    decision: { text: 'strict flag so callers choose', agent: 'A' }, task: { id: 'T1', title: 'strict slugify' }, agent: 'A',
    change: { kind: 'contract' }, commit: { sha: git(wa, 'rev-parse', 'HEAD').trim() },
  });
  expect(r.missing).toEqual([]);
  expect(renderWhy(r)).toContain('→ commit');
});

test('2.2 file:line resolves to the innermost symbol', async () => {
  await strictEdit();
  expect((await why(g, `${F}:2`)).symbol).toBe(SID);
  expect((await why(g, 'phone2numeric')).symbol).toBe(SID);
});

test('2.3 partial paths say what is missing and never throw', async () => {
  await strictEdit();
  const r = await why(g, SID);
  expect(r.chains[0]).toMatchObject({ agent: 'A', change: { kind: 'contract' } });
  expect(r.missing).toEqual(expect.arrayContaining(['decision', 'commit']));
  expect(renderWhy(r)).toContain('(no decision recorded)');
  const none = await why(g, `${F}::other`);
  expect(none).toMatchObject({ chains: [], missing: ['change'] });
  expect((await why(g, 'no/such.py:9')).missing).toEqual(['symbol']);
});

test('2.4 steps are flushed to the trace graph in order', async () => {
  const tg = db.graph(`${g.name}:trace`);
  const t = new TraceWriter(tg, 'r1');
  for (const tool of ['Read', 'Edit', 'Bash']) t.step('A', { tool, intent: 'x', symbols: [SID] });
  await t.close();
  const rows = await tg.query<{ seq: number }>(`MATCH (:Run {id: 'r1'})-[:HAS]->(s:Step) RETURN s.seq AS seq ORDER BY seq`);
  expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  await tg.drop();
});
