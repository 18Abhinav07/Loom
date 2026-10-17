// The dashboard port is a client of the API port: /ctx names its repo, /teams and /plans pass through.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { ensureLoomDir, repoId } from '@loom/memory';
import { startServer } from '../src/server.js';
import { gitTree, tmpRecord } from './helpers.js';

const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'uirt' }));
let db: LoomDb; let srv: Awaited<ReturnType<typeof startServer>>; let root: string;
beforeAll(async () => {
  root = gitTree({ 'a.py': 'x = 1\n' });
  ensureLoomDir(root, { repoId: repoId(root), dirs: ['.'], excludes: [], testCmd: null, share: true });
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: 0, recordDir: tmpRecord(), home, cwd: root });
});
afterAll(async () => { await srv.close(); await db.close(); });

test('/ctx answers the repo the daemon was opened on', async () => {
  const r = await fetch(`http://127.0.0.1:${srv.uiPort}/ctx`, { headers: { 'x-loom-home': home } });
  expect(await r.json()).toEqual({ cwd: root });
});

test('/teams and /plans on the UI port reach the API routes', async () => {
  const q = `?cwd=${encodeURIComponent(root)}`;
  const h = { headers: { 'x-loom-home': home } };
  expect(await (await fetch(`http://127.0.0.1:${srv.uiPort}/teams${q}`, h)).json()).toEqual([]);
  expect(await (await fetch(`http://127.0.0.1:${srv.uiPort}/plans${q}`, h)).json()).toEqual([]);
});
