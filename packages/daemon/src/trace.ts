import type { LoomGraph } from '@loom/core';

export interface StepIn { tool: string; intent: string; symbols: string[]; file?: string }

/** Spec §5.8: every tool call as a Step in the run's own `trace:<run>` graph, batched so the coord writer stays free. */
export class TraceWriter {
  private buf: Record<string, unknown>[] = [];
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout;

  constructor(private readonly g: LoomGraph, private readonly run: string, everyMs = 250) {
    this.timer = setInterval(() => void this.flush(), everyMs);
    this.timer.unref();
  }

  step(agent: string, s: StepIn): number {
    this.buf.push({ seq: ++this.seq, agent, tool: s.tool, intent: s.intent, symbols: s.symbols, file: s.file ?? '', at: Date.now() });
    return this.seq;
  }

  flush(): Promise<void> {
    if (!this.buf.length) return this.chain;
    const rows = this.buf; this.buf = [];
    this.chain = this.chain.then(() => this.g.query(`MERGE (r:Run {id: $run}) WITH r UNWIND $rows AS x
      CREATE (r)-[:HAS]->(:Step {seq: x.seq, agent: x.agent, tool: x.tool, intent: x.intent, symbols: x.symbols, file: x.file, at: x.at})`,
    { run: this.run, rows }).then(() => undefined)).catch((e) => console.error(`[loom] trace flush failed: ${String(e)}`));
    return this.chain;
  }

  async close() { clearInterval(this.timer); await this.flush(); }
}
