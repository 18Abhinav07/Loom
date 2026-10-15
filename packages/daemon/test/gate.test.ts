import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { Coordinator } from '../src/coordinator.js';
import { Lessons } from '../src/lessons.js';
import { git, gitTree } from './helpers.js';

const F = 'django/utils/text.py';
const TEXT = 'def phone2numeric(phone):\n    return phone.upper()\n\ndef other(x):\n    return x\n';
const BTEXT = TEXT + '\ndef dial(n):\n    return phone2numeric(n)\n\ndef twice(x):\n    return other(x) * 2\n';
let db: LoomDb; let g: LoomGraph; let c: Coordinator; let wa: string; let wb: string; let L: Lessons;

const statuses = async (agent: string) =>
  (await g.query<{ s: string }>(`MATCH (n:Notice {agent: $agent}) RETURN n.status AS s ORDER BY n.at`, { agent })).map((r) => r.s);
const editA = async (text: string) => {
  writeFileSync(join(wa, F), text);
  await c.onEdit('A', wa, F);
};
const editB = async (text: string) => {
  writeFileSync(join(wb, F), text);
  await c.onEdit('B', wb, F);
};
const STRICT = TEXT.replace('(phone):', '(phone, *, strict):');

beforeEach(async () => {
  db = await LoomDb.connect(); g = db.graph(`test:gate:${Date.now()}:${Math.random()}`);
  const base = gitTree({ [F]: TEXT }); wa = gitTree({ [F]: TEXT }); wb = gitTree({ [F]: TEXT });
  L = new Lessons(db.graph(`test:lessons:${Date.now()}:${Math.random()}`));
  c = await Coordinator.create(g, 'r1', undefined, L);
  await c.indexBase(base, ['django']);
  await c.registerAgent('A', 'claude', wa); await c.registerAgent('B', 'claude', wb);
});
afterEach(async () => { await g.drop(); await L.g.drop().catch(() => {}); await db.close(); });

test('4.1 contract notice resolves when B fixes the call; stays open when B edits but the call is still stale', async () => {
  await editB(BTEXT);
  await c.preEdit('A', wa, { file: F, edits: [{ old: '(phone):', new: '(phone, *, strict):' }] });
  await editA(STRICT);
  expect(await c.takeNotices('B')).toHaveLength(1);
  await editB(BTEXT.replace('return phone2numeric(n)', 'return phone2numeric(n).strip()'));
  expect(await statuses('B')).toEqual(['delivered']);
  await editB(BTEXT.replace('return phone2numeric(n)', 'return phone2numeric(n, strict=False)'));
  expect(await statuses('B')).toEqual(['resolved']);
});

test('4.2 removed resolves when B no longer calls the old name; behavior resolves only when B edits a caller of it', async () => {
  await editB(BTEXT);
  await editA(TEXT.replace('def phone2numeric', 'def phone2numeric_v2').replace('return x\n', 'return x.strip()\n'));
  const got = await c.takeNotices('B');
  expect(got.map((n) => n.text.split(' ')[4]).sort()).toEqual(['other', 'phone2numeric']);
  await editB(BTEXT.replace('return phone2numeric(n)', 'return phone2numeric_v2(n)'));
  const kinds = async () => (await g.query<{ q: string; s: string }>(`MATCH (n:Notice {agent: 'B'}) MATCH (ch:Change) WHERE ch.id = n.change
    MATCH (ch)-[:OF]->(s:Symbol) RETURN s.qname AS q, n.status AS s ORDER BY q`)).map((r) => `${r.q}:${r.s}`);
  expect(await kinds()).toEqual(['other:delivered', 'phone2numeric:resolved']);   // dial does not call other
  await editB(BTEXT.replace('return phone2numeric(n)', 'return phone2numeric_v2(n)').replace('return other(x) * 2', 'return other(x).upper() * 2'));
  expect(await kinds()).toEqual(['other:resolved', 'phone2numeric:resolved']);
});

