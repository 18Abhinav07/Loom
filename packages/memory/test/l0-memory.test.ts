import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { initRepo } from '../../cli/src/loom.js';
import { appendEvent } from '../src/events.js';
import { graphName, repoId } from '../src/ids.js';
import { importSessions } from '../src/importer.js';
import { startSession } from '../src/session.js';
import { sync } from '../src/sync.js';
import { currentVersion } from '../src/versions.js';

// L0 memory gate (P2 Task 12): two clones, two tenants, the real git hooks running the bundled CLI (`pnpm build:cli` first).
const LOOM = `node ${resolve(__dirname, '../../cli/dist/loom.cjs')}`;
const SRC = { 'pkg/text.py': 'def slugify(v):\n    return v\n\ndef title(v):\n    return slugify(v).title()\n', 'pkg/other.py': 'def z():\n    return 0\n' };
const SLUG = 'pkg/text.py::slugify::definition#0';

let db: LoomDb; let ga: LoomGraph; let gb: LoomGraph;
const tmp = mkdtempSync(join(tmpdir(), 'loom-l0-'));
const origin = join(tmp, 'origin.git'), a = join(tmp, 'a'), b = join(tmp, 'b');
const home = (t: string) => { const d = join(tmp, `home-${t}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'config.json'), JSON.stringify({ tenant: t })); return d; };
const HOME = { [a]: home('l0a'), [b]: home('l0b') };
/** git in a clone, as that clone's tenant, so the hooks it fires resolve that tenant's graph. */
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LOOM_HOME: HOME[cwd] }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edit = (cwd: string, f: string, from: string, to: string) => writeFileSync(join(cwd, f), readFileSync(join(cwd, f), 'utf8').replace(from, to));
const versionLines = (cwd: string) => readdirSync(join(cwd, '.loom/sessions')).flatMap((f) => readFileSync(join(cwd, '.loom/sessions', f), 'utf8').split('\n'))
  .filter((l) => l.includes('"type":"version"'));
const commitsOf = async (gr: LoomGraph, id: string) => (await gr.query<{ c: string[] }>('MATCH (v:Version {id: $id}) RETURN v.commits AS c', { id }))[0]?.c;

beforeAll(async () => {
  db = await LoomDb.connect();
  const src = join(tmp, 'src'); mkdirSync(join(src, 'pkg'), { recursive: true });
  for (const [f, t] of Object.entries(SRC)) writeFileSync(join(src, f), t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: src });
  execFileSync('git', ['-c', 'user.email=A@t', '-c', 'user.name=A', 'add', '-A'], { cwd: src });
  execFileSync('git', ['-c', 'user.email=A@t', '-c', 'user.name=A', 'commit', '-qm', 'base'], { cwd: src });
  execFileSync('git', ['clone', '-q', '--bare', src, origin]);
  for (const [c, who] of [[a, 'A'], [b, 'B']]) {
    execFileSync('git', ['clone', '-q', origin, c]);
    execFileSync('git', ['config', 'user.email', `${who}@t`], { cwd: c }); execFileSync('git', ['config', 'user.name', who], { cwd: c });
  }
  await initRepo(a, { hookCmd: 'true', loomCmd: LOOM, tenant: 'l0a', db });
  g(a, 'add', '-A'); g(a, 'commit', '-qm', 'loom init'); g(a, 'push', '-q');
  g(b, 'pull', '-q');
  await initRepo(b, { hookCmd: 'true', loomCmd: LOOM, tenant: 'l0b', db });
  ga = db.graph(graphName('l0a', repoId(a))); gb = db.graph(graphName('l0b', repoId(b)));
  await sync(gb, b, { me: 'B@t', fetch: true, quiet: true });             // B's watermark: later news is "since"
}, 60000);
afterAll(async () => { await ga?.drop(); await gb?.drop(); await db?.close(); });

let vA = ''; let sidA = '';
test('1. A commits a session edit through the real hooks: the version event is in the commit; Version.commits = [sha]', async () => {
  sidA = (await startSession(ga, a, { person: 'A@t', kind: 'interactive' })).sid;
  edit(a, 'pkg/text.py', 'slugify(v):', 'slugify(v, *, strict=False):');
  g(a, 'add', 'pkg/text.py'); g(a, 'commit', '-qm', 'strict slugify');
  const sha = g(a, 'rev-parse', 'HEAD');
  const file = `.loom/sessions/${sidA}.main.jsonl`;
  expect(g(a, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toContain(file);
  const ev = g(a, 'show', `HEAD:${file}`).split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'version' && e.region === SLUG);
  expect(ev).toBeTruthy(); vA = ev.id;
  expect(await commitsOf(ga, vA)).toEqual([sha]);
  g(a, 'push', '-q');
}, 60000);

test('2. B sees A\'s pushed change before pulling (X2)', async () => {
  const out = await sync(gb, b, { me: 'B@t', fetch: true, quiet: true });
  expect(out.fetched).toBe(true);
  expect(out.briefing).toMatch(/slugify \(pkg\/text\.py\) changed on origin\/main by A@t.*not in your branch yet/);
  expect(g(b, 'rev-parse', 'HEAD')).not.toBe(g(b, 'rev-parse', 'origin/main'));
}, 60000);

test('3. B pulls: post-merge moves Region.HEAD to A\'s version; the briefing stops saying "not in your branch yet"', async () => {
  g(b, 'pull', '-q');
  expect(g(b, 'status', '--porcelain')).toBe('');                                   // hooks never dirty a tracked file
  expect((await gb.query<{ v: string }>('MATCH (:Region {id: $r})-[:HEAD]->(v:Version) RETURN v.id AS v', { r: SLUG })).map((x) => x.v)).toEqual([vA]);
  const { briefing } = await sync(gb, b, { me: 'B@t', fetch: false, quiet: true });
  expect(briefing).not.toMatch(/slugify.*not in your branch yet/);
}, 60000);

test('4. B commits on slugify with --no-verify: A\'s next sync makes ext:<sha>:slugify BY B@t', async () => {
  edit(b, 'pkg/text.py', '    return v\n', '    return v.lower()\n');
  g(b, 'commit', '-qam', 'lower', '--no-verify'); const sha = g(b, 'rev-parse', 'HEAD'); g(b, 'push', '-q');
  await sync(ga, a, { me: 'A@t', fetch: true, quiet: true });
  expect(await ga.query('MATCH (v:Version {id: $id, external: true})-[:BY]->(:Person {id: \'B@t\'}) RETURN 1', { id: `ext:${sha}:${SLUG}` })).toHaveLength(1);
  g(a, 'pull', '-q');
}, 60000);

test('5. diverging branches, one session file each: merge has no conflict; import counts every event once', async () => {
  appendEvent(a, sidA, 'main', { type: 'decision', text: 'z stays 0', regions: ['pkg/other.py::z::definition#0'], by: 'main', led_to: [] });
  edit(a, 'pkg/other.py', 'return 0', 'return 00'); g(a, 'add', '-A'); g(a, 'commit', '-qm', 'a: z');
  await startSession(gb, b, { person: 'B@t', kind: 'interactive' });
  edit(b, 'pkg/text.py', '.title()', '.title().strip()'); g(b, 'add', 'pkg/text.py'); g(b, 'commit', '-qm', 'b: title'); g(b, 'push', '-q');
  g(a, 'pull', '-q', '--no-rebase', '--no-edit');
  expect(g(a, 'ls-files', '-u')).toBe('');
  expect(g(a, 'log', '-1', '--format=%p').split(' ')).toHaveLength(2);           // a real merge, not a fast-forward
  expect((await importSessions(ga, a, null)).events).toBe(0);                      // the post-merge hook already imported; re-import is a no-op
  const lines = versionLines(a);
  expect(new Set(lines.map((l) => JSON.parse(l).id)).size).toBe(lines.length);
  const [{ n }] = await ga.query<{ n: number }>('MATCH (v:Version) WHERE NOT coalesce(v.external, false) AND NOT coalesce(v.baseline, false) RETURN count(v) AS n');
  expect(n).toBe(lines.length);
  g(a, 'push', '-q'); g(b, 'pull', '-q');
}, 90000);

test('6. A rebases: the rebased sha joins commits[]; current-per-ref on the rebased HEAD finds A\'s version', async () => {
  edit(a, 'pkg/text.py', 'return v.lower()', 'return v.lower().strip()'); g(a, 'add', 'pkg/text.py'); g(a, 'commit', '-qm', 'a: strip');
  const before = g(a, 'rev-parse', 'HEAD');
  const vR = g(a, 'show', `HEAD:.loom/sessions/${sidA}.main.jsonl`).split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'version' && e.region === SLUG).at(-1).id;
  edit(b, 'pkg/other.py', 'return 00', 'return 000'); g(b, 'add', 'pkg/other.py'); g(b, 'commit', '-qm', 'b: z'); g(b, 'push', '-q');
  g(a, 'pull', '-q', '--rebase');
  const after = g(a, 'rev-parse', 'HEAD');
  expect(after).not.toBe(before);
  expect(await commitsOf(ga, vR)).toEqual(expect.arrayContaining([before, after]));
  expect(await currentVersion(ga, a, SLUG, 'HEAD')).toBe(vR);
}, 90000);

test('7. FalkorDB unreachable: git commit still succeeds and says [loom] … continuing', () => {
  edit(a, 'pkg/other.py', 'def z():', 'def z():  # offline');
  g(a, 'add', 'pkg/other.py');
  const t = Date.now();
  const r = spawnSync('git', ['commit', '-qm', 'offline'], { cwd: a, encoding: 'utf8', env: { ...process.env, LOOM_HOME: HOME[a], FALKORDB_URL: 'redis://127.0.0.1:1' } });
  expect(r.status).toBe(0);
  expect(r.stderr).toMatch(/\[loom\].*continuing/);
  expect(g(a, 'log', '-1', '--format=%s')).toBe('offline');
  expect(Date.now() - t).toBeLessThan(10000);
}, 30000);
