import { diffLines } from 'diff';
import { sha1 } from './text.js';
import type { FileRegions, Region } from './types.js';

/**
 * §3.6: carry the last clean map onto broken text. Each region start is mapped through a line diff:
 * - kept text moves with its offset;
 * - a start inside a deletion moves to the deletion point;
 * - insertions belong to the region before them.
 * Monotonic, so exact cover holds. Emptied regions are dropped.
 */
export function shiftMap(last: FileRegions, text: string, warnings: string[]): FileRegions {
  const starts = last.regions.map((r) => r.start);
  const mapped: number[] = new Array(starts.length);
  let i = 0, o = 0, n = 0;
  for (const part of diffLines(last.text, text)) {
    const len = part.value.length;
    if (part.added) { n += len; continue; }
    while (i < starts.length && starts[i] < o + len) { mapped[i] = part.removed ? n : n + (starts[i] - o); i++; }
    o += len;
    if (!part.removed) n += len;
  }
  while (i < starts.length) mapped[i++] = n;
  if (mapped.length) mapped[0] = 0;
  const regions: Region[] = [];
  const touched: string[] = [];
  last.regions.forEach((r, k) => {
    const s = mapped[k], e = k + 1 < mapped.length ? mapped[k + 1] : text.length;
    if (e <= s) { warnings.push(`degraded: ${r.id} empty, dropped until the next clean parse`); return; }
    const body = text.slice(s, e);
    const changed = body !== last.text.slice(r.start, r.end);
    if (changed) touched.push(r.id);
    regions.push({ ...r, start: s, end: e, hash: changed ? sha1(body) : r.hash, masked: changed ? sha1(body) : r.masked });
  });
  return { path: last.path, pack: last.pack, degraded: true, text, regions, warnings, touched };
}
