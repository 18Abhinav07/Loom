// End-to-end over the HTTP hook route only, Claude-shaped stdin, three agents in three git trees (plan 02 Task 6 Step 1).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { startServer } from '../src/server.js';
import { git, gitTree } from './helpers.js';
import { tmpRecord } from './helpers.js';

const F = 'django/utils/text.py';
const TEXT = 'def phone2numeric(phone):\n    return phone.upper()\n';
const DIAL = (call: string) => `${TEXT}\n\ndef dial(n):\n    return ${call}\n`;
let db: LoomDb; let srv: { close(): Promise<void>; port: number }; let url: string;
const run = `test:e2e:${Date.now()}`;
const wt: Record<string, string> = {};
beforeAll(async () => {
  db = await LoomDb.connect(); srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord() }); url = `http://127.0.0.1:${srv.port}`;
  await post('/admin/runs', { run, root: gitTree({ [F]: TEXT }), dirs: ['django'], baseKey: run });
  for (const a of ['A', 'B', 'C']) wt[a] = gitTree({ [F]: TEXT });
});
afterAll(async () => { await db.graph(run).drop(); await srv.close(); await db.graph(`trace:${run}`).drop().catch(() => {}); await db.close(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const hook = (agent: string, event: string, extra: Record<string, unknown> = {}) =>
  post(`/hook/claude/${event}`, { hook_event_name: event, cwd: wt[agent], session_id: `s-${agent}`, ...extra },
    { 'x-loom-agent': agent, 'x-loom-run': run }).then((r) => r.text());
const tool = (agent: string, event: 'PreToolUse' | 'PostToolUse', name: string, input: Record<string, unknown>) =>
  hook(agent, event, { tool_name: name, tool_input: input, ...(event === 'PostToolUse' ? { tool_response: {} } : {}) });
const write = (agent: string, text: string) => writeFileSync(join(wt[agent], F), text);

test('three agents: notice, deny, body-only grant, Stop rule 2, barrier, wake on commit', async () => {
  for (const a of ['A', 'B', 'C']) expect(await hook(a, 'SessionStart')).toBe('');                                    // 1
  expect(await tool('B', 'PostToolUse', 'Read', { file_path: join(wt.B, F) })).toBe('');                               // 2
  write('B', DIAL('phone2numeric(n)'));                                                                                // 2b: B's own caller
  expect(await tool('B', 'PostToolUse', 'Edit', { file_path: join(wt.B, F) })).toBe('');

  expect(await tool('A', 'PreToolUse', 'Edit', { file_path: join(wt.A, F), old_string: '(phone):', new_string: '(phone, *, strict):' })).toBe(''); // 3
  write('A', TEXT.replace('(phone):', '(phone, *, strict):'));                                                         // 4
  expect(await tool('A', 'PostToolUse', 'Edit', { file_path: join(wt.A, F) })).toBe('');

  const n5 = JSON.parse(await tool('B', 'PostToolUse', 'Read', { file_path: join(wt.B, 'README') }));                  // 5
  expect(n5.hookSpecificOutput.additionalContext).toContain('changed phone2numeric');

  const d6 = JSON.parse(await tool('C', 'PreToolUse', 'Edit', { file_path: join(wt.C, F), old_string: '(phone):', new_string: '(phone, region=None):' })); // 6
  expect(d6.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(d6.hookSpecificOutput.permissionDecisionReason).toContain('leased by agent A');
  expect(await tool('C', 'PreToolUse', 'Edit', { file_path: join(wt.C, F), old_string: 'phone.upper()', new_string: 'phone.lower()' })).toBe(''); // 7

  const s8 = JSON.parse(await hook('B', 'Stop', { stop_hook_active: false }));                                          // 8: rule 2
  expect(s8.decision).toBe('block');
  expect(s8.reason).toContain('changed phone2numeric');

  write('B', DIAL('phone2numeric(n, strict=False)'));                                                                  // 9
  await tool('B', 'PostToolUse', 'Edit', { file_path: join(wt.B, F) });
  const s10 = JSON.parse(await hook('B', 'Stop', { stop_hook_active: false }));                                         // 10: barrier
  expect(s10.decision).toBe('block');
  expect(s10.reason).toContain('not done yet');
  expect(await hook('B', 'Stop', { stop_hook_active: true })).toBe('');                                                 // 11

  git(wt.A, 'commit', '-qam', 'x');                                                                                     // 12
  expect(await tool('A', 'PostToolUse', 'Bash', { command: 'git commit -am x' })).toBe('');
  const n13 = JSON.parse(await hook('B', 'UserPromptSubmit', { prompt: 'continue' }));                                  // 13
  expect(n13.hookSpecificOutput.additionalContext).toContain('has landed');
});
