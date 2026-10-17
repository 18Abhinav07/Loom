// B3 §3.2: every interactive turn and tool call is mirrored into the session file and an SSE stream the dashboard reads.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { activeSession, ensureLoomDir, graphName, repoId } from '@loom/memory';
import { startServer } from '../src/server.js';
import { machineToken } from '../src/token.js';
import { git, gitTree, tmpRecord } from './helpers.js';

const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'mir' }));
let db: LoomDb; let srv: { port: number; close(): Promise<void> }; let url: string; let token: string;
beforeAll(async () => {
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord(), home });
  url = `http://127.0.0.1:${srv.port}`; token = machineToken(home);
});
afterAll(async () => { await srv.close(); await db.close(); });

const hook = (ev: string, cwd: string, sid: string, extra: object = {}) => fetch(`${url}/hook/claude/${ev}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-loom-home': home }, body: JSON.stringify({ hook_event_name: ev, cwd, session_id: sid, ...extra }) });

/** Read an SSE response until `n` data lines arrived, then abort. */
async function sse(path: string, n: number, keep: (e: any) => boolean = () => true): Promise<any[]> {
  const ac = new AbortController(); const out: any[] = [];
  const res = await fetch(`${url}${path}`, { signal: ac.signal, headers: { 'x-loom-token': token } });
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const rd = res.body!.getReader(); let buf = '';
  const t = setTimeout(() => ac.abort(), 3000);
  try {
    while (out.length < n) {
      const { value, done } = await rd.read(); if (done) break;
      buf += new TextDecoder().decode(value);
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.*)$/m.exec(b); if (d) { const e = JSON.parse(d[1]); if (keep(e)) out.push(e); } }
    }
  } catch { /* aborted */ } finally { clearTimeout(t); ac.abort(); }
  return out;
}

test('machineToken is 32 hex, 0600, and stable', () => {
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  expect(statSync(join(home, 'token')).mode & 0o777).toBe(0o600);
  expect(machineToken(home)).toBe(token);
});

test('a terminal session is mirrored: turn(user), tool, turn(claude) in the file and on /events; redacted; /sessions lists it', async () => {
  const r = gitTree({ 'a.py': 'x = 1\n' });
  const cfg = ensureLoomDir(r, { repoId: repoId(r), dirs: ['.'], excludes: [], testCmd: null, share: true });
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'loom init');
  await hook('SessionStart', r, 'c-1');
  const loomSid = activeSession(r, 'c-1')!.sid;
  await hook('UserPromptSubmit', r, 'c-1', { prompt: 'hello, key is sk-ant-api03-xxxxxxxxxxxxxxxx' });
  await hook('PostToolUse', r, 'c-1', { tool_name: 'Read', tool_input: { file_path: join(r, 'a.py') }, tool_response: {} });
  await hook('Stop', r, 'c-1', { last_assistant_message: 'hi there', stop_hook_active: false });

  const evs = await sse('/events?since=0', 3, (e) => e.sid === loomSid && e.kind !== 'state');   // state = busy/idle, checked below
  expect(evs.map((e) => e.kind)).toEqual(['turn', 'tool', 'turn']);
  expect(evs[0].data).toMatchObject({ from: 'user', text: 'hello, key is [redacted]' });
  expect(evs[1].data).toMatchObject({ name: 'Read', target: 'a.py', ok: true });
  expect(evs[2].data).toMatchObject({ from: 'claude', text: 'hi there' });
  expect(evs[0].seq < evs[1].seq && evs[1].seq < evs[2].seq).toBe(true);

  const lines = readFileSync(join(r, '.loom/sessions', `${loomSid}.main.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.filter((l) => l.type === 'turn' || l.type === 'tool').map((l) => [l.type, l.from ?? l.name]))
    .toEqual([['turn', 'user'], ['tool', 'Read'], ['turn', 'claude']]);
  expect(JSON.stringify(lines)).not.toMatch(/sk-ant/);

  const list = await (await fetch(`${url}/sessions`, { headers: { 'x-loom-token': token } })).json();
  expect(list.find((s: any) => s.sid === loomSid)).toMatchObject({ claude: 'c-1', writer: 'main', busy: false, channel: false, repo: git(r, 'rev-parse', '--show-toplevel').trim() });   // git's toplevel: /private/var on macOS
  const one = await (await fetch(`${url}/sessions/${loomSid}?token=${token}`)).json();
  expect(one.turns.map((t: any) => t.from)).toEqual(['user', 'claude']);
  await db.graph(graphName('mir', cfg.repoId)).drop();
});

test('a channel prompt is recorded as from:dashboard, unwrapped; busy between prompt and Stop', async () => {
  const r = gitTree({ 'a.py': 'x = 1\n' });
  const cfg = ensureLoomDir(r, { repoId: repoId(r), dirs: ['.'], excludes: [], testCmd: null, share: true });
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'loom init');
  await hook('SessionStart', r, 'c-2');
  const loomSid = activeSession(r, 'c-2')!.sid;
  await hook('UserPromptSubmit', r, 'c-2', { prompt: '<channel source="loom" from="dashboard">\nship it\n</channel>' });
  const busy = await (await fetch(`${url}/sessions`, { headers: { 'x-loom-token': token } })).json();
  expect(busy.find((s: any) => s.sid === loomSid).busy).toBe(true);
  await hook('Stop', r, 'c-2', { last_assistant_message: 'shipped' });
  const evs = await sse('/events?since=0', 2, (e) => e.sid === loomSid && e.kind === 'turn');
  expect(evs[0].data).toMatchObject({ from: 'dashboard', text: 'ship it' });
  await db.graph(graphName('mir', cfg.repoId)).drop();
});

test('without the token: /events, /sessions and /sessions/:sid answer 401', async () => {
  for (const p of ['/events', '/sessions', '/sessions/x']) expect((await fetch(`${url}${p}`)).status).toBe(401);
  expect((await fetch(`${url}/sessions?token=wrong`)).status).toBe(401);
});
