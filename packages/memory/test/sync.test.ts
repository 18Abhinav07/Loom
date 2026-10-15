import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { appendEvent } from '../src/events.js';
import { ulid } from '../src/ids.js';
import { indexRepo } from '../src/indexrepo.js';
import { renderBriefing, type NewsItem } from '../src/news.js';
import { sync } from '../src/sync.js';
import { as, closeDb, pair, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const SRC = { 'pkg/text.py': 'def slugify(v):\n    return v\n\ndef title(v):\n    return slugify(v).title()\n', 'pkg/other.py': 'def z():\n    return 0\n' };
const SLUG = 'pkg/text.py::slugify::definition#0';

test('X2 mechanics: B learns of A\'s pushed change and decision BEFORE pulling', async () => {
  const { a, b } = pair(SRC);
  ensureLoomDir(a, CFG);
  as('A')(a, 'add', '-A'); as('A')(a, 'commit', '-qm', 'loom'); as('A')(a, 'push', '-q');
  as('B')(b, 'pull', '-q'); ensureLoomDir(b, CFG);
  const gb = await testGraph(); await indexRepo(gb, b, { baseline: true });
  await sync(gb, b, { me: 'B@t', fetch: true });                            // B's first sync: watermark set
  const sid = ulid();
  appendEvent(a, sid, 'main', { type: 'session', person: 'A@t', kind: 'interactive', base: '', upstream: 'origin/main' });
  const v = appendEvent(a, sid, 'main', { type: 'version', region: SLUG, hash: 'h', sig: 'slugify(v, *, strict)', deleted: false, degraded: false, prev: [], by: 'main', task: 'T4' });
  appendEvent(a, sid, 'main', { type: 'decision', text: 'strict is keyword-only', regions: [SLUG], by: 'main', led_to: [v.id] });
  writeFileSync(join(a, 'pkg/text.py'), SRC['pkg/text.py'].replace('slugify(v)', 'slugify(v, *, strict=False)'));
  as('A')(a, 'add', '-A'); as('A')(a, 'commit', '-qm', 'strict slugify'); as('A')(a, 'push', '-q');
  const out = await sync(gb, b, { me: 'B@t', fetch: true });
  expect(out.fetched).toBe(true);
  expect(out.briefing).toMatch(/slugify \(pkg\/text\.py\) changed on origin\/main by A@t.*not in your branch yet/);
  expect(out.briefing).toMatch(/strict is keyword-only/);
  expect(sh(b, 'rev-parse', 'HEAD')).not.toBe(sh(b, 'rev-parse', 'origin/main'));   // B never pulled
  await gb.drop();
});

test('scores: 3 scope > 2 within 2 hops > 1 file I touched; top 10; tie → newer first', () => {
  const item = (o: Partial<NewsItem>): NewsItem => ({ kind: 'version', id: 'x', region: SLUG, path: 'pkg/text.py', text: '', by: 'b', person: 'B@t',
    task: null, at: 1, score: 1, upstreamOnly: false, ...o });
  const items = Array.from({ length: 14 }, (_, i) => item({ id: `v${i}`, at: i, score: i === 3 ? 3 : i === 7 ? 2 : 1, text: `v${i}` }));
  const txt = renderBriefing({ from: 'abc1234', to: 'def5678', upstream: 'origin/main', ahead: 3, people: 2, sessions: 3, items, degraded: [] });
  const lines = txt.split('\n');
  expect(lines.length).toBeLessThanOrEqual(25);
  expect(lines[0]).toBe('[loom] Since your last sync (abc1234 → def5678; upstream origin/main +3), 2 people, 3 sessions:');
  const order = lines.filter((l) => l.startsWith('- ') && !l.startsWith('- Degraded')).map((l) => /v\d+/.exec(l)![0]);
  expect(order.slice(0, 3)).toEqual(['v3', 'v7', 'v13']);
  expect(order).toHaveLength(10);
  expect(lines.at(-2)).toBe('- Degraded: none.');
  expect(lines.at(-1)).toBe('Ask: history(region) · why(region) · changes_since(commit)');
  expect(renderBriefing({ from: 'abc1234', to: 'def5678', upstream: 'origin/main', ahead: 3, people: 2, sessions: 3, items, degraded: [] })).toBe(txt);
});

test('fresh init: news is only the latest handoff of each other person', async () => {
  const { a, b } = pair(SRC);
  ensureLoomDir(a, CFG);
  for (const [i, s] of [ulid(), ulid()].entries()) {
    appendEvent(a, s, 'main', { type: 'session', person: 'A@t', kind: 'interactive', base: '', upstream: 'origin/main' });
    appendEvent(a, s, 'main', { type: 'handoff', summary: `handoff ${i}`, open_tasks: [], open_leases: [] });
  }
  as('A')(a, 'add', '-A'); as('A')(a, 'commit', '-qm', 'records'); as('A')(a, 'push', '-q'); as('B')(b, 'pull', '-q');
  ensureLoomDir(b, CFG); const g = await testGraph(); await indexRepo(g, b, { baseline: true });
  const { briefing } = await sync(g, b, { me: 'B@t', fetch: false });
  expect(briefing).toMatch(/handoff 1/); expect(briefing).not.toMatch(/handoff 0/);
  await g.drop();
});

test('offline: fetch to an unreachable remote is bounded (≤ 6 s) and sync still completes', async () => {
  const { b } = pair(SRC); ensureLoomDir(b, CFG);
  sh(b, 'remote', 'set-url', 'origin', 'https://10.255.255.1/x.git');
  const g = await testGraph(); await indexRepo(g, b, { baseline: true });
  const t = Date.now(); const out = await sync(g, b, { me: 'B@t', fetch: true });
  expect(Date.now() - t).toBeLessThan(8000);
  expect(out.fetched).toBe(false);
  await g.drop();
}, 15000);
