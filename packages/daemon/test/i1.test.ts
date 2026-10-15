import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { ensureLoomDir, graphName, indexRepo, repoId, addLesson } from '@loom/memory';
import { startServer } from '../src/server.js';
import { git, gitTree, tmpRecord } from './helpers.js';

let db: LoomDb; let srv: { port: number; close(): Promise<void> }; let url: string;
beforeAll(async () => { db = await LoomDb.connect(); srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord() }); url = `http://127.0.0.1:${srv.port}`; });
afterAll(async () => { await srv.close(); await db.close(); });

const hook = (ev: string, cwd: string, home: string, extra: object = {}) => fetch(`${url}/hook/claude/${ev}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-loom-home': home }, body: JSON.stringify({ hook_event_name: ev, cwd, session_id: 's', ...extra }) });
const home = (t: string) => { const h = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(h, 'config.json'), JSON.stringify({ tenant: t })); return h; };

test('I1: two tenants on the same repo get two graphs; lessons and briefings never cross; C1 lesson leak is closed', async () => {
  const hadGlobal = (await db.list()).includes('lessons');                    // v1 left one behind on dev machines
  const r = gitTree({ 'a.py': 'def f():\n    return 1\n' });
  const cfg = ensureLoomDir(r, { repoId: repoId(r), dirs: ['.'], excludes: [], testCmd: null, share: true });
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'loom init');
  // a tenant is another OS user: their own clone. Uncommitted .loom records of A's clone never reach it except through git.
  const rb = mkdtempSync(join(tmpdir(), 'loom-b-')); git(rb, 'clone', '-q', r, '.');
  const [ha, hb] = [home('ta'), home('tb')];
  const [ga, gb] = [db.graph(graphName('ta', cfg.repoId)), db.graph(graphName('tb', cfg.repoId))];
  await indexRepo(ga, r, { baseline: true }); await indexRepo(gb, rb, { baseline: true });
  await addLesson(ga, r, null, 'a.py::f::definition#0', 'TENANT-A-SECRET', 'manual');
  const sa = await (await hook('SessionStart', r, ha)).json();
  const sb = await (await hook('SessionStart', rb, hb)).json();
  expect(sa.hookSpecificOutput.additionalContext).toMatch(/^\[loom\]/);
  expect(JSON.stringify(sb)).not.toMatch(/TENANT-A-SECRET/);
  const lb = await (await fetch(`${url}/repo/lessons?region=a.py::f::definition%230`, { headers: { 'x-loom-cwd': rb, 'x-loom-home': hb } })).json();
  expect(lb).toEqual([]);
  const la = await (await fetch(`${url}/repo/lessons?region=a.py::f::definition%230`, { headers: { 'x-loom-cwd': r, 'x-loom-home': ha } })).json();
  expect(la.map((l: any) => l.text)).toEqual(['TENANT-A-SECRET']);
  // forged graph names are ignored: no route accepts one
  const forged = await (await fetch(`${url}/repo/lessons?region=a.py::f::definition%230&graph=${graphName('ta', cfg.repoId)}`,
    { headers: { 'x-loom-cwd': rb, 'x-loom-home': hb, 'x-loom-run': graphName('ta', cfg.repoId) } })).json();
  expect(forged).toEqual([]);
  if (!hadGlobal) expect((await db.list()).includes('lessons')).toBe(false);     // no global lessons graph is created
  else expect(JSON.stringify(await db.graph('lessons').query('MATCH (l:Lesson) RETURN l.text AS t'))).not.toMatch(/TENANT-A-SECRET/);
  await ga.drop(); await gb.drop();
});

test('a repo without .loom/config.json: SessionStart answers {} (v1 behaviour kept), never 500', async () => {
  const r = gitTree({ 'a.py': 'x = 1\n' });
  const res = await hook('SessionStart', r, home('tc'));
  expect(res.status).toBe(200);
});
