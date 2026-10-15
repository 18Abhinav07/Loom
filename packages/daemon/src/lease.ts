import type { LoomGraph } from '@loom/core';

export type LeaseMode = 'write' | 'contract';
export const CONFLICTS: Record<LeaseMode, LeaseMode[]> = { write: ['write'], contract: ['write', 'contract'] };
export const LEASE_TTL_MS = 10 * 60_000;
/** Lease targets: v2 leases Regions, v1 runs keep Symbols. Interpolated into Cypher, so only these two are accepted. */
export type LeaseLabel = 'Region' | 'Symbol';
const lbl = (l: LeaseLabel): LeaseLabel => { if (l !== 'Region' && l !== 'Symbol') throw new Error(`bad lease label: ${String(l)}`); return l; };
export interface Holder { holder: string; symbol: string; mode: LeaseMode; contract: boolean; task: string | null }

// Spec 5.2 CAS (shape verified 2026-10-13). SET differs: mode is sticky (plan 02 ruling 4). A body-only write admitted
// under an agent's contract never blocks that agent's own contract: the contract holder keeps its signature. `mine` is not a
// count(): on 6.0.2 an aggregate after UNWIND empties the next OPTIONAL MATCH (verified), and there is one LEASED edge per pair.
const cas = (label: LeaseLabel) => `MATCH (ag:Agent {id: $agent})
UNWIND $sids AS sid
MATCH (s:${label} {id: sid})
OPTIONAL MATCH (ag)-[own:LEASED]->(s) WHERE own.expires > $now AND own.contract = true
WITH ag, s, own IS NOT NULL AS mine
OPTIONAL MATCH (o:Agent)-[l:LEASED]->(s)
  WHERE o.id <> $agent AND l.expires > $now AND l.mode IN $conflictsWith
    AND NOT (mine AND $mode = 'contract' AND l.mode = 'write' AND NOT coalesce(l.contract, false))
WITH ag, collect(DISTINCT s) AS syms, count(l) AS conflicts
WHERE conflicts = 0 AND size(syms) = size($sids)
UNWIND syms AS t
MERGE (ag)-[nl:LEASED]->(t)
SET nl.mode = CASE WHEN nl.mode = 'write' THEN 'write' ELSE $mode END,
    nl.contract = coalesce(nl.contract, false) OR $mode = 'contract',
    nl.task = $task, nl.expires = $now + $ttl, nl.since = coalesce(nl.since, $now)
RETURN count(t) AS granted`;

export async function acquire(g: LoomGraph, agent: string, sids: string[], mode: LeaseMode, task: string,
  now = Date.now(), ttl = LEASE_TTL_MS, label: LeaseLabel = 'Region'): Promise<number> {
  const [r] = await g.query<{ granted: number }>(cas(lbl(label)), { agent, sids, mode, task, now, ttl, conflictsWith: CONFLICTS[mode] });
  return r?.granted ?? 0;
}

export function holders(g: LoomGraph, agent: string, sids: string[], mode: LeaseMode, now = Date.now(), label: LeaseLabel = 'Region'): Promise<Holder[]> {
  return g.query<Holder>(`UNWIND $sids AS sid MATCH (o:Agent)-[l:LEASED]->(s:${lbl(label)} {id: sid})
    WHERE o.id <> $agent AND l.expires > $now AND l.mode IN $conflictsWith
    RETURN o.id AS holder, s.id AS symbol, l.mode AS mode, coalesce(l.contract, false) AS contract, l.task AS task`,
  { agent, sids, now, conflictsWith: CONFLICTS[mode] });
}

export async function renew(g: LoomGraph, agent: string, now = Date.now(), ttl = LEASE_TTL_MS): Promise<void> {
  await g.query(`MATCH (:Agent {id: $agent})-[l:LEASED]->() WHERE l.expires > $now SET l.expires = $now + $ttl`, { agent, now, ttl });
}

export async function release(g: LoomGraph, agent: string, sids?: string[], label: LeaseLabel = 'Region'): Promise<string[]> {
  const rows = await g.query<{ id: string }>(`MATCH (:Agent {id: $agent})-[l:LEASED]->(s:${lbl(label)})
    WHERE $all OR s.id IN $sids WITH l, s.id AS id DELETE l RETURN id`, { agent, all: !sids, sids: sids ?? [] });
  return rows.map((r) => r.id);
}

/** Deletes lapsed leases and returns them. */
export function expired(g: LoomGraph, now = Date.now(), label: LeaseLabel = 'Region') {
  return g.query<{ agent: string; symbol: string; contract: boolean }>(`MATCH (a:Agent)-[l:LEASED]->(s:${lbl(label)})
    WHERE l.expires <= $now WITH a.id AS agent, s.id AS symbol, coalesce(l.contract, false) AS contract, l
    DELETE l RETURN agent, symbol, contract`, { now });
}
