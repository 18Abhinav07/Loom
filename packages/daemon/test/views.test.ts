// B5/B6 data routes: one test per route over a graph imported from two people's session files. Real FalkorDB.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { appendEvent, collisionId, ensureLoomDir, graphName, importSessions, repoId, ulid } from '@loom/memory';
import { startServer } from '../src/server.js';
import { git, gitTree, tmpRecord } from './helpers.js';

const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'vwt' }));
const bench = mkdtempSync(join(tmpdir(), 'loom-bench-'));
const R1 = 'pkg/text.py::slugify::definition#0';
let db: LoomDb; let srv: { port: number; close(): Promise<void> }; let root: string; let graph: string;
let sA = '', sB = '', sC = '', colId = '';

const commitAs = (who: string, msg: string) => { git(root, '-c', `user.email=${who}`, 'add', '-A'); git(root, '-c', `user.email=${who}`, 'commit', '-qm', msg); };
const ver = (sid: string, by: string, id: string, prev: string[]) => appendEvent(root, sid, 'main', { type: 'version', id, region: R1, hash: id, sig: 'slugify(v)', deleted: false, degraded: false, prev, by, task: null });

beforeAll(async () => {
  root = gitTree({ 'pkg/text.py': 'def slugify(v):\n    return v\n' });
  const cfg = ensureLoomDir(root, { repoId: repoId(root), dirs: ['.'], excludes: [], testCmd: null, share: true });
  graph = graphName('vwt', cfg.repoId);
  sA = ulid(); sB = ulid(); sC = ulid();
  appendEvent(root, sA, 'main', { type: 'session', person: 'a@t', kind: 'interactive', base: '', upstream: null });
  appendEvent(root, sA, 'main', { type: 'agent', name: 'main', model: 'm' });
  const v1 = ver(sA, 'main', 'v1', []);
  appendEvent(root, sA, 'main', { type: 'decision', text: 'keep it pure', by: 'main', regions: [R1], led_to: [v1.id] });
  appendEvent(root, sA, 'main', { type: 'turn', from: 'user', text: 'make slugify safe' });
  appendEvent(root, sA, 'main', { type: 'handoff', summary: 'slugify done', open_tasks: [], open_leases: [] });
  commitAs('a@t', 'A slugify');
  appendEvent(root, sB, 'main', { type: 'session', person: 'b@t', kind: 'interactive', base: '', upstream: null });
  appendEvent(root, sB, 'main', { type: 'agent', name: 'main', model: 'm' });
  const v2 = ver(sB, 'main', 'v2', [v1.id]);
  const parties = [{ person: 'a@t', session: sA }, { person: 'b@t', session: sB }];
  colId = collisionId('divergence', parties, [R1], v2.id);
  appendEvent(root, sB, 'main', { type: 'collision', id: colId, kind: 'divergence', parties, region: [R1], outcome: 'open', version: v2.id, detail: 'both changed slugify' });
  commitAs('b@t', 'B slugify');
  appendEvent(root, sC, 'main', { type: 'session', person: 'a@t', kind: 'run', base: '', upstream: null, parent: sA, team: 'T1', task: 'x' });
  commitAs('a@t', 'A child');
  db = await LoomDb.connect();
  await importSessions(db.graph(graph), root, null);
  mkdirSync(join(bench, 'results'), { recursive: true });
  writeFileSync(join(bench, 'results', 'e1.json'), JSON.stringify({ conds: {
    blind: { n: 12, interference: 12, cost_usd: 9, mean_b_seconds: 5 }, live: { n: 12, interference: 0, cost_usd: 8, mean_b_seconds: 6 }, oracle: { n: 12, interference: 0 } } }));
  const rec = (scenario: string, cond: string, all_pass: boolean, broken: number, conflict: string | null) => JSON.stringify({ scenario, cond, all_pass, broken, conflict, wall_s: 30 });
  mkdirSync(join(bench, 'runs', 'e5', '20261016-115933'), { recursive: true });
  writeFileSync(join(bench, 'runs', 'e5', '20261016-115933', 'records.jsonl'), [
    ...[0, 1, 2].map(() => rec('t1_slugpath', 'blind', false, 1, null)), ...[0, 1, 2].map(() => rec('t1_slugpath', 'loom', true, 0, null)),
    ...[0, 1, 2].map(() => rec('x1_textlist', 'blind', false, 0, 'loom/x/c: conflict')), ...[0, 1, 2].map(() => rec('x1_textlist', 'loom', true, 0, null))].join('\n') + '\n');
  srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord(), home, benchDir: join(bench, 'results') });
});
afterAll(async () => { await srv.close(); await db.graph(graph).drop().catch(() => {}); await db.close(); });

const get = async (p: string, cwd = root) => {
  const r = await fetch(`http://127.0.0.1:${srv.port}${p}${p.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(cwd)}`, { headers: { 'x-loom-home': home } });
  return { status: r.status, body: await r.json() as any };
};

test('/people: each person with sessions, agents and regions', async () => {
  const { body } = await get('/people');
  expect(body.map((p: any) => p.person).sort()).toEqual(['a@t', 'b@t']);
  expect(body.find((p: any) => p.person === 'a@t')).toMatchObject({ sessions: 2, agents: 1, regions: 1 });
});

