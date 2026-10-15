import { spawnSync } from 'node:child_process';
import type { LoomGraph } from '@loom/core';
import { git, gitTry } from './git.js';
import { importSessions } from './importer.js';
import { indexRepo } from './indexrepo.js';
import { news, renderBriefing } from './news.js';
import { reconcile } from './reconcile.js';
import { refreshHead } from './commit.js';
import { ulid } from './ids.js';

export function upstreamRef(root: string): string | null {
  const u = gitTry(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  if (u) return u;
  const d = gitTry(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  return d ?? (gitTry(root, 'rev-parse', '--verify', '-q', 'origin/main') ? 'origin/main' : null);
}

/** §6.3. Never throws on network trouble; `fetched` is null when fetch was not asked for. */
export async function sync(g: LoomGraph, root: string, o: { me: string; fetch?: boolean; quiet?: boolean }) {
  const up = upstreamRef(root);
  let fetched: boolean | null = null;
  if (o.fetch !== false && up) {
    const r = spawnSync('git', ['fetch', '-q', up.split('/')[0]], { cwd: root, timeout: 5000, stdio: 'ignore' });
    fetched = r.status === 0;
    if (!fetched && !o.quiet) process.stderr.write(`[loom] fetch ${up} failed (${r.error?.message ?? `exit ${r.status}`}); syncing locally\n`);
  }
  const [wm] = await g.query<{ commit: string; at: number }>('MATCH (w:Watermark {person: $me}) RETURN w.commit AS commit, w.at AS at', { me: o.me });
  const head = git(root, 'rev-parse', 'HEAD');
  let imported = (await importSessions(g, root, null)).events;
  if (up) imported += (await importSessions(g, root, up)).events;
  await indexRepo(g, root, { writeLock: false });
  let reconciled = (await reconcile(g, root, wm?.commit ?? head, 'HEAD')).versions;
  if (up) reconciled += (await reconcile(g, root, head, up)).versions;
  // ruling 14: only regions with activity can have moved; walking every region costs one query per region
  await refreshHead(g, root, (await g.query<{ id: string }>('MATCH (v:Version)-[:OF]->(r:Region) WHERE NOT coalesce(v.baseline, false) RETURN DISTINCT r.id AS id')).map((x) => x.id));
  const items = await news(g, root, o.me, wm?.at ?? 0, up);
  const fresh = !wm;
  const shown = fresh ? latestHandoffPerPerson(items) : items.filter((i) => i.score > 0 || i.kind === 'handoff' || i.upstreamOnly);
  const people = new Set(shown.map((i) => i.person).filter(Boolean)).size;
  const sessions = new Set(shown.map((i) => i.by.split('/')[0]).filter(Boolean)).size;
  const degraded = (await g.query<{ p: string }>('MATCH (r:Region {degraded: true}) WHERE NOT coalesce(r.tombstoned, false) RETURN DISTINCT r.path AS p ORDER BY p')).map((x) => x.p);
  const ahead = up ? Number(gitTry(root, 'rev-list', '--count', `HEAD..${up}`) ?? 0) : 0;
  const briefing = renderBriefing({ from: wm?.commit ?? head, to: head, upstream: up, ahead, people, sessions, items: shown, degraded });
  await g.query(`CREATE (:Message {id: $id, kind: 'briefing', text: $briefing, at: $at})
    MERGE (w:Watermark {person: $me}) SET w.commit = $head, w.at = $at`, { id: ulid(), briefing, at: Date.now(), me: o.me, head });
  if (!o.quiet) console.log(briefing);
  return { briefing, imported, reconciled, fetched };
}

/** Ties on `at` (same millisecond) go to the larger id: ULIDs are monotonic. */
function latestHandoffPerPerson<T extends { kind: string; id: string; person: string; at: number }>(items: T[]): T[] {
  const best = new Map<string, T>();
  const later = (x: T, y: T) => x.at > y.at || (x.at === y.at && x.id > y.id);
  for (const i of items) if (i.kind === 'handoff' && (!best.has(i.person) || later(i, best.get(i.person)!))) best.set(i.person, i);
  return [...best.values()];
}
