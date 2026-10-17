// §4.3 collision records: stable ids, one record per distinct collision, written to the team's coord file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { collisionId } from '@loom/memory';
import { LiveRoutes } from '../src/live/routes.js';
import { writeCollision } from '../src/team/collide.js';
import { Team } from '../src/team/team.js';
import { git, gitTree } from './helpers.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const P = (person: string, session: string) => ({ person, session, agent: null });
test("same inputs give same id; parties order doesn't matter", () => {
  const a = collisionId('lock_denied', [P('x', '1'), P('y', '2')], ['r1', 'r2'], 'v');
  expect(collisionId('lock_denied', [P('y', '2'), P('x', '1')], ['r2', 'r1'], 'v')).toBe(a);
  expect(collisionId('lock_denied', [P('x', '1'), P('y', '2')], ['r1'], 'v')).not.toBe(a);
});

let db: LoomDb; let routes: LiveRoutes; const runs: string[] = [];
beforeAll(async () => { db = await LoomDb.connect(); routes = new LiveRoutes(db); process.env.FAKE_COMMIT = '1'; });
afterAll(async () => { for (const r of runs) await db.graph(r).drop().catch(() => {}); await db.close(); delete process.env.FAKE_COMMIT; });

const coordOf = (repo: string, id: string) => readFileSync(join(repo, '.loom', 'sessions', `${id}.coord.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'collision');
async function team(repo: string, ids: string[]) {
  mkdirSync(join(repo, '.loom', 'plans'), { recursive: true });
  const p = join(repo, '.loom', 'plans', 'c.md');
  writeFileSync(p, `---\ngoal: c\ntasks:\n${ids.map((i) => `  - id: ${i}\n    title: ${i}\n    owns: []\n    prompt: hi`).join('\n')}\n---\n`);
  const t = await Team.start({ routes, bin: join(__dirname, 'fake-claude.mjs'), pollMs: 100 }, { repo, planPath: p, person: 'ann@x', leadSid: 'LEAD' });
  runs.push(t.id); return t;
}

test('a denied lease in a 2-agent team writes one lock_denied with both parties', async () => {
  const r = gitTree({ 'a.py': 'def f():\n    return 1\n' });
  const t = await team(r, ['a', 'b']);
  await t.stop();   // the fake agents would land and release at once: hold them still
  const run = routes.runs.get(t.id)!;
  const edit = (agent: string) => { const wt = t.view().agents.find((x) => x.id === agent)!.worktree;
    return routes.hook('PreToolUse', { live: run.live, g: run.g, agent, root: wt }, { hook_event_name: 'PreToolUse', cwd: wt, tool_name: 'Edit',
      tool_input: { file_path: join(wt, 'a.py'), old_string: 'return 1', new_string: 'return 2' } } as any); };
  expect(await edit('a')).toBe('');                    // a takes the lease
  for (let i = 0; i < 2; i++) expect(await edit('b')).toContain('deny');   // b is refused, twice: still one record
  const cs = coordOf(r, t.id).filter((c) => c.kind === 'lock_denied');
  expect(cs).toHaveLength(1);
  expect(cs[0].parties.map((p: any) => p.agent).sort()).toEqual(['a', 'b']);
  expect(cs[0].outcome).toBe('rejected');
}, 40_000);

test('writeCollision is idempotent per collision and returns the id', () => {
  const r = gitTree({ 'a.py': 'x = 1\n' });
  const c = { kind: 'landing_rejected' as const, region: ['r'], parties: [P('p', 's')], outcome: 'rejected' as const, detail: 'd', version: 'v' };
  const a = writeCollision(r, 'TEAM', c); const b = writeCollision(r, 'TEAM', c);
  expect(a).toBe(b);
  expect(coordOf(r, 'TEAM')).toHaveLength(1);
});

test('a contract_break landing writes landing_rejected', async () => {
  const r = gitTree({ 'a.py': 'def f(x):\n    return x\n\n\ndef g():\n    return f(1)\n' });
  const t = await team(r, ['a']);
  await t.stop();
  const wt = t.view().agents[0].worktree;
  writeFileSync(join(wt, 'a.py'), 'def f(x, k):\n    return x + k\n\n\ndef g():\n    return f(1)\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'break f');
  const res = await routes.land(t.id, 'a');
  expect(res?.status).toBe('contract_break');
  const cs = coordOf(r, t.id).filter((c) => c.kind === 'landing_rejected');
  expect(cs).toHaveLength(1);
  expect(cs[0]).toMatchObject({ outcome: 'rejected', parties: [{ person: 'ann@x', agent: 'a' }] });
}, 40_000);
