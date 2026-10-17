// B3 §3.3: the dashboard talks to a live session through its loom-mcp channel; held while busy, flushed on Stop; permission relay.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { activeSession, ensureLoomDir, graphName, repoId } from '@loom/memory';
import { startServer } from '../src/server.js';
import { machineToken } from '../src/token.js';
import { git, gitTree, tmpRecord } from './helpers.js';

const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'chn' }));
let db: LoomDb; let srv: { port: number; close(): Promise<void> }; let url: string; let token: string;

/** The test's stand-in for loom-mcp's push port: records what the daemon pushes. */
let stub: Server; let stubPort: number; const got: any[] = [];
const SECRET = 'f'.repeat(32);

beforeAll(async () => {
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord(), home });
  url = `http://127.0.0.1:${srv.port}`; token = machineToken(home);
  stub = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const j = JSON.parse(b || '{}');
      if (j.secret !== SECRET) { res.writeHead(403); return res.end(); }
      got.push({ path: req.url, ...j }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  stubPort = (stub.address() as any).port;
});
afterAll(async () => { stub.close(); await srv.close(); await db.close(); });

const H = () => ({ 'content-type': 'application/json', 'x-loom-token': token });
const post = (p: string, b: object, h: Record<string, string> = H()) => fetch(`${url}${p}`, { method: 'POST', headers: h, body: JSON.stringify(b) });
const hook = (ev: string, cwd: string, sid: string, extra: object = {}, ppids = '') => fetch(`${url}/hook/claude/${ev}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-loom-home': home, 'x-loom-ppids': ppids }, body: JSON.stringify({ hook_event_name: ev, cwd, session_id: sid, ...extra }) });
const until = async (f: () => boolean, ms = 2000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20)); return f(); };

function repo() {
  const r = gitTree({ 'a.py': 'x = 1\n' });
  const cfg = ensureLoomDir(r, { repoId: repoId(r), dirs: ['.'], excludes: [], testCmd: null, share: true });
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'loom init');
  return { r, graph: graphName('chn', cfg.repoId) };
}

test('registration needs the token; a session bound by ppid is sent to when idle, held while busy, flushed on Stop', async () => {
  expect((await post('/channels', { pid: 4242, port: stubPort, secret: SECRET, cwd: '/x' }, { 'content-type': 'application/json' })).status).toBe(401);
  const { r, graph } = repo();
  // SessionStart may arrive before the channel registers: binding waits for it
  await hook('SessionStart', r, 'c-ch', {}, '777,4242,1');
  const sid = activeSession(r, 'c-ch')!.sid;
  expect((await post(`/sessions/${sid}/messages`, { text: 'early' })).status).toBe(409);
  expect((await post('/channels', { pid: 4242, port: stubPort, secret: SECRET, cwd: r })).status).toBe(200);
  const row = (await (await fetch(`${url}/sessions`, { headers: H() })).json()).find((s: any) => s.sid === sid);
  expect(row.channel).toBe(true);

  const a = await (await post(`/sessions/${sid}/messages`, { text: 'first' })).json();
  expect(a).toEqual({ status: 'sent' });
  expect(got.at(-1)).toMatchObject({ path: '/push', content: 'first', meta: { from: 'dashboard' } });

  await hook('UserPromptSubmit', r, 'c-ch', { prompt: '<channel source="loom" from="dashboard">\nfirst\n</channel>' });
  const n = got.length;
  expect(await (await post(`/sessions/${sid}/messages`, { text: 'second' })).json()).toEqual({ status: 'held' });
  expect(got.length).toBe(n);   // nothing pushed while the turn runs
  await hook('Stop', r, 'c-ch', { last_assistant_message: 'done' });
  expect(await until(() => got.length === n + 1)).toBe(true);
  expect(got.at(-1)).toMatchObject({ path: '/push', content: 'second' });
  await db.graph(graph).drop();
});

test('a session without a channel is 409 with the read-only hint; another session never receives it', async () => {
  const { r, graph } = repo();
  await hook('SessionStart', r, 'c-none', {}, '888,1');
  const sid = activeSession(r, 'c-none')!.sid;
  const n = got.length;
  const res = await post(`/sessions/${sid}/messages`, { text: 'hello' });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe('read-only: restart the lead with loom lead to chat here');
  expect(got.length).toBe(n);
  expect((await post('/sessions/nope/messages', { text: 'x' })).status).toBe(404);
  await db.graph(graph).drop();
});

test('a permission request goes to the bus; the first answer is delivered to the channel, a second is 409', async () => {
  const { r, graph } = repo();
  await post('/channels', { pid: 5151, port: stubPort, secret: SECRET, cwd: r });
  await hook('SessionStart', r, 'c-perm', {}, '5151');
  const sid = activeSession(r, 'c-perm')!.sid;
  const ac = new AbortController();
  const evs: any[] = [];
  const s = await fetch(`${url}/events`, { headers: H(), signal: ac.signal });
  const rd = s.body!.getReader(); let buf = '';
  void (async () => { try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += new TextDecoder().decode(value);
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const d = /^data: (.*)$/m.exec(buf.slice(0, i)); buf = buf.slice(i + 2); if (d) evs.push(JSON.parse(d[1])); } } } catch { /* aborted */ } })();
  await new Promise((r2) => setTimeout(r2, 100));
  expect((await post('/channels/permission', { pid: 5151, request_id: 'abcde', tool_name: 'Bash', description: 'run ls', input_preview: 'ls -la' })).status).toBe(200);
  expect(await until(() => evs.some((e) => e.kind === 'permission'))).toBe(true);
  expect(evs.find((e) => e.kind === 'permission')).toMatchObject({ sid, data: { rid: 'abcde', tool: 'Bash', description: 'run ls', preview: 'ls -la' } });
  ac.abort();
  expect((await (await fetch(`${url}/sessions/${sid}`, { headers: H() })).json()).pending.map((p: any) => p.rid)).toEqual(['abcde']);

  expect((await post(`/sessions/${sid}/permissions/abcde`, { behavior: 'allow' })).status).toBe(200);
  expect(got.at(-1)).toMatchObject({ path: '/permission', request_id: 'abcde', behavior: 'allow' });
  expect((await post(`/sessions/${sid}/permissions/abcde`, { behavior: 'deny' })).status).toBe(409);
  expect((await post(`/sessions/${sid}/permissions/zzzzz`, { behavior: 'deny' })).status).toBe(409);
  expect((await post(`/sessions/${sid}/permissions/abcde`, { behavior: 'maybe' })).status).toBe(400);
  await db.graph(graph).drop();
});

test('GET /channels/:pid says whether the daemon knows a channel (loom-mcp re-registers on 404)', async () => {
  expect((await fetch(`${url}/channels/4242`, { headers: H() })).status).toBe(200);
  expect((await fetch(`${url}/channels/99999`, { headers: H() })).status).toBe(404);
});

// Final review I6: after a daemon restart an idle lead must be reachable as soon as its loom-mcp re-registers, not after its next hook.
test('a restarted daemon recovers and binds an idle session when its channel re-registers', async () => {
  const { r } = repo();
  await hook('SessionStart', r, 'c-restart', {}, '888,5151,1');
  const sid = activeSession(r, 'c-restart')!.sid;
  const fresh = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord(), home });   // the daemon after a restart
  try {
    const u2 = `http://127.0.0.1:${fresh.port}`;
    const reg = await fetch(`${u2}/channels`, { method: 'POST', headers: H(), body: JSON.stringify({ pid: 5151, port: stubPort, secret: SECRET, cwd: r }) });
    expect(reg.status).toBe(200);
    const rows = await (await fetch(`${u2}/sessions`, { headers: H() })).json();
    expect(rows.find((s: any) => s.sid === sid)).toMatchObject({ channel: true, busy: false });
    const n = got.length;
    const m = await fetch(`${u2}/sessions/${sid}/messages`, { method: 'POST', headers: H(), body: JSON.stringify({ text: 'after restart' }) });
    expect(await m.json()).toMatchObject({ status: 'sent' });
    expect(got.slice(n).map((g) => g.content)).toEqual(['after restart']);
  } finally { await fresh.close(); }
});

