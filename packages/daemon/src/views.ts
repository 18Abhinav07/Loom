// B5/B6 data routes: read-only views over a repo's graph. Each returns plain JSON; an empty graph gives [] or {} (RF5).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { gitTry, news, renderBriefing, upstreamRef } from '@loom/memory';

const REAL = 'NOT coalesce(v.baseline, false)';
const PERSON_OF_VERSION = '(v)-[:BY]->(:Agent)<-[:RAN]-(s:Session)';
type Party = { person: string; session: string; agent?: string | null };

export async function people(g: LoomGraph) {
  const rows = await g.query<{ person: string; sessions: number; agents: number }>(`MATCH (p:Person) OPTIONAL MATCH (p)-[:STARTED]->(s:Session)
    OPTIONAL MATCH (s)-[:RAN]->(a:Agent) RETURN p.id AS person, count(DISTINCT s) AS sessions, count(DISTINCT a) AS agents ORDER BY person`);
  const reg = await regionsByPerson(g);
  return rows.map((r) => ({ ...r, regions: reg.get(r.person)?.size ?? 0 }));
}

async function regionsByPerson(g: LoomGraph) {
  const rows = await g.query<{ person: string; region: string }>(`MATCH (v:Version)-[:OF]->(r:Region) WHERE ${REAL}
    MATCH ${PERSON_OF_VERSION} RETURN DISTINCT s.person AS person, r.id AS region`);
  const out = new Map<string, Set<string>>();
  for (const r of rows) { if (!out.has(r.person)) out.set(r.person, new Set()); out.get(r.person)!.add(r.region); }
  return out;
}

export async function collab(g: LoomGraph) {
  const ps = await people(g);
  const reg = await regionsByPerson(g);
  const cols = await collisions(g, {});
  const edges: { a: string; b: string; shared: number; collisions: number }[] = [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const [a, b] = [ps[i].person, ps[j].person];
    const shared = [...(reg.get(a) ?? [])].filter((r) => reg.get(b)?.has(r)).length;
    const n = cols.filter((c) => c.parties.some((p) => p.person === a) && c.parties.some((p) => p.person === b)).length;
    if (shared || n) edges.push({ a, b, shared, collisions: n });
  }
  return { nodes: ps.map((p) => ({ person: p.person })), edges };
}

export async function sessions(g: LoomGraph, o: { person?: string | null; limit?: number }) {
  const rows = await g.query<{ sid: string; person: string; kind: string; parent: string | null; team: string | null; task: string | null; started: number }>(
    `MATCH (s:Session) WHERE $person IS NULL OR s.person = $person OPTIONAL MATCH (s)-[:CHILD_OF]->(p:Session)
     RETURN s.id AS sid, s.person AS person, s.kind AS kind, p.id AS parent, s.team AS team, s.task AS task, s.started AS started
     ORDER BY s.started DESC, s.id DESC LIMIT $limit`, { person: o.person ?? null, limit: Math.max(1, Math.min(o.limit ?? 200, 1000)) });
  const turns = new Map((await g.query<{ sid: string; n: number }>('MATCH (t:Turn)-[:IN]->(s:Session) RETURN s.id AS sid, count(t) AS n')).map((r) => [r.sid, r.n]));
  const handoffs = new Map<string, string>();
  for (const h of await g.query<{ sid: string; summary: string }>('MATCH (h:Handoff)-[:FROM]->(s:Session) RETURN s.id AS sid, h.summary AS summary ORDER BY h.at ASC'))
    handoffs.set(h.sid, h.summary);
  return rows.map((r) => ({ ...r, ...(handoffs.has(r.sid) ? { handoff: handoffs.get(r.sid) } : {}), turns: turns.get(r.sid) ?? 0 }));
}

export async function sessionDetail(g: LoomGraph, sid: string) {
  const [row] = (await sessions(g, { limit: 1000 })).filter((s) => s.sid === sid);
  if (!row) return null;
  const turns = await g.query<{ from: string; text: string; at: number }>('MATCH (t:Turn)-[:IN]->(:Session {id: $sid}) RETURN t.from AS from, t.text AS text, t.at AS at ORDER BY t.at, t.id', { sid });
  const versions = await g.query<{ region: string; commit: string | null }>(`MATCH (:Session {id: $sid})-[:RAN]->(:Agent)<-[:BY]-(v:Version)-[:OF]->(r:Region) WHERE ${REAL}
    OPTIONAL MATCH (v)-[:IN]->(c:Commit) RETURN r.id AS region, c.sha AS commit ORDER BY v.at, v.id`, { sid });
  const children = await g.query<{ id: string }>('MATCH (c:Session)-[:CHILD_OF]->(:Session {id: $sid}) RETURN c.id AS id ORDER BY c.started, c.id', { sid });
  return { ...row, turns, versions, children: children.map((c) => c.id) };
}

export async function collisions(g: LoomGraph, o: { kind?: string | null; person?: string | null }) {
  const rows = await g.query<{ id: string; kind: string; region: string[]; parties: string | null; outcome: string; at: number; detail: string | null }>(
    `MATCH (c:Collision) OPTIONAL MATCH (c)-[:AT]->(r:Region)
     RETURN c.id AS id, c.kind AS kind, collect(r.id) AS region, c.parties AS parties, c.outcome AS outcome, c.at AS at, c.detail AS detail ORDER BY c.at DESC, c.id`);
  return rows.map((r) => ({ ...r, region: [...r.region].sort(), parties: (r.parties ? JSON.parse(r.parties) : []) as Party[] }))
    .filter((r) => (!o.kind || r.kind === o.kind) && (!o.person || r.parties.some((p) => p.person === o.person)));
}

