import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { appendEvent } from '../src/events.js';
import { ulid } from '../src/ids.js';
import { importSessions } from '../src/importer.js';
import { currentVersion, history } from '../src/versions.js';
import { closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const R = 'a.py::f::definition#0';
const count = async (g: any, q: string) => (await g.query(q))[0].n as number;

function seed() {
  const r = repo({ 'a.py': 'def f():\n    return 1\n' }); ensureLoomDir(r, CFG);
  const sid = ulid();
  appendEvent(r, sid, 'main', { type: 'session', person: 'a@t', kind: 'interactive', base: sh(r, 'rev-parse', 'HEAD'), upstream: 'origin/main' });
  appendEvent(r, sid, 'main', { type: 'agent', name: 'main', model: 'sonnet' });
  const v1 = appendEvent(r, sid, 'main', { type: 'version', region: R, hash: 'h1', sig: 'f()', deleted: false, degraded: false, prev: [], by: 'main', task: null });
  appendEvent(r, sid, 'main', { type: 'decision', text: 'return 1 on purpose', regions: [R], by: 'main', led_to: [v1.id] });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'c1');
  return { r, sid, v1 };
}

test('import is idempotent and maps events to nodes and edges', async () => {
  const { r, sid, v1 } = seed(); const g = await testGraph();
  const a = await importSessions(g, r, null);
  const n1 = await count(g, 'MATCH (n) RETURN count(n) AS n');
  const e1 = await count(g, 'MATCH ()-[e]->() RETURN count(e) AS n');
  const b = await importSessions(g, r, null);
  expect(a).toMatchObject({ files: 1, skipped: 0, events: 4 });
  expect(b).toMatchObject({ files: 1, skipped: 1, events: 0 });
  expect(await count(g, 'MATCH (n) RETURN count(n) AS n')).toBe(n1);
  expect(await count(g, 'MATCH ()-[e]->() RETURN count(e) AS n')).toBe(e1);
  expect(await g.query(`MATCH (:Person {id: 'a@t'})-[:STARTED]->(:Session {id: $sid})-[:RAN]->(:Agent {id: $ag})
    <-[:BY]-(:Version {id: $v})-[:OF]->(:Region {id: $R}) RETURN 1`, { sid, ag: `${sid}/main`, v: v1.id, R })).toHaveLength(1);
  expect(await g.query(`MATCH (:Decision)-[:LED_TO]->(:Version {id: $v}) RETURN 1`, { v: v1.id })).toHaveLength(1);
  expect(await g.query(`MATCH (:Decision)-[:ABOUT]->(:Region {id: $R}) RETURN 1`, { R })).toHaveLength(1);
  await g.drop();
});

test('a decision with no regions still links LED_TO', async () => {
  const { r, sid, v1 } = seed(); const g = await testGraph();
  appendEvent(r, sid, 'main', { type: 'decision', text: 'no regions', regions: [], by: 'main', led_to: [v1.id] });
  await importSessions(g, r, null);
  expect(await g.query(`MATCH (:Decision {text: 'no regions'})-[:LED_TO]->(:Version {id: $v}) RETURN 1`, { v: v1.id })).toHaveLength(1);
  await g.drop();
});

test('commit association: committed line → its commit; uncommitted → []; after amend the new sha joins commits[]', async () => {
  const { r, sid, v1 } = seed(); const g = await testGraph();
  const c1 = sh(r, 'rev-parse', 'HEAD');
  const v2 = appendEvent(r, sid, 'main', { type: 'version', region: R, hash: 'h2', sig: 'f()', deleted: false, degraded: false, prev: [v1.id], by: 'main', task: null });
  await importSessions(g, r, null);
  const get = async (id: string) => (await g.query<{ c: string[] }>('MATCH (v:Version {id: $id}) RETURN v.commits AS c', { id }))[0].c;
  expect(await get(v1.id)).toEqual([c1]);
  expect(await get(v2.id)).toEqual([]);
  expect(await currentVersion(g, r, R, 'HEAD')).toBe(v1.id);
  sh(r, 'add', '-A'); sh(r, 'commit', '-q', '--amend', '--no-edit');
  const c1b = sh(r, 'rev-parse', 'HEAD');
  await importSessions(g, r, null);
  expect((await get(v1.id)).sort()).toEqual([c1, c1b].sort());
  expect(await currentVersion(g, r, R, 'HEAD')).toBe(v2.id);
  expect((await history(g, R)).map((h) => [h.id, h.ord])).toEqual([[v1.id, 1], [v2.id, 2]]);
  await g.drop();
});

