// Live screen in plain English: which events are coordination, what they mean, and which part of the map matters now.
import type { Fx, LoomEvent, Snapshot } from './stream';

const fn = (id: unknown) => String(id ?? '').split('::').pop()!.split('.').pop()!;

/** One sentence for a coordination event; null for the agent's own steps and bookkeeping. */
export function plain(e: LoomEvent): string | null {
  const d = e.data ?? {}; const who = e.agent ?? 'an agent';
  switch (e.type) {
    case 'change.recorded':
      return d.kind === 'contract' ? `${who} changed ${fn(d.symbol)} — its callers must change too`
        : d.kind === 'removed' ? `${who} removed ${fn(d.symbol)}` : `${who} edited ${fn(d.symbol)}`;
    case 'notice.created': return `Loom told ${who}: ${d.author} changed ${fn(d.symbol)}, which ${who} depends on`;
    case 'notice.resolved': return `${who} adapted to the change`;
    case 'lease.denied': return `${who} was stopped from editing ${((d.symbols as string[]) ?? []).map(fn).join(', ')} — ${d.holder} is changing it`;
    case 'commit.recorded': return `${who} committed "${d.message ?? String(d.sha ?? '').slice(0, 7)}"`;
    case 'decision.recorded': return `${who} decided: ${d.text}`;
    case 'task.claimed': return `${who} started "${d.title ?? d.task}"`;
    case 'gate.blocked': return `Loom kept ${who} working: ${d.reason ?? d.rule}`;
    case 'claim.updated': return `${who}'s work is ${String(d.state).toLowerCase()}${d.state === 'VERIFIED' ? ' by its tests' : ''}`;
    case 'lesson.recorded': return `Loom learned a lesson from ${who}'s run`;
    case 'agent.registered': return `${who} joined`;
    case 'agent.state': return d.state === 'exited' ? `${who} finished` : null;
    default: return null;
  }
}

/** Symbols that matter now (leased, changed, on a notice path) plus one CALLS hop; null = nothing hot, show the whole map. */
export function focusIds(snap: Snapshot, badges: Record<string, number>, fx: Fx[]): Set<string> | null {
  const known = new Set(snap.nodes.map((n) => n.id));
  const seed = new Set([...snap.leases.map((l) => l.symbol), ...Object.keys(badges), ...fx.flatMap((f) => f.ids)].filter((id) => known.has(id)));
  if (!seed.size) return null;
  const out = new Set(seed);
  for (const e of snap.edges) { if (seed.has(e.from)) out.add(e.to); if (seed.has(e.to)) out.add(e.from); }
  return out;
}
