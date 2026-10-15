import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regionize } from './regionize.js';

export type MergeResult =
  | { status: 'merged'; text: string }
  | { status: 'conflict'; regions: Array<{ id: string; kind: 'text' | 'delete' }> }
  | { status: 'unsupported'; reason: string };

export function gitMergeFile(base: string, ours: string, theirs: string): { clean: boolean; text: string } {
  const d = mkdtempSync(join(tmpdir(), 'loom-merge-'));
  try {
    const [b, o, t] = ['base', 'ours', 'theirs'].map((n) => join(d, n));
    writeFileSync(b, base); writeFileSync(o, ours); writeFileSync(t, theirs);
    const r = spawnSync('git', ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', o, b, t], { encoding: 'utf8' });
    if (r.status === null || r.status < 0) throw new Error(`git merge-file failed: ${r.stderr || r.error}`);
    return { clean: r.status === 0, text: r.stdout };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

const kindOf = (id: string) => id.slice(id.lastIndexOf('::') + 2).split('#')[0];

/** Split an imports region into statements (parenthesised and backslash continuations kept together). */
function statements(text: string): string[] {
  const out: string[] = [];
  let cur = '', depth = 0;
  for (const line of text.split(/(?<=\n)/)) {
    cur += line;
    for (const ch of line) depth += ch === '(' || ch === '{' ? 1 : ch === ')' || ch === '}' ? -1 : 0;
    if (depth <= 0 && !/\\\r?\n?$/.test(line)) { out.push(cur); cur = ''; depth = 0; }
  }
  if (cur) out.push(cur);
  return out;
}

function unionImports(base: string, ours: string, theirs: string): string {
  const key = (s: string) => s.trimEnd();
  const have = new Set([...statements(ours), ...statements(base)].map(key));
  const extra = statements(theirs).filter((s) => !have.has(key(s)));
  const o = ours.endsWith('\n') || !extra.length ? ours : `${ours}\n`;
  return o + extra.map((s) => (s.endsWith('\n') ? s : `${s}\n`)).join('');
}

/** §3.10. Tried when git's line merge conflicts; complements it rather than replacing it. */
export async function regionMerge(path: string, base: string, ours: string, theirs: string): Promise<MergeResult> {
  const [B, O, T] = await Promise.all([base, ours, theirs].map((s) => regionize(path, s)));
  for (const [side, fr] of [['base', B], ['ours', O], ['theirs', T]] as const) if (fr.degraded) return { status: 'unsupported', reason: `${side} does not parse` };
  const txt = (fr: typeof B) => new Map(fr.regions.map((r) => [r.id, fr.text.slice(r.start, r.end)]));
  const b = txt(B), o = txt(O), t = txt(T);
  const oIds = O.regions.map((r) => r.id), tIds = T.regions.map((r) => r.id);
  const common = (ids: string[], other: Map<string, string>) => ids.filter((id) => other.has(id)).join('\n');
  if (common(oIds, t) !== common(tIds, o)) return { status: 'unsupported', reason: 'region order differs between sides' };

  const conflicts: Array<{ id: string; kind: 'text' | 'delete' }> = [];
  const decide = (id: string): string | null => {
    const bb = b.get(id), oo = o.get(id), tt = t.get(id);
    if (oo !== undefined && tt !== undefined) {
      if (oo === tt) return oo;
      if (oo === bb) return tt;
      if (tt === bb) return oo;
      if (kindOf(id) === 'imports') return unionImports(bb ?? '', oo, tt);
      const m = gitMergeFile(bb ?? '', oo, tt);
      if (m.clean) return m.text;
      conflicts.push({ id, kind: 'text' });
      return null;
    }
    const one = oo ?? tt;
    if (one === undefined) return null;
    if (bb === undefined) return one;          // added on one side
    if (one === bb) return null;               // deleted on the other side, unchanged here
    conflicts.push({ id, kind: 'delete' });    // deleted vs modified
    return null;
  };

  const out = new Map<string, string | null>();
  for (const id of oIds) out.set(id, decide(id));
  const order = [...oIds];
  tIds.forEach((id, k) => {
    if (o.has(id)) return;
    const v = decide(id);
    if (v === null) return;
    out.set(id, v);
    let j = k - 1;
    while (j >= 0 && !order.includes(tIds[j])) j--;
    order.splice(j < 0 ? 0 : order.indexOf(tIds[j]) + 1, 0, id);
  });
  if (conflicts.length) return { status: 'conflict', regions: conflicts };
  const text = order.map((id) => out.get(id) ?? '').join('');
  const check = await regionize(path, text);
  if (check.degraded) return { status: 'unsupported', reason: 'merged text does not parse' };
  return { status: 'merged', text };
}

