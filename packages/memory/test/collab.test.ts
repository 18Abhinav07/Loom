import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { appendEvent } from '../src/events.js';
import { ulid } from '../src/ids.js';
import { indexRepo } from '../src/indexrepo.js';
import { sync } from '../src/sync.js';
import { as, closeDb, pair, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const SRC = { 'pkg/text.py': 'def slugify(v):\n    return v\n', 'pkg/other.py': 'def z():\n    return 0\n' };
const SLUG = 'pkg/text.py::slugify::definition#0';

/** `who` lands a Version of slugify in a session of their own and commits the session file. */
function land(root: string, who: 'A' | 'B') {
  const sid = ulid();
  appendEvent(root, sid, 'main', { type: 'session', person: `${who}@t`, kind: 'interactive', base: '', upstream: 'origin/main' });
  appendEvent(root, sid, 'main', { type: 'agent', name: 'main', model: 'm' });
  appendEvent(root, sid, 'main', { type: 'version', region: SLUG, hash: who, sig: 'slugify(v)', deleted: false, degraded: false, prev: [], by: 'main', task: null });
  as(who)(root, 'add', '-A'); as(who)(root, 'commit', '-qm', `${who} slugify`);
  return sid;
}
const collisions = (root: string) => readdirSync(join(root, '.loom/sessions')).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => readFileSync(join(root, '.loom/sessions', f), 'utf8').split('\n').filter((l) => l.includes('"type":"collision"')).map((l) => JSON.parse(l)));

async function clones() {
  const { a, b } = pair(SRC);
  ensureLoomDir(a, CFG);
  as('A')(a, 'add', '-A'); as('A')(a, 'commit', '-qm', 'loom'); as('A')(a, 'push', '-q');
  as('B')(b, 'pull', '-q'); ensureLoomDir(b, CFG);
  const ga = await testGraph(), gb = await testGraph();
  await indexRepo(ga, a, { baseline: true }); await indexRepo(gb, b, { baseline: true });
  return { a, b, ga, gb };
}
const count = async (g: Awaited<ReturnType<typeof testGraph>>) => (await g.query<{ n: number }>("MATCH (c:Collision {kind: 'divergence'}) RETURN count(c) AS n"))[0].n;

test('sync twice → one divergence (RF4)', async () => {
  const { a, b, ga, gb } = await clones();
  land(a, 'A'); as('A')(a, 'push', '-q');
  land(b, 'B');
  await sync(gb, b, { me: 'B@t', fetch: true, quiet: true });
  await sync(gb, b, { me: 'B@t', fetch: true, quiet: true });
  expect(await count(gb)).toBe(1);
  expect(collisions(b)).toHaveLength(1);
  const [c] = collisions(b);
  expect(c).toMatchObject({ kind: 'divergence', outcome: 'open', region: [SLUG] });
  expect(c.parties.map((p: any) => p.person).sort()).toEqual(['A@t', 'B@t']);
  await ga.drop(); await gb.drop();
});

test('after push and pull each graph has exactly one divergence', async () => {
  const { a, b, ga, gb } = await clones();
  land(a, 'A'); as('A')(a, 'push', '-q');
  land(b, 'B');
  await sync(gb, b, { me: 'B@t', fetch: true, quiet: true });
  as('B')(b, 'add', '-A'); as('B')(b, 'commit', '-qm', 'divergence record');
  as('B')(b, 'pull', '-q', '--no-rebase', '--no-edit'); as('B')(b, 'push', '-q');
  as('A')(a, 'pull', '-q', '--no-rebase', '--no-edit');
  await sync(ga, a, { me: 'A@t', fetch: true, quiet: true });
  expect(await count(ga)).toBe(1);
  await sync(gb, b, { me: 'B@t', fetch: true, quiet: true });
  expect(await count(gb)).toBe(1);
  await ga.drop(); await gb.drop();
});

test('no divergence when only one side changed the region', async () => {
  const { a, b, ga, gb } = await clones();
  land(a, 'A'); as('A')(a, 'push', '-q');
  await sync(gb, b, { me: 'B@t', fetch: true, quiet: true });
  expect(await count(gb)).toBe(0);
  await ga.drop(); await gb.drop();
});
