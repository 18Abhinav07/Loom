// B3: the daemon starts one Loom session per Claude session id; the lead (LOOM_LEAD=1 → x-loom-lead) writes as `lead`.
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { activeSession, ensureLoomDir, graphName, repoId } from '@loom/memory';
import { startServer } from '../src/server.js';
import { git, gitTree, tmpRecord } from './helpers.js';

let db: LoomDb; let srv: { port: number; close(): Promise<void> }; let url: string;
beforeAll(async () => { db = await LoomDb.connect(); srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord() }); url = `http://127.0.0.1:${srv.port}`; });
afterAll(async () => { await srv.close(); await db.close(); });

const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'sid' }));
const hook = (ev: string, cwd: string, sid: string, lead = false) => fetch(`${url}/hook/claude/${ev}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-loom-home': home, ...(lead ? { 'x-loom-lead': '1' } : {}) },
  body: JSON.stringify({ hook_event_name: ev, cwd, session_id: sid }) });

test('two terminals in one checkout: two active sessions; the lead header gives a .lead.jsonl; SessionEnd closes only its own', async () => {
  const r = gitTree({ 'a.py': 'x = 1\n' });
  const cfg = ensureLoomDir(r, { repoId: repoId(r), dirs: ['.'], excludes: [], testCmd: null, share: true });
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'loom init');
  expect((await hook('SessionStart', r, 'lead-1', true)).status).toBe(200);
  expect((await hook('SessionStart', r, 'term-2')).status).toBe(200);
  const lead = activeSession(r, 'lead-1'), other = activeSession(r, 'term-2');
  expect(lead && other && lead.sid !== other.sid).toBe(true);
  expect(lead!.writer).toBe('lead'); expect(other!.writer).toBe('main');
  expect(readdirSync(join(r, '.loom/sessions'))).toContain(`${lead!.sid}.lead.jsonl`);
  expect((await hook('SessionEnd', r, 'term-2')).status).toBe(200);
  expect(activeSession(r, 'term-2')).toBeNull();
  expect(activeSession(r, 'lead-1')?.sid).toBe(lead!.sid);
  await db.graph(graphName('sid', cfg.repoId)).drop();
});
