// Spec §5.10 lessons: what went wrong in one run, keyed by symbol, told to the next run's agents before they repeat it.
import type { LoomGraph } from '@loom/core';

export type Trigger = 'T1' | 'T2' | 'T3' | 'manual';
export interface Lesson { id: string; trigger: Trigger; symbols: string[]; text: string; hits: number; run: string; at: number }

const COLS = 'l.id AS id, l.trigger AS trigger, l.symbols AS symbols, l.text AS text, l.hits AS hits, l.run AS run, l.at AS at';

/** One graph for all runs (`lessons`): symbol ids are stable across runs, so a lesson outlives the run that taught it. */
export class Lessons {
  constructor(readonly g: LoomGraph) {}

  /** The same trigger on the same symbol is the same lesson: it is hit again, not duplicated. */
  async record(trigger: Trigger, symbols: string[], text: string, run: string): Promise<Lesson> {
    const [l] = await this.g.query<Lesson>(`MERGE (l:Lesson {id: $id})
      ON CREATE SET l.trigger = $trigger, l.symbols = $symbols, l.hits = 1, l.at = $t
      ON MATCH SET l.hits = l.hits + 1
      SET l.text = $text, l.run = $run RETURN ${COLS}`, { id: `${trigger}:${symbols[0]}`, trigger, symbols, text, run, t: Date.now() });
    return l;
  }

  about(ids: string[], limit = 3): Promise<Lesson[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.g.query<Lesson>(`MATCH (l:Lesson) WHERE any(s IN l.symbols WHERE s IN $ids)
      RETURN ${COLS} ORDER BY l.hits DESC, l.at DESC LIMIT ${Math.max(1, Math.floor(limit))}`, { ids });
  }

  list(symbol?: string): Promise<Lesson[]> {
    return this.g.query<Lesson>(`MATCH (l:Lesson) WHERE $s IS NULL OR $s IN l.symbols RETURN ${COLS} ORDER BY l.hits DESC, l.at DESC`, { s: symbol ?? null });
  }

  async rm(id: string): Promise<boolean> {
    const [r] = await this.g.query<{ n: number }>(`MATCH (l:Lesson {id: $id}) WITH l, 1 AS one DELETE l RETURN sum(one) AS n`, { id });
    return (r?.n ?? 0) > 0;
  }
}
