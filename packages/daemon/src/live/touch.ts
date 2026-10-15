// Which existing regions an edit touches, and the lease mode it needs (P3 ruling 3).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffRegions, regionize } from '@loom/indexer';
import { applyEdits, type EditIntent } from '../predict.js';
import type { LeaseMode } from '../lease.js';

export interface Touched { ids: string[]; created: string[]; mode: LeaseMode | null }

/** Only existing ids are leased; created regions have nothing to lease. Contract = a sig changed, or a region went away. */
export async function touched(path: string, before: string | null, after: string | null): Promise<Touched> {
  if (before === null) {
    const a = after === null ? [] : (await regionize(path, after)).regions.map((r) => r.id);
    return { ids: [], created: a, mode: null };
  }
  const B = await regionize(path, before);
  const A = await regionize(path, after ?? '', { lastClean: B.degraded ? undefined : B });
  const sigB = new Map(B.regions.map((r) => [r.id, r.sig]));
  const sigA = new Map(A.regions.map((r) => [r.id, r.sig]));
  if (A.degraded) {
    const ids = [...new Set(A.touched ?? [])].sort();
    if (!ids.length) return { ids, created: [], mode: null };
    return { ids, created: [], mode: ids.some((i) => !sigA.has(i) || sigA.get(i) !== sigB.get(i)) ? 'contract' : 'write' };
  }
  const d = diffRegions(B.regions, A.regions);
  const gone = [...d.tombstoned, ...d.renamed.map((r) => r.from)];
  const ids = [...new Set([...d.updated, ...gone])].sort();
  const created = [...new Set([...d.created, ...d.renamed.map((r) => r.to)])];
  if (!ids.length) return { ids, created, mode: null };
  const contract = gone.length > 0 || d.updated.some((i) => sigB.get(i) !== sigA.get(i));
  return { ids, created, mode: contract ? 'contract' : 'write' };
}

/** The lease an intended edit needs, before it happens. null when the edit cannot be applied to the file as it is. */
export async function predictTouched(root: string, it: EditIntent): Promise<Touched | null> {
  let cur: string | null = null;
  try { cur = readFileSync(join(root, it.file), 'utf8'); } catch { cur = null; }
  const next = applyEdits(cur ?? '', it);
  if (next === null) return null;
  return touched(it.file, cur, next);
}
