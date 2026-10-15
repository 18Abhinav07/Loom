import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { Coordinator } from '../src/coordinator.js';
import { git, gitTree } from './helpers.js';

const F = 'django/utils/text.py';
const TEXT = 'def phone2numeric(phone):\n    return phone.upper()\n\ndef other(x):\n    return x\n';
let db: LoomDb; let g: LoomGraph; let c: Coordinator; let wa: string;

beforeEach(async () => {
  db = await LoomDb.connect(); g = db.graph(`test:life:${Date.now()}:${Math.random()}`);
  const base = gitTree({ [F]: TEXT }); wa = gitTree({ [F]: TEXT });
  c = await Coordinator.create(g, 'r1');
  await c.indexBase(base, ['django']);
});
afterEach(async () => { await g.drop(); await db.close(); });

test('implicit task from first prompt; status shows idle after 90 s; commit lands A contract and releases', async () => {
  await c.touch('A', wa, { hook_event_name: 'UserPromptSubmit', cwd: wa, session_id: 'sA', prompt: 'add strict to phone2numeric' });
  await c.touch('A', wa, { hook_event_name: 'UserPromptSubmit', cwd: wa, session_id: 'sA', prompt: 'second prompt' });
  let s = await c.status();
  expect(s.agents.find((a) => a.id === 'A')).toMatchObject({ task: 'implicit:sA', taskTitle: 'add strict to phone2numeric', state: 'active' });
  expect((await c.status(Date.now() + 91_000)).agents.find((a) => a.id === 'A')!.state).toBe('idle');

  await c.preEdit('A', wa, { file: F, edits: [{ old: '(phone):', new: '(phone, *, strict):' }] });
  writeFileSync(join(wa, F), TEXT.replace('(phone):', '(phone, *, strict):'));
  await c.onEdit('A', wa, F);
  s = await c.status();
  expect(s.leases).toEqual([expect.objectContaining({ agent: 'A', symbol: `${F}::phone2numeric`, contract: true })]);
  expect(await c.checkCommit('A', wa)).toEqual([]);                        // first call records HEAD
  git(wa, 'commit', '-qam', 'strict');
  expect(await c.checkCommit('A', wa)).toEqual([`${F}::phone2numeric`]);
  expect((await c.status()).leases).toEqual([]);
  const [ch] = await g.query<{ landed: boolean }>(`MATCH (c:Change {agent: 'A'}) RETURN c.landed AS landed`);
  expect(ch.landed).toBe(true);
});

test('every hook renews the agent leases (TTL is 10 min from the last hook)', async () => {
  await c.touch('A', wa, { hook_event_name: 'SessionStart', cwd: wa });
  await c.preEdit('A', wa, { file: F, edits: [{ old: '    return x', new: '    return x * 2' }] });
  const before = (await c.status()).leases[0].expires;
  await new Promise((r) => setTimeout(r, 5));
  await c.touch('A', wa, { hook_event_name: 'PostToolUse', cwd: wa });
  expect((await c.status()).leases[0].expires).toBeGreaterThan(before);
});
