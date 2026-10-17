// §3.4 Team scheduler: N agents, `after` order, crash handling, isolation between teams, session events. Fake claude, real FalkorDB.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { LiveRoutes } from '../src/live/routes.js';
import { Team } from '../src/team/team.js';
import { gitTree, tmpRecord } from './helpers.js';

const BIN = join(__dirname, 'fake-claude.mjs');
let db: LoomDb; let routes: LiveRoutes;
const runs: string[] = [];
beforeAll(async () => { db = await LoomDb.connect(); routes = new LiveRoutes(db); process.env.FAKE_COMMIT = '1'; });
afterAll(async () => { for (const r of runs) await db.graph(r).drop().catch(() => {}); await db.close(); delete process.env.FAKE_COMMIT; });

const plan = (repo: string, slug: string, tasks: { id: string; after?: string[]; prompt?: string }[]) => {
  const y = tasks.map((t) => `  - id: ${t.id}\n    title: ${t.id}\n    owns: []\n    after: [${(t.after ?? []).join(', ')}]\n    prompt: ${t.prompt ?? 'do ' + t.id}`).join('\n');
  mkdirSync(join(repo, '.loom', 'plans'), { recursive: true });
  const p = join(repo, '.loom', 'plans', `${slug}.md`);
  writeFileSync(p, `---\ngoal: test ${slug}\ntasks:\n${y}\n---\nbody\n`);
  return p;
};
const start = async (repo: string, slug: string, tasks: Parameters<typeof plan>[2], extra = {}) => {
  const t = await Team.start({ routes, bin: BIN, pollMs: 100 }, { repo, planPath: plan(repo, slug, tasks), person: 'ann@x', leadSid: 'LEAD', ...extra });
  runs.push(t.id); return t;
};
const coord = (repo: string, id: string) => readFileSync(join(repo, '.loom', 'sessions', `${id}.coord.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const repo = () => gitTree({ 'a.py': 'def f():\n    return 1\n' });
const states = (v: { agents: { id: string; state: string }[] }) => Object.fromEntries(v.agents.map((a) => [a.id, a.state]));

test('a one-task plan lands', async () => {
  const r = repo(); const t = await start(r, 'one', [{ id: 'a' }]);
  expect(states(await t.done())).toEqual({ a: 'landed' });
}, 30_000);

test('three independent tasks all land, running in parallel', async () => {
  const r = repo(); const t = await start(r, 'par', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const v = await t.done();
  expect(states(v)).toEqual({ a: 'landed', b: 'landed', c: 'landed' });
  const starts = coord(r, t.id).filter((e) => e.action === 'agent_started').length;
  expect(starts).toBe(3);
}, 30_000);

test('five tasks: c waits for a and b', async () => {
  const r = repo(); const t = await start(r, 'ord', [{ id: 'a' }, { id: 'b' }, { id: 'c', after: ['a', 'b'] }, { id: 'd' }, { id: 'e', after: ['d'] }]);
  const v = await t.done();
  expect(Object.values(states(v)).every((s) => s === 'landed')).toBe(true);
  const ev = coord(r, t.id).filter((e) => e.action === 'agent_started' || e.action === 'agent_landed').map((e) => `${e.action}:${e.agent}`);
  expect(ev.indexOf('agent_started:c')).toBeGreaterThan(ev.indexOf('agent_landed:a'));
  expect(ev.indexOf('agent_started:c')).toBeGreaterThan(ev.indexOf('agent_landed:b'));
  expect(ev.indexOf('agent_started:e')).toBeGreaterThan(ev.indexOf('agent_landed:d'));
}, 40_000);

test('a crashed agent fails, its dependant is blocked, an independent one still lands', async () => {
  const r = repo(); const t = await start(r, 'crash', [{ id: 'a', prompt: 'CRASH now' }, { id: 'b', after: ['a'] }, { id: 'c' }]);
  expect(states(await t.done())).toEqual({ a: 'failed', b: 'blocked', c: 'landed' });
}, 30_000);

test('two teams in one repo have disjoint worktrees, branches and coord files', async () => {
  const r = repo();
  const [t1, t2] = await Promise.all([start(r, 'p1', [{ id: 'a' }]), start(r, 'p2', [{ id: 'a' }])]);
  const [v1, v2] = await Promise.all([t1.done(), t2.done()]);
  expect(t1.id).not.toBe(t2.id);
  expect(v1.agents[0].worktree).not.toBe(v2.agents[0].worktree);
  expect(v1.agents[0].branch).not.toBe(v2.agents[0].branch);
  expect(v1.landed).not.toBe(v2.landed);
  expect(readdirSync(join(r, '.loom', 'sessions')).filter((f) => f.endsWith('.coord.jsonl')).length).toBe(2);
}, 30_000);

test("an agent's session event names parent, team, plan, task and person", async () => {
  const r = repo(); const t = await start(r, 'ev', [{ id: 'a' }]); const v = await t.done();
  const sid = v.agents[0].sid;
  const first = JSON.parse(readFileSync(join(r, '.loom', 'sessions', `${sid}.a.jsonl`), 'utf8').split('\n')[0]);
  expect(first).toMatchObject({ type: 'session', kind: 'agent', parent: 'LEAD', team: t.id, plan: 'ev', task: 'a', person: 'ann@x' });
}, 30_000);
