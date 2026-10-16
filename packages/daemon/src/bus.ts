/** B3: the lead/session stream the dashboard reads (`GET /events`). One ring for the machine; `seq` only grows. */
export type BusKind = 'turn' | 'tool' | 'state' | 'permission' | 'channel';
export interface BusEvent { seq: number; at: number; repo: string; sid: string; kind: BusKind; data: Record<string, unknown> }

export class Bus {
  private ring: BusEvent[] = [];
  private seq = 0;
  private subs = new Set<(e: BusEvent) => void>();
  constructor(private cap = 2000) {}

  publish(e: Omit<BusEvent, 'seq' | 'at'> & { at?: number }): BusEvent {
    const ev: BusEvent = { ...e, seq: ++this.seq, at: e.at ?? Date.now() };
    this.ring.push(ev);
    if (this.ring.length > this.cap) this.ring.splice(0, this.ring.length - this.cap);
    for (const f of this.subs) { try { f(ev); } catch { /* one bad subscriber never stops the others */ } }
    return ev;
  }
  subscribe(fn: (e: BusEvent) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  since(seq: number): BusEvent[] { return this.ring.filter((e) => e.seq > seq); }
  get last() { return this.seq; }
}