test('/collab: people as nodes, shared regions and collisions as edges', async () => {
  const { body } = await get('/collab');
  expect(body.nodes.map((n: any) => n.person).sort()).toEqual(['a@t', 'b@t']);
  expect(body.edges).toEqual([{ a: 'a@t', b: 'b@t', shared: 1, collisions: 1 }]);
});

test('/sessions: graph rows with parent, team, handoff and turn count; ?person filters', async () => {
  const { body } = await get('/sessions');
  expect(body).toHaveLength(3);
  expect(body.find((s: any) => s.sid === sA)).toMatchObject({ person: 'a@t', handoff: 'slugify done', turns: 1 });
  expect(body.find((s: any) => s.sid === sC)).toMatchObject({ parent: sA, team: 'T1', task: 'x' });
  expect((await get('/sessions?person=b@t')).body.map((s: any) => s.sid)).toEqual([sB]);
});

test('/sessions/:sid: turns, versions with commit, children', async () => {
  const { body, status } = await get(`/sessions/${sA}`);
  expect(status).toBe(200);
  expect(body.turns).toMatchObject([{ from: 'user', text: 'make slugify safe' }]);
  expect(body.versions).toHaveLength(1);
  expect(body.versions[0].region).toBe(R1);
  expect(body.versions[0].commit).toMatch(/^[0-9a-f]{40}$/);
  expect(body.children).toEqual([sC]);
  expect((await get('/sessions/NOPE')).status).toBe(404);
});

test('/collisions: the divergence with its parties; ?kind and ?person filter', async () => {
  const { body } = await get('/collisions');
  expect(body).toHaveLength(1);
  expect(body[0]).toMatchObject({ id: colId, kind: 'divergence', region: [R1], outcome: 'open', detail: 'both changed slugify' });
  expect(body[0].parties.map((p: any) => p.person).sort()).toEqual(['a@t', 'b@t']);
  expect((await get('/collisions?kind=stale_version')).body).toEqual([]);
  expect((await get('/collisions?person=zed@t')).body).toEqual([]);
});

test('/regions?q= finds regions by name; an empty query lists none', async () => {
  const hit = (await get('/regions?q=slug')).body;
  expect(hit.map((r: any) => r.id)).toContain(R1);
  expect((await get('/regions?q=zzz-none')).body).toEqual([]);
  expect((await get('/regions')).body).toEqual([]);
});

test('/regions/:id: versions in order with person, decision and commit; collisions at it', async () => {
  const { body, status } = await get(`/regions/${encodeURIComponent(R1)}`);
  expect(status).toBe(200);
  expect(body).toMatchObject({ id: R1, path: 'pkg/text.py' });
  expect(body.versions.map((v: any) => v.by)).toEqual(['a@t', 'b@t']);
  expect(body.versions[0].decision).toBe('keep it pure');
  expect(body.collisions).toMatchObject([{ id: colId, kind: 'divergence' }]);
  expect((await get('/regions/nope')).status).toBe(404);
});

test('/growth: per commit and person counts, ordered', async () => {
  const { body } = await get('/growth');
  expect(body.map((g: any) => [g.person, g.added, g.changed, g.removed])).toEqual([['a@t', 1, 0, 0], ['b@t', 0, 1, 0]]);
  expect(body[0].bucket).toMatch(/^[0-9a-f]{7}$/);
});

test('/brief: text naming the other person, and no watermark written', async () => {
  const { body } = await get('/brief?person=c@t');
  expect(body.text).toContain('a@t');
  const w = await db.graph(graph).query('MATCH (w:Watermark) RETURN w');
  expect(w).toEqual([]);
});

test('/bench/compare: e1 blind 12/12 vs loom 0/12, e5 t1 and x1 0/3 vs 3/3, no cost or time', async () => {
  const { body } = await get('/bench/compare');
  expect(body.e1).toEqual({ blind: { broke: 12, n: 12 }, loom: { broke: 0, n: 12 } });
  expect(body.e5).toEqual([
    { scenario: 't1_slugpath', blind: { all_pass: 0, n: 3, broken: 3, conflicts: 0 }, loom: { all_pass: 3, n: 3, broken: 0, conflicts: 0 } },
    { scenario: 'x1_textlist', blind: { all_pass: 0, n: 3, broken: 0, conflicts: 3 }, loom: { all_pass: 3, n: 3, broken: 0, conflicts: 0 } }]);
  expect(JSON.stringify(body)).not.toMatch(/cost|seconds|wall/);
});

test('an empty graph answers [] / {} (RF5)', async () => {
  const bare = gitTree({ 'a.py': 'x = 1\n' });
  const cfg = ensureLoomDir(bare, { repoId: repoId(bare), dirs: ['.'], excludes: [], testCmd: null, share: true });
  try {
    expect((await get('/people', bare)).body).toEqual([]);
    expect((await get('/collab', bare)).body).toEqual({ nodes: [], edges: [] });
    expect((await get('/collisions', bare)).body).toEqual([]);
    expect((await get('/growth', bare)).body).toEqual([]);
    expect((await get('/sessions', bare)).body).toEqual([]);
  } finally { await db.graph(graphName('vwt', cfg.repoId)).drop().catch(() => {}); }
});
