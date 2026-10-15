import { createHash } from 'node:crypto';
import type { FileRegions, Region, RegionKind } from './types.js';

export interface LockRegion { id: string; kind: RegionKind; start: number; end: number; hash: string; m: string; sig: string | null }
export interface LockEntry { path: string; blob: string; pack: string; degraded: boolean; regions: LockRegion[] }

export function gitBlobSha(c: string | Buffer): string {
  const b = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

function sortedPass(offs: number[], step: (from: number, to: number) => number): number[] {
  const order = offs.map((o, i) => [o, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(offs.length);
  let pos = 0, acc = 0;
  for (const [o, i] of order) { acc += step(pos, o); pos = o; out[i] = acc; }
  return out;
}

export const toUtf8Offsets = (text: string, offs: number[]): number[] => sortedPass(offs, (a, b) => Buffer.byteLength(text.slice(a, b)));

export function fromUtf8Offsets(text: string, offs: number[]): number[] {
  const buf = Buffer.from(text, 'utf8');
  return sortedPass(offs, (a, b) => buf.subarray(a, b).toString('utf8').length);
}

export function toLockEntry(fr: FileRegions, blob: string): LockEntry {
  const starts = fr.binary ? fr.regions.map((r) => r.start) : toUtf8Offsets(fr.text, fr.regions.map((r) => r.start));
  const ends = fr.binary ? fr.regions.map((r) => r.end) : toUtf8Offsets(fr.text, fr.regions.map((r) => r.end));
  return {
    path: fr.path, blob, pack: fr.pack, degraded: fr.degraded,
    regions: fr.regions.map((r, i) => ({ id: r.id, kind: r.kind, start: starts[i], end: ends[i], hash: r.hash, m: r.masked, sig: r.sig })),
  };
}

export function fromLockEntry(e: LockEntry, text: string): FileRegions {
  const starts = fromUtf8Offsets(text, e.regions.map((r) => r.start));
  const ends = fromUtf8Offsets(text, e.regions.map((r) => r.end));
  const regions: Region[] = e.regions.map((r, i) => ({
    id: r.id, kind: r.kind, qname: r.id.slice(e.path.length + 2, r.id.lastIndexOf('::')),
    start: starts[i], end: ends[i], hash: r.hash, masked: r.m, sig: r.sig,
  }));
  return { path: e.path, pack: e.pack, degraded: e.degraded, text, regions, warnings: [] };
}

export function serializeLock(entries: LockEntry[]): string {
  const one = new Map<string, LockEntry>();
  for (const e of entries) one.set(e.path, e);
  return [...one.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${JSON.stringify({ path: e.path, blob: e.blob, pack: e.pack, degraded: e.degraded, regions: e.regions })}\n`).join('');
}

/** Tolerant: skips conflict markers, blank and malformed lines; keeps every entry per path (union merge can leave two). */
export function parseLock(text: string): Map<string, LockEntry[]> {
  const out = new Map<string, LockEntry[]>();
  for (const line of text.split('\n')) {
    if (!line.trim() || /^(<{7}|={7}|>{7}|\|{7})/.test(line)) continue;
    let e: LockEntry;
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e?.path !== 'string' || typeof e.blob !== 'string' || !Array.isArray(e.regions)) continue;
    (out.get(e.path) ?? out.set(e.path, []).get(e.path)!).push(e);
  }
  return out;
}

export const pickEntry = (entries: LockEntry[] | undefined, blob: string): LockEntry | undefined => entries?.find((e) => e.blob === blob);
