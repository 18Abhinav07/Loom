import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { resolveAttach } from '../src/attach.js';
import { startServer } from '../src/server.js';
import { gitTree } from './helpers.js';
import { tmpRecord } from './helpers.js';

let db: LoomDb; let srv: { close(): Promise<void>; port: number }; let url: string;
const run = `coord:local:t${Date.now()}`;
beforeAll(async () => { db = await LoomDb.connect(); srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord() }); url = `http://127.0.0.1:${srv.port}`; });
afterAll(async () => { await db.graph(run).drop().catch(() => {}); await srv.close(); await db.close(); });
const post = (path: string, body: unknown) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const configure = (main: string, r: string) => {
  mkdirSync(join(main, '.loom'), { recursive: true });
  writeFileSync(join(main, '.loom/config.json'), JSON.stringify({ run: r, dirs: ['django'], daemon: '' }));
};

test('5.1 worktree of an initialised repo resolves to the main repo config', () => {
  const main = gitTree({ 'django/a.py': 'def f():\n    pass\n' });
  configure(main, 'coord:local:demo');
  const wt = join(dirname(main), `wt-${Date.now()}`);
  execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: main });
  expect(resolveAttach(join(wt, 'django'))).toEqual({ run: 'coord:local:demo', mainRoot: realpathSync(main), root: realpathSync(wt), dirs: ['django'] });
});

test('5.2 non-Loom repo, non-git dir → null; the hook route answers empty, not 500', async () => {
  expect(resolveAttach(gitTree({}))).toBeNull();
  expect(resolveAttach(mkdtempSync(join(tmpdir(), 'nogit-')))).toBeNull();
  const r = await post('/hook/claude/PostToolUse', { hook_event_name: 'PostToolUse', cwd: tmpdir(), session_id: 'x' });
  expect(r.status).toBe(200); expect(await r.text()).toBe('');
});

test('5.3 attach session without env: first hook creates the run and registers claude-<sid8>', async () => {
  const main = gitTree({ 'django/a.py': 'def f():\n    pass\n' });
  configure(main, run);
  const r = await post('/hook/claude/SessionStart', { hook_event_name: 'SessionStart', cwd: main, session_id: 'abcdef1234567890' });
  expect(r.status).toBe(200);
  const s = await (await fetch(`${url}/status?run=${encodeURIComponent(run)}`)).json();
  expect(s.agents.map((a: { id: string }) => a.id)).toEqual(['claude-abcdef12']);
  // macOS: tmpdir is /var/… while git reports /private/var/…; a hook path through the symlink is still inside the worktree
  writeFileSync(join(main, 'django/a.py'), 'def f():\n    return 1\n');
  await post('/hook/claude/PostToolUse', { hook_event_name: 'PostToolUse', cwd: main, session_id: 'abcdef1234567890',
    tool_name: 'Edit', tool_input: { file_path: join(main, 'django/a.py') }, tool_response: {} });
  const [ch] = await db.graph(run).query<{ n: number }>(`MATCH (c:Change {agent: 'claude-abcdef12'}) RETURN count(c) AS n`);
  expect(ch.n).toBe(1);
  expect((await post('/release', { run, agent: 'claude-abcdef12' })).status).toBe(200);
});
