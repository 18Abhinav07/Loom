import type { Region } from './types.js';

export interface RegionDiff { updated: string[]; created: string[]; tombstoned: string[]; renamed: Array<{ from: string; to: string }> }

/** §3.5. Renames need a one-to-one masked-hash match among gone and added regions of the same kind. Gaps follow their predecessor. */
export function diffRegions(old: Region[], neu: Region[]): RegionDiff {
  const o = new Map(old.map((r) => [r.id, r]));
  const n = new Map(neu.map((r) => [r.id, r]));
  const updated = neu.filter((r) => o.has(r.id) && o.get(r.id)!.hash !== r.hash).map((r) => r.id);
  const gone = old.filter((r) => !n.has(r.id));
  const added = neu.filter((r) => !o.has(r.id));
  const group = (rs: Region[]) => {
    const m = new Map<string, Region[]>();
    for (const r of rs) if (r.kind !== 'gap') (m.get(`${r.kind}|${r.masked}`) ?? m.set(`${r.kind}|${r.masked}`, []).get(`${r.kind}|${r.masked}`)!).push(r);
    return m;
  };
  const g = group(gone), a = group(added);
  const renamed: Array<{ from: string; to: string }> = [];
  const qnameTo = new Map<string, string>();
  for (const [k, rs] of g) {
    const cand = a.get(k);
    if (rs.length === 1 && cand?.length === 1) { renamed.push({ from: rs[0].id, to: cand[0].id }); qnameTo.set(rs[0].qname, cand[0].qname); }
  }
  for (const r of gone) {
    const m = /^gap@after:(.+)$/.exec(r.qname);
    if (r.kind !== 'gap' || !m || !qnameTo.has(m[1])) continue;
    const toId = r.id.replace(`::${r.qname}::`, `::gap@after:${qnameTo.get(m[1])}::`);
    if (n.has(toId) && !o.has(toId)) renamed.push({ from: r.id, to: toId });
  }
  const from = new Set(renamed.map((x) => x.from)), to = new Set(renamed.map((x) => x.to));
  return { updated, created: added.filter((r) => !to.has(r.id)).map((r) => r.id), tombstoned: gone.filter((r) => !from.has(r.id)).map((r) => r.id), renamed };
}
