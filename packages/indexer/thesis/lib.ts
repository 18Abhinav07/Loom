import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffLines } from 'diff';
import type { RegionDiff } from '../src/regions/index.js';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
export function show(repo: string, rev: string, path: string): string | null {
  try { return git(repo, 'show', `${rev}:${path}`); } catch { return null; }
}

export const splitLines = (t: string): string[] => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Replace old lines [o, o+oLen) with `lines`. Hunks are sorted and disjoint in old coordinates. */
export interface Hunk { o: number; oLen: number; lines: string[] }

export function hunks(a: string, b: string): Hunk[] {
  const out: Hunk[] = []; let o = 0; let cur: Hunk | null = null;
  for (const c of diffLines(a, b)) {
    const ls = splitLines(c.value);
    if (!c.added && !c.removed) { if (cur) { out.push(cur); cur = null; } o += ls.length; continue; }
    cur ??= { o, oLen: 0, lines: [] };
    if (c.removed) { cur.oLen += ls.length; o += ls.length; } else cur.lines.push(...ls);
  }
  if (cur) out.push(cur);
  return out;
}

export function applyHunks(text: string, hs: Hunk[]): string {
  const L = splitLines(text); const out: string[] = []; let i = 0;
  for (const h of hs) { out.push(...L.slice(i, h.o), ...h.lines); i = h.o + h.oLen; }
  return out.concat(L.slice(i)).join('');
}

/**
 * c1: base→ours. c2: ours→c2. Returns c2's hunks moved into base coordinates, so that
 * applyHunks(base, theirs) is "C2's change made on C1's base". Overlap = c2 rewrites a line c1 wrote.
 * touch = some c2 hunk is adjacent to (or a point on the boundary of) a c1 span.
 */
export function rebaseUnder(c1: Hunk[], c2: Hunk[]): { kind: 'overlap' } | { kind: 'ok'; theirs: Hunk[]; touch: boolean } {
  let shift = 0;
  const spans = c1.map((h) => { const n = h.o + shift; shift += h.lines.length - h.oLen; return { n, nEnd: n + h.lines.length, delta: h.lines.length - h.oLen }; });
  const theirs: Hunk[] = []; let touch = false;
  for (const h of c2) {
    const a = h.o, b = h.o + h.oLen;
    let d = 0;
    for (const s of spans) {
      if (a < s.nEnd && s.n < b) return { kind: 'overlap' };
      if ((s.n < a && a < s.nEnd) || (s.n < b && b < s.nEnd)) return { kind: 'overlap' };
      if (b === s.n || a === s.nEnd || (a === b && s.n <= a && a <= s.nEnd)) touch = true;
      if (s.nEnd <= a && !(a === b && a === s.n && s.n === s.nEnd)) d += s.delta;
    }
    theirs.push({ o: a - d, oLen: h.oLen, lines: h.lines });
  }
  return { kind: 'ok', theirs, touch };
}

/** Region ids in the *middle* map that a diff touches: side 'new' for base→mid, 'old' for mid→next. */
export function changedIn(diff: RegionDiff, side: 'new' | 'old'): Set<string> {
  return side === 'new'
    ? new Set([...diff.updated, ...diff.created, ...diff.renamed.map((r) => r.to)])
    : new Set([...diff.updated, ...diff.tombstoned, ...diff.renamed.map((r) => r.from)]);
}

export function writeResult(id: string, text: string, json: unknown): void {
  const dir = join(ROOT, 'bench/results'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.txt`), text);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(json, null, 1));
}
