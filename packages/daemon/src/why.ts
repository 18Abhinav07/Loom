import type { LoomGraph } from '@loom/core';

export interface WhyChain {
  decision?: { id: string; text: string; agent: string };
  task?: { id: string; title: string };
  agent: string;
  change: { kind: string; before: string; after: string; at: number };
  commit?: { sha: string; message: string };
}
export interface WhyResult { symbol: string; chains: WhyChain[]; missing: string[] }

async function resolve(g: LoomGraph, target: string): Promise<string | null> {
  if (target.includes('::')) {
    const [r] = await g.query<{ id: string }>(`MATCH (s:Symbol {id: $t}) RETURN s.id AS id`, { t: target });
    return r?.id ?? null;
  }
  const fl = /^(.+\.py):(\d+)$/.exec(target);
  if (fl) {
    const [r] = await g.query<{ id: string }>(`MATCH (s:Symbol {file: $f}) WHERE s.startLine <= $l AND s.endLine >= $l
      RETURN s.id AS id ORDER BY s.endLine - s.startLine ASC LIMIT 1`, { f: fl[1], l: Number(fl[2]) });
    return r?.id ?? null;
  }
  const [r] = await g.query<{ id: string }>(`MATCH (s:Symbol) WHERE s.qname = $t OR s.name = $t RETURN s.id AS id ORDER BY s.id LIMIT 1`, { t: target });
  return r?.id ?? null;
}

/**
 * Spec §5.8 `why`: decision → task → agent → change → commit for a symbol. The path shape is fixed in this schema, so it
 * is one traversal; hops that do not exist yet come back as `missing`, never as an error.
 */
export async function why(g: LoomGraph, target: string): Promise<WhyResult> {
  const sid = await resolve(g, target);
  if (!sid) return { symbol: target, chains: [], missing: ['symbol'] };
  const rows = await g.query<{ cid: string; agent: string; kind: string; before: string; after: string; at: number; sha: string | null;
    message: string | null; task: string | null; title: string | null; did: string | null; dtext: string | null; dat: number | null }>(
    `MATCH (s:Symbol {id: $sid})<-[:OF]-(c:Change)
     OPTIONAL MATCH (c)-[:IN]->(m:Commit)
     OPTIONAL MATCH (a:Agent {id: c.agent})
     OPTIONAL MATCH (t:Task {id: coalesce(c.task, a.task)})
     OPTIONAL MATCH (d:Decision)-[:CONSTRAINS]->(s) WHERE d.agent = c.agent
     RETURN c.id AS cid, c.agent AS agent, c.kind AS kind, c.before AS before, c.after AS after, c.at AS at,
            m.sha AS sha, m.message AS message, coalesce(c.task, a.task) AS task, coalesce(t.title, a.taskTitle) AS title,
            d.id AS did, d.text AS dtext, d.at AS dat
     ORDER BY c.at DESC, dat DESC`, { sid });
  const chains: WhyChain[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.cid)) continue;           // newest decision per change wins (rows are sorted by d.at desc)
    seen.add(r.cid);
    chains.push({
      ...(r.did ? { decision: { id: r.did, text: r.dtext ?? '', agent: r.agent } } : {}),
      ...(r.task ? { task: { id: r.task, title: r.title ?? '' } } : {}),
      agent: r.agent,
      change: { kind: r.kind, before: r.before, after: r.after, at: r.at },
      ...(r.sha ? { commit: { sha: r.sha, message: r.message ?? '' } } : {}),
    });
    if (chains.length >= 10) break;
  }
  if (!chains.length) return { symbol: sid, chains, missing: ['change'] };
  const top = chains[0];
  const missing = [!top.decision && 'decision', !top.task && 'task', !top.commit && 'commit'].filter(Boolean) as string[];
  return { symbol: sid, chains, missing };
}

export function renderWhy(r: WhyResult): string {
  if (r.missing.includes('symbol')) return `${r.symbol}: no such symbol in this run`;
  if (!r.chains.length) return `${r.symbol}: no agent has changed it in this run`;
  return [r.symbol, ...r.chains.map((c) => '  ' + [
    c.decision ? `decision ${c.decision.id} "${c.decision.text}"` : '(no decision recorded)',
    c.task ? `task ${c.task.id}${c.task.title ? ` "${c.task.title}"` : ''}` : '(no task)',
    `agent ${c.agent}`,
    `change ${c.change.kind} (${c.change.before}${c.change.after ? ` → ${c.change.after}` : ''})`,
    c.commit ? `commit ${c.commit.sha.slice(0, 7)} "${c.commit.message.split('\n')[0]}"` : '(not committed yet)',
  ].join(' → '))].join('\n');
}