// Final review I8: Claude Code fires SessionStart again (source compact/clear/resume) under the same session id.
test('SessionStart with source compact keeps the Loom session: same sid, no second session file', async () => {
  const { r } = repo();
  await hook('SessionStart', r, 'c-compact', { source: 'startup' }, '889,5252,1');
  const sid = activeSession(r, 'c-compact')!.sid;
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(join(r, '.loom/sessions')).length;
  expect((await hook('SessionStart', r, 'c-compact', { source: 'compact' }, '889,5252,1')).status).toBe(200);
  expect(activeSession(r, 'c-compact')!.sid).toBe(sid);
  expect(readdirSync(join(r, '.loom/sessions')).length).toBe(files);
  const rows = await (await fetch(`${url}/sessions`, { headers: H() })).json();
  expect(rows.filter((s: any) => s.claude === 'c-compact').map((s: any) => s.sid)).toEqual([sid]);
});

// Final review I7: a message held for a busy session survives a daemon restart and is delivered at that session's next Stop.
test('a held message survives a daemon restart and is flushed on the next Stop', async () => {
  const { r } = repo();
  await hook('SessionStart', r, 'c-held', {}, '890,5353,1');
  const sid = activeSession(r, 'c-held')!.sid;
  expect((await post('/channels', { pid: 5353, port: stubPort, secret: SECRET, cwd: r })).status).toBe(200);
  expect(await (await post(`/sessions/${sid}/messages`, { text: 'go' })).json()).toEqual({ status: 'sent' });
  expect(await (await post(`/sessions/${sid}/messages`, { text: 'kept across restart' })).json()).toEqual({ status: 'held' });
  const fresh = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord(), home });
  try {
    const u2 = `http://127.0.0.1:${fresh.port}`;
    expect((await fetch(`${u2}/channels`, { method: 'POST', headers: H(), body: JSON.stringify({ pid: 5353, port: stubPort, secret: SECRET, cwd: r }) })).status).toBe(200);
    const n = got.length;
    await fetch(`${u2}/hook/claude/Stop`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loom-home': home, 'x-loom-ppids': '890,5353,1' },
      body: JSON.stringify({ hook_event_name: 'Stop', cwd: r, session_id: 'c-held', last_assistant_message: 'done' }) });
    expect(await until(() => got.length > n)).toBe(true);
    expect(got.slice(n).map((g) => g.content)).toEqual(['kept across restart']);
  } finally { await fresh.close(); }
});
