// B4 §3.4: /teams routes, the lead's team tools, and agent replies pushed to the bound lead session. Fake claude, real FalkorDB.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { ensureLoomDir, graphName, repoId } from '@loom/memory';
import { startServer } from '../src/server.js';
import { machineToken } from '../src/token.js';
import { git, gitTree, tmpRecord } from './helpers.js';

const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'trt' }));
const BIN = join(__dirname, 'fake-claude.mjs');
const SECRET = 'e'.repeat(32);
let db: LoomDb; let srv: { port: number; close(): Promise<void> }; let url: string; let token: string;
let stub: Server; let stubPort: number; const got: any[] = [];
const graphs: string[] = [];

beforeAll(async () => {
  process.env.FAKE_HOLD = '1';
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord(), home, teamBin: BIN, teamPoll: 100 });
  url = `http://127.0.0.1:${srv.port}`; token = machineToken(home);
  stub = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const j = JSON.parse(b || '{}');
      if (j.secret !== SECRET) { res.writeHead(403); return res.end(); }
      got.push(j); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  stubPort = (stub.address() as any).port;
});
afterAll(async () => { stub.close(); await srv.close(); for (const g of graphs) await db.graph(g).drop().catch(() => {}); await db.close(); delete process.env.FAKE_HOLD; });

const post = (p: string, b: object) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const hook = (ev: string, cwd: string, sid: string, ppids = '') => fetch(`${url}/hook/claude/${ev}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-loom-home': home, 'x-loom-ppids': ppids }, body: JSON.stringify({ hook_event_name: ev, cwd, session_id: sid }) });
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); return f(); };

const task = (after = '[]') => `tasks:\n  - id: a\n    title: a\n    owns: [a.py]\n    after: ${after}\n    done: a done\n    prompt: do a`;
function repo(planBody = task()) {
  const r = gitTree({ 'a.py': 'x = 1\n' });
  const cfg = ensureLoomDir(r, { repoId: repoId(r), dirs: ['.'], excludes: [], testCmd: null, share: true });
  graphs.push(graphName('trt', cfg.repoId));
  mkdirSync(join(r, '.loom', 'plans'), { recursive: true });
  writeFileSync(join(r, '.loom', 'plans', 'p.md'), `---\ngoal: g\ntest: 'true'\n${planBody}\n---\nbody\n`);
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'loom init');
  return r;
}

test('a bad plan is a 400 with its problems', async () => {
  const r = repo(task('[ghost]'));
  const res = await post('/teams', { cwd: r, plan: 'p' });
  expect(res.status).toBe(400);
  expect((await res.json()).problems.join(' ')).toMatch(/ghost/);
});

test('start, list, message a running agent; its reply reaches the bound lead with meta.from=agent:a', async () => {
  const r = repo();
  await hook('SessionStart', r, 'lead-1', '777,5151,1');
  expect((await fetch(`${url}/channels`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loom-token': token },
    body: JSON.stringify({ pid: 5151, port: stubPort, secret: SECRET, cwd: r }) })).status).toBe(200);
  const res = await post('/teams', { cwd: r, plan: 'p' });
  expect(res.status).toBe(200);
  const { team } = await res.json();
  const list = await (await fetch(`${url}/teams?cwd=${encodeURIComponent(r)}`)).json();
  expect(list.map((t: any) => t.id)).toEqual([team.id]);
  expect((await (await fetch(`${url}/teams/${team.id}?cwd=${encodeURIComponent(r)}`)).json()).agents.map((a: any) => a.id)).toEqual(['a']);
  const m = await (await post(`/teams/${team.id}/message`, { cwd: r, agent: 'a', text: 'hello there' })).json();
  expect(m.ok).toBe(true);
  expect(await until(() => got.some((g) => g.content?.includes('ack:hello there')))).toBe(true);
  expect(got.find((g) => g.content?.includes('ack:hello there')).meta.from).toBe('agent:a');
  expect((await (await post(`/teams/${team.id}/stop`, { cwd: r })).json()).ok).toBe(true);
}, 30_000);

test('a message to an agent that is not running is refused; unknown team is 404', async () => {
  const r = repo();
  const { team } = await (await post('/teams', { cwd: r, plan: 'p' })).json();
  await post(`/teams/${team.id}/stop`, { cwd: r });
  const m = await post(`/teams/${team.id}/message`, { cwd: r, agent: 'a', text: 'x' });
  expect(m.status).toBe(400);
  expect((await m.json()).error).toMatch(/not running/);
  expect((await fetch(`${url}/teams/NOPE?cwd=${encodeURIComponent(r)}`)).status).toBe(404);
}, 30_000);

test('the lead MCP tool starts a team; a team agent is refused', async () => {
  const r = repo();
  const call = (tool: string, args: object, h: Record<string, string> = {}) =>
    post(`/mcp/${tool}`, { cwd: r, args }).then((x) => x.json());
  const refused = await fetch(`${url}/mcp/start_team`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loom-agent': 'a' }, body: JSON.stringify({ cwd: r, args: { plan: 'p' } }) });
  expect((await refused.json()).ok).toBe(false);
  const s = await call('start_team', { plan: 'p' });
  expect(s.ok).toBe(true); expect(s.result.ok).toBe(true);
  const st = await call('team_status', {});
  expect(st.result.team.id).toBe(s.result.team.id);
  expect((await call('stop_team', {})).result.ok).toBe(true);
}, 30_000);