test('4.3 Stop: an unresolved notice blocks once, the next Stop acknowledges it and allows', async () => {
  await editB(BTEXT);                                                      // B's dial() calls phone2numeric(n): will not fit strict
  await editA(STRICT);
  const g1 = await c.stopGate('B', false);
  expect(g1).toMatchObject({ block: true, rule: 'notices' });
  expect(g1.block && g1.reason).toContain('changed phone2numeric');
  expect(await c.stopGate('B', true)).toEqual({ block: false });
  expect(await statuses('B')).toEqual(['acknowledged']);

  const FIXED = BTEXT.replace('return phone2numeric(n)', 'return phone2numeric(n, strict=False)');
  await editB(FIXED);                                                      // T1: the blocked notice resolves by edit → a lesson
  expect(await statuses('B')).toEqual(['resolved']);
  const [l] = await L.about([`${F}::phone2numeric`]);
  expect(l).toMatchObject({ id: `T1:${F}::phone2numeric`, hits: 1 });
  expect(l.text).toBe('Callers of phone2numeric must use `def phone2numeric(phone, *, strict)` (was `def phone2numeric(phone)`); B missed this until blocked.');

  const g2 = db.graph(`test:gate2:${Date.now()}`);                         // same cycle, fresh run: the lesson is hit again
  try {
    c = await Coordinator.create(g2, 'r1b', undefined, L);
    await c.indexBase(gitTree({ [F]: TEXT }), ['django']);
    wa = gitTree({ [F]: TEXT }); wb = gitTree({ [F]: TEXT });
    await c.registerAgent('A', 'claude', wa); await c.registerAgent('B', 'claude', wb);
    await editB(BTEXT); await editA(STRICT);
    expect(await c.stopGate('B', false)).toMatchObject({ block: true });
    await editB(FIXED);
    expect((await L.about([`${F}::phone2numeric`]))[0].hits).toBe(2);
  } finally { await g2.drop(); }
});

test('4.3b Stop: a reader with no calls into the changed symbol is resolved at Stop, not blocked', async () => {
  await c.onRead('B', F);
  await editA(STRICT);
  await c.takeNotices('B');                                                // delivered mid-turn
  expect(await c.stopGate('B', false)).toEqual({ block: false });
  expect(await statuses('B')).toEqual(['resolved']);
});

test('4.4 barrier: A holds a contract lease on what B depends on → block once, then allow; A commit wakes B once', async () => {
  await c.checkCommit('A', wa);                                            // records A's HEAD
  await c.onRead('B', F);
  await c.preEdit('A', wa, { file: F, edits: [{ old: '(phone):', new: '(phone, *, strict):' }] });
  const s1 = await c.stopGate('B', false);
  expect(s1).toMatchObject({ block: true, rule: 'barrier' });
  expect(s1.block && s1.reason).toContain('agent A');
  expect(await c.stopGate('B', true)).toEqual({ block: false });          // rule 1: the barrier let go
  expect(await c.stopGate('B', false)).toEqual({ block: false });         // once per symbol
  await editA(STRICT);
  git(wa, 'commit', '-qam', 'strict');
  await c.checkCommit('A', wa);
  const ns = await c.takeNotices('B');
  const wake = ns.filter((n) => n.text.includes('has landed'));
  expect(wake).toHaveLength(1);
  expect(wake[0].text).toContain('def phone2numeric(phone, *, strict)');
  await c.checkCommit('A', wa);
  expect(await c.takeNotices('B')).toEqual([]);
});

test('4.5 lease lapse wakes the waiter too (sweep)', async () => {
  await c.onRead('B', F);
  await c.preEdit('A', wa, { file: F, edits: [{ old: '(phone):', new: '(phone, *, strict):' }] });
  expect(await c.stopGate('B', false)).toMatchObject({ block: true, rule: 'barrier' });
  await c.sweep(Date.now() + 11 * 60_000);
  const [n] = await c.takeNotices('B');
  expect(n.text).toContain('lease on phone2numeric lapsed');
});

test('4.6 shared cap: the 4th blocking Stop in one task is allowed and recorded as escalated', async () => {
  const FOUR = 'def f1(a):\n    pass\n\ndef f2(a):\n    pass\n\ndef f3(a):\n    pass\n\ndef f4(a):\n    pass\n';
  const base = gitTree({ [F]: FOUR });
  c = await Coordinator.create(g, 'r2');
  await c.indexBase(base, ['django']);
  writeFileSync(join(wa, F), FOUR);
  await c.onRead('B', F);
  let a = FOUR;
  const results = [];
  for (const f of ['f1', 'f2', 'f3', 'f4']) {
    a = a.replace(`def ${f}(a):`, `def ${f}(a, *, strict):`);
    await editA(a);
    results.push((await c.stopGate('B', false)).block);
  }
  expect(results).toEqual([true, true, true, false]);
  expect((await c.status()).events.filter((e) => e.type === 'gate.escalated')).toHaveLength(1);
});
