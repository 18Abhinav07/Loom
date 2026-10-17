// §4.3 collision records: one event per distinct collision, appended to a session's event file.
import { appendEvent, collisionId, type Party } from './events.js';

export type CollisionKind = 'lock_denied' | 'lock_wait' | 'caller_warning' | 'landing_rejected' | 'merge_conflict' | 'out_of_scope' | 'divergence' | 'stale_version';
export type Outcome = 'rejected' | 'waited' | 'open' | 'resolved';
export interface CollisionIn { kind: CollisionKind; region: string[]; parties: Party[]; outcome: Outcome;
  version?: string | null; waited_ms?: number; detail: string }

const written = new Set<string>();

/** Appends the collision to `<sid>.<writer>.jsonl` and returns its id. The same collision (same kind, parties, region and version) is written once. */
export function writeCollision(repo: string, sid: string, c: CollisionIn, writer = 'coord'): string {
  const id = collisionId(c.kind, c.parties, c.region, c.version);
  const key = `${repo}|${sid}|${writer}|${id}`;
  if (written.has(key)) return id;
  written.add(key);
  appendEvent(repo, sid, writer, { type: 'collision', id, kind: c.kind, region: c.region, parties: c.parties, outcome: c.outcome,
    version: c.version ?? null, waited_ms: c.waited_ms ?? null, detail: c.detail, team: sid });
  return id;
}
