import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { graphName, repoId, startSession, sync } from '@loom/memory';
import { initRepo } from '../../../cli/src/loom.js';
import { ackStale, staleRegions, upstreamOf } from '../../src/live/stale.js';

// §6.5 version check on two real clones; hooks run the bundled CLI (`pnpm build:cli` first).
const LOOM = `node ${resolve(__dirname, '../../../cli/dist/loom.cjs')}`;
const SLUG = 'pkg/text.py::slugify::definition#0';
let db: LoomDb; let ga: LoomGraph; let gb: LoomGraph;
const tmp = mkdtempSync(join(tmpdir(), 'loom-stale-'));
const origin = join(tmp, 'origin.git'), a = join(tmp, 'a'), b = join(tmp, 'b');
const home = (t: string) => { const d = join(tmp, `home-${t}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'config.json'), JSON.stringify({ tenant: t })); return d; };
const HOME = { [a]: home('sta'), [b]: home('stb') };
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LOOM_HOME: HOME[cwd] }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edit = (cwd: string, from: string, to: string) => { const f = join(cwd, 'pkg/text.py'); writeFileSync(f, readFileSync(f, 'utf8').replace(from, to)); };
const ME_B = { upstream: 'origin/main', me: { person: 'B@t', agent: 'b1', run: false } };
/** A commits an edit to slugify in its session and pushes; B fetches (sync) without pulling. */
async function aPushes(from: string, to: string) {
  edit(a, from, to); g(a, 'add', 'pkg/text.py'); g(a, 'commit', '-qm', `a: ${to.trim()}`); g(a, 'push', '-q');
  await sync(gb, b, { me: 'B@t', fetch: true, quiet: true });
}

beforeAll(async () => {
  db = await LoomDb.connect();
  const src = join(tmp, 'src'); mkdirSync(join(src, 'pkg'), { recursive: true });
  writeFileSync(join(src, 'pkg/text.py'), 'def slugify(v):\n    return v\n\ndef title(v):\n    return slugify(v).title()\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: src });
  execFileSync('git', ['-c', 'user.email=A@t', '-c', 'user.name=A', 'add', '-A'], { cwd: src });
  execFileSync('git', ['-c', 'user.email=A@t', '-c', 'user.name=A', 'commit', '-qm', 'base'], { cwd: src });
  execFileSync('git', ['clone', '-q', '--bare', src, origin]);
  for (const [c, who] of [[a, 'A'], [b, 'B']]) {
    execFileSync('git', ['clone', '-q', origin, c]);
    execFileSync('git', ['config', 'user.email', `${who}@t`], { cwd: c }); execFileSync('git', ['config', 'user.name', who], { cwd: c });
  }
  await initRepo(a, { hookCmd: 'true', loomCmd: LOOM, tenant: 'sta', db });
  g(a, 'add', '-A'); g(a, 'commit', '-qm', 'loom init'); g(a, 'push', '-q');
  g(b, 'pull', '-q');
  await initRepo(b, { hookCmd: 'true', loomCmd: LOOM, tenant: 'stb', db });
  ga = db.graph(graphName('sta', repoId(a))); gb = db.graph(graphName('stb', repoId(b)));
  await startSession(ga, a, { person: 'A@t', kind: 'interactive' });
  await aPushes('    return v\n', '    return v.lower()\n');
}, 90000);
afterAll(async () => { await ga?.drop(); await gb?.drop(); await db?.close(); });

test('B edits slugify after A pushed a change to it: stale, by A, with the summary', async () => {
  const s = await staleRegions(gb, b, [SLUG], ME_B);
  expect(s).toHaveLength(1);
  expect(s[0]).toMatchObject({ region: SLUG, by: 'A@t' });
  expect(s[0].summary).toMatch(/^slugify changed on origin\/main by A@t/);
}, 30000);

test('after B pulls: not stale', async () => {
  g(b, 'pull', '-q');
  expect(await staleRegions(gb, b, [SLUG], ME_B)).toEqual([]);
}, 30000);

test('ack passes until a newer version appears', async () => {
  await aPushes('v.lower()', 'v.lower().strip()');
  const [v2] = await staleRegions(gb, b, [SLUG], ME_B);
  expect(v2).toBeTruthy();
  await ackStale(gb, 'b1', SLUG, v2.version);
  expect(await staleRegions(gb, b, [SLUG], ME_B)).toEqual([]);
  expect(await staleRegions(gb, b, [SLUG], { ...ME_B, me: { ...ME_B.me, agent: 'b2' } })).toHaveLength(1);   // an ack is per agent
  await aPushes('v.lower().strip()', 'v.strip().lower()');
  const [v3] = await staleRegions(gb, b, [SLUG], ME_B);
  expect(v3?.version).toBeTruthy();
  expect(v3.version).not.toBe(v2.version);
}, 60000);

test('my own pushed version is never stale for me, even when my HEAD is behind it', async () => {
  g(a, 'checkout', '-q', 'HEAD~1');
  try {
    expect(await staleRegions(ga, a, [SLUG], { upstream: 'origin/main', me: { person: 'A@t', agent: 'a1', run: false } })).toEqual([]);
    expect(await staleRegions(ga, a, [SLUG], { upstream: 'origin/main', me: { person: 'C@t', agent: 'c1', run: false } })).toHaveLength(1);
  } finally { g(a, 'checkout', '-q', 'main'); }
}, 30000);

test('upstream: run landed branch wins; a clone tracks origin/main; no remote → null', () => {
  expect(upstreamOf(b, 'loom/abcd1234/landed')).toBe('loom/abcd1234/landed');
  expect(upstreamOf(b)).toBe('origin/main');
  const lone = mkdtempSync(join(tmpdir(), 'loom-lone-')); execFileSync('git', ['init', '-q'], { cwd: lone });
  expect(upstreamOf(lone)).toBeNull();
});
