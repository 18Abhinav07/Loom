// B3 §3.3: the thin chat page. GET /lead on the UI port carries the machine token; /lead/api/* is a same-origin pass-through
// to the API port that still needs the token, so another web origin cannot drive the lead through it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { startServer } from '../src/server.js';
import { machineToken } from '../src/token.js';
import { tmpRecord } from './helpers.js';

const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'lp' }));
let db: LoomDb; let srv: Awaited<ReturnType<typeof startServer>>; let ro: Awaited<ReturnType<typeof startServer>>; let ui: string; let token: string;

beforeAll(async () => {
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: 0, recordDir: tmpRecord(), home });
  ro = await startServer({ port: 0, db, uiPort: 0, recordDir: tmpRecord(), home, readOnly: true });
  ui = `http://127.0.0.1:${srv.uiPort}`; token = machineToken(home);
});
afterAll(async () => { await srv.close(); await ro.close(); await db.close(); });

test('GET /lead is an HTML page with the token, a session list, a send box and Allow/Deny', async () => {
  const r = await fetch(`${ui}/lead`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toMatch(/^text\/html/);
  const html = await r.text();
  expect(html).toContain(JSON.stringify(token));
  for (const id of ['id="sessions"', 'id="turns"', 'id="send"', 'id="text"', 'id="perms"', "'/lead/api/events?token='"]) expect(html).toContain(id);
  expect(html).toContain('Allow');
  expect(html).toContain('Deny');
});

test('/lead/api passes method, body and token through, and still refuses without the token', async () => {
  expect((await fetch(`${ui}/lead/api/sessions`)).status).toBe(401);
  const ok = await fetch(`${ui}/lead/api/sessions`, { headers: { 'x-loom-token': token } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual([]);
  const miss = await fetch(`${ui}/lead/api/sessions/nope/messages`, { method: 'POST', headers: { 'x-loom-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
  expect(miss.status).toBe(404);
  expect((await miss.json()).error).toBe('no live session with that id');
});

test('the event stream comes through the pass-through with ?token=', async () => {
  const ac = new AbortController();
  const r = await fetch(`${ui}/lead/api/events?token=${token}`, { signal: ac.signal });
  expect(r.headers.get('content-type')).toBe('text/event-stream');
  const rd = r.body!.getReader(); let got = '';
  while (!got.includes(': ok')) got += new TextDecoder().decode((await rd.read()).value);
  ac.abort();
  expect(got).toContain(': ok');
});

test('a read-only (deployed) daemon does not serve the lead page or the pass-through', async () => {
  const u = `http://127.0.0.1:${ro.uiPort}`;
  expect((await fetch(`${u}/lead`)).status).toBe(404);
  expect((await fetch(`${u}/lead/api/sessions`, { headers: { 'x-loom-token': token } })).status).toBe(404);
});
