import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { startServer } from '../src/server.js';
import { tmpRecord } from './helpers.js';

const TEXT = 'def phone2numeric(phone):\n    return phone.upper()\n';
let db: LoomDb; let srv: { close(): Promise<void>; port: number }; let url: string;
const run = `test:srv:${Date.now()}`;
const tree = (t: string) => {
  const d = mkdtempSync(join(tmpdir(), 'loom-'));
  mkdirSync(join(d, 'django/utils'), { recursive: true });
  writeFileSync(join(d, 'django/utils/text.py'), t);
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: d });
  return d;
};
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const hook = (event: string, body: unknown) => post(`/hook/claude/${event}`, body, { 'x-loom-agent': 'B', 'x-loom-run': run }).then((r) => r.text());

let wa: string; let wb: string;
beforeAll(async () => {
  db = await LoomDb.connect(); srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord() }); url = `http://127.0.0.1:${srv.port}`;
  const base = tree(TEXT); wa = tree(TEXT); wb = tree(TEXT);
  await post('/admin/runs', { run, root: base, dirs: ['django'], baseKey: 'k' });
  await post('/admin/agents', { run, agent: 'A', harness: 'replay', worktree: wa });
  await hook('SessionStart', { hook_event_name: 'SessionStart', cwd: wb, session_id: 's' });
});
afterAll(async () => { await db.graph(run).drop(); await srv.close(); await db.close(); });

test('Bash `cat` counts as a read; A change is injected on B next PostToolUse; Stop is clean afterwards', async () => {
  expect(await hook('PostToolUse', { hook_event_name: 'PostToolUse', cwd: wb, tool_name: 'Bash',
    tool_input: { command: 'cat django/utils/text.py' }, tool_response: {} })).toBe('');
  expect(await (await fetch(`${url}/runs/${encodeURIComponent(run)}/touched?agent=B&kind=read&file=django/utils/text.py`)).json()).toEqual({ touched: true });
  expect(await (await fetch(`${url}/runs/${encodeURIComponent(run)}/touched?agent=B&kind=edit`)).json()).toEqual({ touched: false });

  writeFileSync(join(wa, 'django/utils/text.py'), TEXT.replace('(phone):', '(phone, *, strict):'));
  await post('/admin/ingest', { run, agent: 'A', worktree: wa, files: ['django/utils/text.py'] });

  const out = JSON.parse(await hook('PostToolUse', { hook_event_name: 'PostToolUse', cwd: wb, tool_name: 'Read',
    tool_input: { file_path: join(wb, 'README') }, tool_response: {} }));
  expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
  expect(out.hookSpecificOutput.additionalContext).toContain('phone2numeric(phone, *, strict)');
  expect(await hook('Stop', { hook_event_name: 'Stop', cwd: wb, stop_hook_active: false })).toBe('');
});

test('an edit made through Bash is detected via git status', async () => {
  writeFileSync(join(wb, 'django/utils/text.py'), TEXT + '\ndef clean(p):\n    return phone2numeric(p)\n');
  await hook('PostToolUse', { hook_event_name: 'PostToolUse', cwd: wb, tool_name: 'Bash', tool_input: { command: 'python fix.py' }, tool_response: {} });
  const notices = await (await fetch(`${url}/runs/${encodeURIComponent(run)}/notices`)).json();
  // B now depends on a symbol A already changed -> write-after-change notice exists (pending or delivered)
  expect(notices.length).toBeGreaterThanOrEqual(1);
});

test('pending notice at Stop blocks with the notice as reason', async () => {
  writeFileSync(join(wa, 'django/utils/text.py'), TEXT.replace('def phone2numeric', 'def phone2numeric_v2'));
  await post('/admin/ingest', { run, agent: 'A', worktree: wa, files: ['django/utils/text.py'] });
  const out = JSON.parse(await hook('Stop', { hook_event_name: 'Stop', cwd: wb, stop_hook_active: false }));
  expect(out.decision).toBe('block');
  expect(out.reason).toContain('renamed to');
});

test('a bench run (lessons: false) is never told earlier runs\' lessons; a default run is', async () => {
  await post('/lessons', { symbols: ['django/utils/text.py::phone2numeric'], text: 'LESSON-MARKER', run: 'old' });
  const told = async (r: string, lessons?: boolean) => {
    const wc = tree(TEXT);
    await post('/admin/runs', { run: r, root: tree(TEXT), dirs: ['django'], baseKey: 'k', ...(lessons === undefined ? {} : { lessons }) });
    const h = (event: string, b: unknown) => post(`/hook/claude/${event}`, b, { 'x-loom-agent': 'C', 'x-loom-run': r }).then((x) => x.text());
    await h('SessionStart', { hook_event_name: 'SessionStart', cwd: wc, session_id: 'c' });
    const out = await h('PostToolUse', { hook_event_name: 'PostToolUse', cwd: wc, tool_name: 'Read',
      tool_input: { file_path: join(wc, 'django/utils/text.py') }, tool_response: {} });
    await db.graph(r).drop();
    return out.includes('LESSON-MARKER');
  };
  expect(await told(`${run}:bench`, false)).toBe(false);
  expect(await told(`${run}:user`)).toBe(true);
});