export async function region(g: LoomGraph, id: string) {
  const [r] = await g.query<{ id: string; path: string | null }>('MATCH (r:Region {id: $id}) RETURN r.id AS id, r.path AS path', { id });
  if (!r) return null;
  const versions = await g.query<{ id: string; by: string | null; task: string | null; decision: string | null; commit: string | null; at: number }>(
    `MATCH (v:Version)-[:OF]->(:Region {id: $id}) WHERE ${REAL}
     OPTIONAL MATCH ${PERSON_OF_VERSION} OPTIONAL MATCH (v)-[:FOR]->(t:Task) OPTIONAL MATCH (d:Decision)-[:LED_TO]->(v) OPTIONAL MATCH (v)-[:IN]->(c:Commit)
     RETURN v.id AS id, s.person AS by, t.id AS task, d.text AS decision, c.sha AS commit, v.at AS at ORDER BY v.at, v.id`, { id });
  const cols = (await collisions(g, {})).filter((c) => c.region.includes(id)).map((c) => ({ id: c.id, kind: c.kind, at: c.at }));
  return { id, path: r.path ?? id.split('::')[0], versions, collisions: cols };
}

/** One bucket per commit (short sha, oldest first) and person: how many regions were added, changed, removed. */
export async function growth(g: LoomGraph) {
  const rows = await g.query<{ sha: string; at: number; vat: number; person: string; deleted: boolean; prev: number }>(
    `MATCH (v:Version)-[:IN]->(c:Commit) WHERE ${REAL} OPTIONAL MATCH ${PERSON_OF_VERSION} OPTIONAL MATCH (v)-[:PREV]->(pv:Version)
     RETURN c.sha AS sha, c.at AS at, v.at AS vat, coalesce(s.person, c.author) AS person, coalesce(v.deleted, false) AS deleted, count(pv) AS prev`);
  const out = new Map<string, { at: number; vat: number; bucket: string; person: string; added: number; changed: number; removed: number }>();
  for (const r of rows) {
    const k = `${r.sha}|${r.person}`;
    const o = out.get(k) ?? { at: r.at, vat: r.vat, bucket: r.sha.slice(0, 7), person: r.person, added: 0, changed: 0, removed: 0 };
    if (r.deleted) o.removed++; else if (r.prev === 0) o.added++; else o.changed++;
    out.set(k, o);
  }
  return [...out.values()].sort((a, b) => a.at - b.at || a.vat - b.vat || a.bucket.localeCompare(b.bucket) || a.person.localeCompare(b.person)).map(({ at: _at, vat: _v, ...r }) => r);
}

/** Read-only: the briefing a sync would print, without moving the watermark. */
export async function brief(g: LoomGraph, root: string, person: string | null) {
  const me = person ?? gitTry(root, 'config', 'user.email') ?? '';
  const up = upstreamRef(root);
  const [wm] = await g.query<{ at: number }>('MATCH (w:Watermark {person: $me}) RETURN w.at AS at', { me });
  const items = (await news(g, root, me, wm?.at ?? 0, up)).filter((i) => i.score > 0 || i.kind === 'handoff' || i.upstreamOnly || !wm);
  const head = gitTry(root, 'rev-parse', 'HEAD') ?? '';
  const text = renderBriefing({ from: head, to: head, upstream: up, ahead: 0, people: new Set(items.map((i) => i.person).filter(Boolean)).size,
    sessions: new Set(items.map((i) => i.by.split('/')[0]).filter(Boolean)).size, items, degraded: [] });
  return { text };
}

/** The proof the dashboard leads with: E1 interference and E5 landed-clean, read from what is on disk. Never cost or time. */
export function benchCompare(resultsDir: string) {
  const out: { e1: Record<string, unknown>; e5: unknown[] } = { e1: {}, e5: [] };
  try {
    const c = JSON.parse(readFileSync(join(resultsDir, 'e1.json'), 'utf8')).conds;
    out.e1 = { blind: { broke: c.blind.interference, n: c.blind.n }, loom: { broke: c.live.interference, n: c.live.n } };
  } catch { /* no e1 result yet */ }
  const runs = resolve(resultsDir, '..', 'runs', 'e5');
  if (!existsSync(runs)) return out;
  const COUNTED = ['t1_slugpath', 'x1_textlist'];
  for (const d of readdirSync(runs).sort().reverse()) {
    const f = join(runs, d, 'records.jsonl');
    if (!existsSync(f)) continue;
    const recs = readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .filter((r) => COUNTED.includes(r.scenario));
    if (!recs.length) continue;
    const side = (sc: string, cond: string) => { const rs = recs.filter((r) => r.scenario === sc && r.cond === cond);
      return { all_pass: rs.filter((r) => r.all_pass).length, n: rs.length, broken: rs.reduce((s, r) => s + (r.broken ?? 0), 0), conflicts: rs.filter((r) => r.conflict).length }; };
    out.e5 = COUNTED.filter((sc) => recs.some((r) => r.scenario === sc)).map((sc) => ({ scenario: sc, blind: side(sc, 'blind'), loom: side(sc, 'loom') }));
    break;
  }
  return out;
}
