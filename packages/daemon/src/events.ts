import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Spec §3.4 event types, plus the lifecycle ones P2 added. */
export type EventType = 'agent.registered' | 'agent.state' | 'lease.granted' | 'lease.denied' | 'lease.released'
  | 'change.recorded' | 'change.landed' | 'notice.created' | 'notice.delivered' | 'notice.resolved'
  | 'gate.blocked' | 'gate.escalated' | 'step.recorded' | 'claim.updated' | 'agent.woken' | 'lesson.recorded' | 'lesson.injected'
  | 'task.claimed' | 'decision.recorded' | 'commit.recorded';
export interface LoomEvent { type: EventType; at: number; run: string; agent?: string; data: Record<string, unknown> }

export class EventBus {
  private subs = new Map<string, Set<(e: LoomEvent) => void>>();
  private ring = new Map<string, LoomEvent[]>();

  on(run: string, fn: (e: LoomEvent) => void): () => void {
    if (!this.subs.has(run)) this.subs.set(run, new Set());
    this.subs.get(run)!.add(fn);
    return () => { this.subs.get(run)?.delete(fn); };
  }

  listenerCount(run: string) { return this.subs.get(run)?.size ?? 0; }

  emit(e: LoomEvent) {
    const r = this.ring.get(e.run) ?? [];
    r.push(e);
    if (r.length > 500) r.splice(0, r.length - 500);
    this.ring.set(e.run, r);
    for (const fn of this.subs.get(e.run) ?? []) {
      try { fn(e); } catch { /* a dead subscriber never breaks the emitter */ }
    }
  }

  recent(run: string, n = 200) { return (this.ring.get(run) ?? []).slice(-n); }
}

/** API-call recording for replay (spec §3.4): one events.jsonl per run, t = ms since the run's first record. */
export class Recorder {
  private t0 = new Map<string, number>();
  constructor(private readonly dir: string) {}

  record(run: string, route: string, body: unknown) {
    const d = join(this.dir, run.replace(/[^\w.-]+/g, '_'));
    if (!this.t0.has(run)) { mkdirSync(d, { recursive: true }); this.t0.set(run, Date.now()); }
    appendFileSync(join(d, 'events.jsonl'), JSON.stringify({ t: Date.now() - this.t0.get(run)!, route, body }) + '\n');
  }
}
