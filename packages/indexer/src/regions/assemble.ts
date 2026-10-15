import { sha1 } from './text.js';
import type { Piece, Region } from './types.js';

/** Sort pieces, merge overlaps (with a warning), fill gaps, number duplicates, hash. Gives an exact cover. */
export function assemble(path: string, text: string, pieces: Piece[], warnings: string[]): Region[] {
  const sorted = [...pieces].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: Piece[] = [];
  for (const p of sorted) {
    const prev = kept.at(-1);
    if (prev && p.start < prev.end) {
      warnings.push(`overlap: ${p.qname} merged into ${prev.qname}`);
      prev.end = Math.max(prev.end, p.end);
      continue;
    }
    if (p.end > p.start) kept.push({ ...p });
  }
  const spans: Piece[] = [];
  let at = 0;
  let prevQ: string | null = null;
  const gap = (start: number, end: number): Piece =>
    ({ start, end, kind: 'gap', qname: prevQ === null ? 'gap@start' : `gap@after:${prevQ}`, sig: null });
  for (const p of kept) {
    if (p.start > at) spans.push(gap(at, p.start));
    spans.push(p);
    at = p.end;
    prevQ = p.qname;
  }
  if (at < text.length) spans.push(gap(at, text.length));
  const seen = new Map<string, number>();
  return spans.map((p) => {
    const key = `${p.qname}::${p.kind}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const body = text.slice(p.start, p.end);
    const masked = p.nameStart === undefined ? body
      : body.slice(0, p.nameStart - p.start) + '\u0000' + body.slice(p.nameEnd! - p.start);
    return { id: `${path}::${key}#${n}`, kind: p.kind, qname: p.qname, start: p.start, end: p.end, hash: sha1(body), masked: sha1(masked), sig: p.sig };
  });
}
