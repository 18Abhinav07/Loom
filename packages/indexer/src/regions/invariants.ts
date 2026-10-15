import { sha1 } from './text.js';
import type { FileRegions } from './types.js';

/** §3.2 invariants 1–2 plus hash and id integrity. Determinism and locality are property-tested. */
export function checkInvariants(fr: FileRegions): string[] {
  if (fr.binary) return [];
  const out: string[] = [];
  const ids = new Set<string>();
  let at = 0;
  for (const r of fr.regions) {
    if (r.start !== at) out.push(`${r.id}: starts at ${r.start}, expected ${at}`);
    if (r.end <= r.start) out.push(`${r.id}: empty`);
    else if (sha1(fr.text.slice(r.start, r.end)) !== r.hash) out.push(`${r.id}: hash mismatch`);
    if (ids.has(r.id)) out.push(`${r.id}: duplicate id`);
    ids.add(r.id);
    at = Math.max(at, r.end);
  }
  if (at !== fr.text.length) out.push(`cover ends at ${at}, text length ${fr.text.length}`);
  return out;
}
