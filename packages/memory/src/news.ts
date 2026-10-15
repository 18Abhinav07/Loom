import type { LoomGraph } from '@loom/core';
import { isAncestor } from './git.js';

export interface NewsItem { kind: 'version' | 'decision' | 'task' | 'handoff' | 'lesson'; id: string; region: string | null; path: string | null;
  text: string; by: string; person: string; task: string | null; at: number; score: number; upstreamOnly: boolean }

/** §6.3 step 5. `me` is a person id (git email). */
export async function news(g: LoomGraph, root: string, me: string, since: number, upstream: string | null): Promise<NewsItem[]> {
  const scope = new Set((await g.query<{ r: string }>(`MATCH (t:Task)-[:SCOPE]->(r:Region) WHERE t.status IN ['open','claimed']
    MATCH (s:Session {person: $me})-[:RAN]->(a:Agent) WHERE t.claimed_by = a.id RETURN DISTINCT r.id AS r`, { me })).map((x) => x.r));
  const near = new Set((await g.query<{ r: string }>(`MATCH (s:Region)-[:CALLS|IMPORTS*1..2]-(r:Region) WHERE s.id IN $ids RETURN DISTINCT r.id AS r`,
    { ids: [...scope] })).map((x) => x.r));
  const mine = new Set((await g.query<{ p: string }>(`MATCH (s:Session {person: $me}) WITH s ORDER BY s.started DESC LIMIT 3
    MATCH (s)-[:RAN]->(:Agent)<-[:BY]-(v:Version)-[:OF]->(r:Region) RETURN DISTINCT r.path AS p`, { me })).map((x) => x.p));
  const rows = await g.query<Omit<NewsItem, 'score' | 'upstreamOnly'> & { commits: string[] }>(`
    MATCH (v:Version)-[:OF]->(r:Region), (v)-[:BY]->(b) WHERE v.at > $since AND NOT coalesce(v.baseline, false)
    OPTIONAL MATCH (s:Session)-[:RAN]->(b) WITH v, r, b, coalesce(s.person, b.id) AS person WHERE person <> $me
    OPTIONAL MATCH (v)-[:FOR]->(t:Task) OPTIONAL MATCH (d:Decision)-[:LED_TO]->(v)
    RETURN 'version' AS kind, v.id AS id, r.id AS region, r.path AS path, coalesce(r.qname, r.id) + CASE WHEN d IS NULL THEN '' ELSE ' | ' + d.text END AS text,
      b.id AS by, person, t.id AS task, v.at AS at, coalesce(v.commits, []) AS commits
    UNION ALL
    MATCH (l:Lesson)-[:ON]->(r:Region) WHERE l.at > $since
    RETURN 'lesson' AS kind, l.id AS id, r.id AS region, r.path AS path, l.text AS text, '' AS by, '' AS person, null AS task, l.at AS at, [] AS commits
    UNION ALL
    MATCH (h:Handoff)-[:FROM]->(s:Session) WHERE h.at > $since AND s.person <> $me
    RETURN 'handoff' AS kind, h.id AS id, null AS region, null AS path, h.summary AS text, s.id AS by, s.person AS person, null AS task, h.at AS at, [] AS commits
    UNION ALL
    MATCH (t:Task) WHERE t.at > $since MATCH (a:Agent {id: t.claimed_by})<-[:RAN]-(s:Session) WHERE s.person <> $me
    RETURN 'task' AS kind, t.id AS id, null AS region, null AS path, t.title + ' (' + t.status + ')' AS text, a.id AS by, s.person AS person, t.id AS task, t.at AS at, [] AS commits`,
  { me, since });
  return rows.map(({ commits, ...r }) => ({ ...r,
    score: r.region && scope.has(r.region) ? 3 : r.region && near.has(r.region) ? 2 : r.path && mine.has(r.path) ? 1 : 0,
    upstreamOnly: r.kind === 'version' && commits.length > 0 && !commits.some((c) => isAncestor(root, c, 'HEAD')) }));
}

/** §6.4: deterministic, at most 25 lines. */
export function renderBriefing(h: { from: string; to: string; upstream: string | null; ahead: number; people: number; sessions: number;
  items: NewsItem[]; degraded: string[] }): string {
  const top = [...h.items].sort((a, b) => b.score - a.score || b.at - a.at || a.id.localeCompare(b.id)).slice(0, 10);
  const up = h.upstream ? `; upstream ${h.upstream} +${h.ahead}` : '';
  const out = [`[loom] Since your last sync (${h.from.slice(0, 7)} → ${h.to.slice(0, 7)}${up}), ${h.people} people, ${h.sessions} sessions:`];
  for (const i of top) {
    const [what, decision] = i.text.split(' | ');
    if (i.kind === 'version') {
      out.push(`- ${what} (${i.path}) changed${i.upstreamOnly && h.upstream ? ` on ${h.upstream}` : ''} by ${i.person}/${i.by.split('/').pop()}${i.task ? ` for ${i.task}` : ''}${i.upstreamOnly ? ' — not in your branch yet.' : '.'} [${i.id}]`);
      if (decision) out.push(`  Decision: "${decision}".`);
    } else if (i.kind === 'handoff') out.push(`- Handoff from ${i.person}: ${i.text} [${i.id}]`);
    else if (i.kind === 'lesson') out.push(`- Lesson on ${i.path}: "${i.text}" [${i.id}]`);
    else out.push(`- Task ${i.task} by ${i.person}: ${i.text} [${i.id}]`);
  }
  out.push(`- Degraded: ${h.degraded.length ? h.degraded.slice(0, 5).join(', ') : 'none'}.`);
  out.push('Ask: history(region) · why(region) · changes_since(commit)');
  return out.slice(0, 23).concat(out.length > 23 ? out.slice(-2) : []).join('\n');
}