test('import from a ref reads records with git show, without checking it out', async () => {
  const { r } = seed(); const g = await testGraph();
  sh(r, 'checkout', '-qb', 'side'); const sid = ulid();
  appendEvent(r, sid, 'main', { type: 'lesson', text: 'run SlugifyTests', regions: [R], source: 'manual' });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'side'); sh(r, 'checkout', '-q', 'main');
  await importSessions(g, r, 'side');
  expect(await g.query(`MATCH (:Lesson {text: 'run SlugifyTests'})-[:ON]->(:Region {id: $R}) RETURN 1`, { R })).toHaveLength(1);
  await g.drop();
});

test('current per ref: diverged branches each see their own version', async () => {
  const { r, sid, v1 } = seed(); const g = await testGraph();
  sh(r, 'checkout', '-qb', 'x');
  const vx = appendEvent(r, sid, 'main', { type: 'version', region: R, hash: 'hx', sig: 'f()', deleted: false, degraded: false, prev: [v1.id], by: 'main', task: null });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'x');
  sh(r, 'checkout', '-q', 'main'); const s2 = ulid();
  const vy = appendEvent(r, s2, 'main', { type: 'version', region: R, hash: 'hy', sig: 'f()', deleted: false, degraded: false, prev: [v1.id], by: 'main', task: null });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'y');
  await importSessions(g, r, null); await importSessions(g, r, 'x');
  expect(await currentVersion(g, r, R, 'x')).toBe(vx.id);
  expect(await currentVersion(g, r, R, 'main')).toBe(vy.id);
  await g.drop();
});

test('B3: turn, tool, plan, team and collision events become nodes and edges; session fields link Team and Plan', async () => {
  const r = repo({ 'a.py': 'def f():\n    return 1\n' }); ensureLoomDir(r, CFG);
  const lead = ulid(), agent = ulid();
  appendEvent(r, lead, 'lead', { type: 'session', person: 'a@t', kind: 'interactive', base: null, upstream: null, surface: 'terminal', claude: 'c1', parent: null, team: null, plan: null, task: null });
  appendEvent(r, lead, 'lead', { type: 'turn', from: 'user', text: 'build the thing' });
  appendEvent(r, lead, 'lead', { type: 'turn', from: 'claude', text: 'drafted a plan', tools: { Write: 1 } });
  appendEvent(r, lead, 'lead', { type: 'tool', name: 'Write', target: '.loom/plans/p.md', ok: true, ms: 12 });
  appendEvent(r, lead, 'lead', { type: 'plan', slug: 'p', action: 'checked', problems: [] });
  appendEvent(r, lead, 'lead', { type: 'team', team: 'T1', plan: 'p', action: 'started', detail: '2 agents' });
  appendEvent(r, agent, 'main', { type: 'session', person: 'a@t', kind: 'run', base: null, upstream: null, surface: 'headless', parent: lead, team: 'T1', plan: 'p', task: 'k1' });
  appendEvent(r, lead, 'lead', { type: 'collision', id: 'col_1', kind: 'lock_wait', region: [R], outcome: 'waited', waited_ms: 900, detail: 'x waited for y',
    parties: [{ person: 'a@t', session: lead, agent: 'x' }, { person: 'a@t', session: agent, agent: 'y' }] });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'c');
  const g = await testGraph();
  await importSessions(g, r, null);
  expect(await count(g, `MATCH (:Turn)-[:IN]->(:Session {id: '${lead}'}) RETURN count(*) AS n`)).toBe(2);
  expect(await g.query(`MATCH (t:Turn {from: 'claude'}) RETURN t.text AS text, t.tools AS tools`)).toEqual([{ text: 'drafted a plan', tools: '{"Write":1}' }]);
  expect(await count(g, `MATCH (:Tool {name: 'Write', ok: true})-[:IN]->(:Session {id: '${lead}'}) RETURN count(*) AS n`)).toBe(1);
  expect(await count(g, `MATCH (p:Plan {slug: 'p'}) WHERE p.action = 'checked' RETURN count(*) AS n`)).toBe(1);
  expect(await count(g, `MATCH (:Session {id: '${agent}'})-[:IN]->(:Team {id: 'T1'})-[:OF]->(:Plan {slug: 'p'}) RETURN count(*) AS n`)).toBe(1);
  expect(await count(g, `MATCH (:Session {id: '${agent}'})-[:CHILD_OF]->(:Session {id: '${lead}'}) RETURN count(*) AS n`)).toBe(1);
  expect(await g.query(`MATCH (s:Session {id: '${lead}'}) RETURN s.surface AS surface, s.claude AS claude`)).toEqual([{ surface: 'terminal', claude: 'c1' }]);
  expect(await count(g, `MATCH (c:Collision {id: 'col_1', kind: 'lock_wait', outcome: 'waited'})-[:AT]->(:Region {id: '${R}'}) RETURN count(*) AS n`)).toBe(1);
  expect(await count(g, `MATCH (:Collision {id: 'col_1'})-[:BETWEEN]->(s:Session) RETURN count(DISTINCT s) AS n`)).toBe(2);
  await g.drop();
});
