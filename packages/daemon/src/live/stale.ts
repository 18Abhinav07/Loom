// §6.5 version check: is the region I am about to edit older than what someone else has landed upstream?
import type { LoomGraph } from '@loom/core';
import { currentVersion, history, isAncestor, upstreamRef } from '@loom/memory';

export interface Stale { region: string; version: string; by: string; task: string | null; decision: string | null; summary: string }
export interface StaleOpts { upstream: string; me: { person: string; agent: string; run: boolean } }

/** Ruling 5: a run's agents compare against the run's landed branch; otherwise @{upstream} → origin/<default> → none. */
export function upstreamOf(top: string, runLanded?: string): string | null {
  return runLanded ?? upstreamRef(top);
}

/** Regions whose newest upstream version is not in my HEAD, was made by someone else, and I have not acked. */
export async function staleRegions(g: LoomGraph, top: string, ids: string[], o: StaleOpts): Promise<Stale[]> {
  const out: Stale[] = [];
  for (const region of ids) {
    const v = await currentVersion(g, top, region, o.upstream);
    if (!v) continue;
    const row = (await history(g, region)).find((h) => h.id === v);
    if (!row || row.commits.some((c) => isAncestor(top, c, 'HEAD'))) continue;
    const by = (o.me.run ? row.by : row.person ?? row.by) ?? 'unknown';
    if (by === (o.me.run ? o.me.agent : o.me.person)) continue;
    const [k] = await g.query<{ n: number }>(`MATCH (:Agent {id: $agent})-[k:ACKED]->(:Region {id: $region}) WHERE k.version = $v RETURN count(k) AS n`,
      { agent: o.me.agent, region, v });
    if (k?.n) continue;
    const decision = row.decisions[0] ?? null;
    const qname = region.split('::')[1] ?? region;
    out.push({ region, version: v, by, task: row.task, decision,
      summary: `${qname} changed on ${o.upstream} by ${by}${row.task ? ` (task ${row.task})` : ''}${decision ? `: ${decision}` : ''}` });
  }
  return out;
}

/** Ruling 6: an ack holds for exactly that version; a newer one is stale again. */
export async function ackStale(g: LoomGraph, agent: string, region: string, version: string): Promise<void> {
  await g.query(`MERGE (a:Agent {id: $agent}) MERGE (r:Region {id: $region}) MERGE (a)-[k:ACKED]->(r) SET k.version = $version`,
    { agent, region, version });
}
