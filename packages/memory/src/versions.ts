import type { LoomGraph } from '@loom/core';
import { gitTry, isAncestor } from './git.js';

/** §4.3: newest Version of R with any commit reachable from `ref`; null when none (uncommitted work). */
export async function currentVersion(g: LoomGraph, root: string, region: string, ref: string): Promise<string | null> {
  const vs = await g.query<{ id: string; commits: string[] }>(`MATCH (v:Version)-[:OF]->(:Region {id: $region})
    WHERE size(coalesce(v.commits, [])) > 0 RETURN v.id AS id, v.commits AS commits ORDER BY v.at DESC, v.id DESC`, { region });
  const tip = gitTry(root, 'rev-parse', '--verify', '-q', `${ref}^{commit}`);
  if (!tip) return null;
  return vs.find((v) => v.commits.some((c) => isAncestor(root, c, tip)))?.id ?? null;
}

export interface HistoryRow { id: string; ord: number; at: number; external: boolean; commits: string[]; prev: string[];
  by: string | null; person: string | null; task: string | null; decisions: string[] }
/** The version DAG of one region, oldest first; ord = max(prev.ord) + 1 computed here (ruling 5). */
export async function history(g: LoomGraph, region: string): Promise<HistoryRow[]> {
  const rows = await g.query<Omit<HistoryRow, 'ord'>>(`MATCH (v:Version)-[:OF]->(:Region {id: $region})
    OPTIONAL MATCH (v)-[:PREV]->(p:Version) OPTIONAL MATCH (v)-[:BY]->(b) OPTIONAL MATCH (s:Session)-[:RAN]->(b)
    OPTIONAL MATCH (v)-[:FOR]->(t:Task) OPTIONAL MATCH (d:Decision)-[:LED_TO]->(v)
    RETURN v.id AS id, v.at AS at, coalesce(v.external, false) AS external, coalesce(v.commits, []) AS commits,
      collect(DISTINCT p.id) AS prev, b.id AS by, coalesce(s.person, b.id) AS person, t.id AS task, collect(DISTINCT d.text) AS decisions
    ORDER BY at, id`, { region });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ord = new Map<string, number>();
  const of = (id: string, seen = new Set<string>()): number => {
    if (ord.has(id)) return ord.get(id)!;
    const r = byId.get(id); if (!r || seen.has(id)) return 0;
    seen.add(id); const n = Math.max(0, ...r.prev.map((p) => of(p, seen))) + 1; ord.set(id, n); return n;
  };
  return rows.map((r) => ({ ...r, ord: of(r.id) }));
}
