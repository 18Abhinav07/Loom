import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ulid } from './ids.js';

export const EVENT_TYPES = ['session', 'agent', 'task', 'version', 'decision', 'evidence', 'lesson', 'message', 'handoff',
  'turn', 'tool', 'plan', 'team', 'collision'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type LoomEvent = { v: 1; type: EventType; id: string; at: number } & Record<string, any>;

export const sessionFile = (_root: string, sid: string, writer: string) => `.loom/sessions/${sid}.${writer}.jsonl`;
export function fileSession(path: string): { sid: string; writer: string } | null {
  const m = /(?:^|\/)([0-9A-HJKMNP-TV-Z]{26})\.([\w.-]+)\.jsonl$/.exec(path);
  return m ? { sid: m[1], writer: m[2] } : null;
}

export interface Party { person: string; session: string; agent?: string | null }
/** §4.3: a hash of kind, the sorted parties, the region and the triggering version, so two machines that detect the same
 *  collision write the same id and the import collapses them. */
export function collisionId(kind: string, parties: Party[], region: string[], version?: string | null): string {
  const ps = parties.map((p) => `${p.person}|${p.session}|${p.agent ?? ''}`).sort();
  return 'col_' + createHash('sha256').update(JSON.stringify([kind, ps, [...region].sort(), version ?? null])).digest('hex').slice(0, 24);
}

/** One line per event; the file has exactly one writer (§5), so appends never interleave. */
export function appendEvent(root: string, sid: string, writer: string,
  ev: { type: EventType; id?: string; at?: number } & Record<string, unknown>): LoomEvent {
  const e = { v: 1, ...ev, id: ev.id ?? ulid(), at: ev.at ?? Date.now() } as LoomEvent;
  const p = join(root, sessionFile(root, sid, writer));
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(e) + '\n');
  return e;
}

/** Union merge can leave duplicates or a line cut by a hand-resolved conflict: keep the first of each id, skip the rest. */
export function parseEvents(lines: string[]): { events: LoomEvent[]; warnings: string[] } {
  const seen = new Set<string>(); const events: LoomEvent[] = []; const warnings: string[] = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    let e: any;
    try { e = JSON.parse(l); } catch { warnings.push(`line ${i + 1}: not JSON`); return; }
    if (e?.v !== 1 || !EVENT_TYPES.includes(e.type) || typeof e.id !== 'string') { warnings.push(`line ${i + 1}: not a v1 event`); return; }
    if (seen.has(e.id)) return;
    seen.add(e.id); events.push(e);
  });
  return { events, warnings };
}
