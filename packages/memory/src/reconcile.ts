import type { LoomGraph } from '@loom/core';
import { diffRegions, regionize } from '@loom/indexer';
import { git, gitTry, showRaw } from './git.js';

type Change = { hash: string | null; sig: string | null; deleted: boolean };
async function changedRegions(root: string, a: string, b: string): Promise<Map<string, Change>> {
  const out = new Map<string, Change>();
  for (const line of git(root, 'diff', '--name-status', '-M', a, b, '--', '.', ':!.loom').split('\n').filter(Boolean)) {
    const [st, p1, p2] = line.split('\t'); const f = p2 ?? p1;
    const old = st === 'A' ? null : showRaw(root, `${a}:${p1}`); const neu = st === 'D' ? null : showRaw(root, `${b}:${f}`);
    const before = old === null ? [] : (await regionize(p1, old)).regions; const after = neu === null ? null : await regionize(f, neu);
    if (after?.degraded) continue;
    const d = diffRegions(before, after?.regions ?? []); const by = new Map((after?.regions ?? []).map((r) => [r.id, r]));
    for (const id of [...d.updated, ...d.created, ...d.renamed.map((x) => x.to)]) out.set(id, { hash: by.get(id)!.hash, sig: by.get(id)!.sig, deleted: false });
    for (const id of d.tombstoned) out.set(id, { hash: null, sig: null, deleted: true });
  }
  return out;
}

const meta = (root: string, c: string) => {
  try { const [ae, ct] = git(root, 'show', '-s', '--format=%ae%n%ct', c).split('\n'); return { by: ae, at: Number(ct) * 1000 }; }
  catch { return { by: 'unknown', at: 0 }; }   // an unreadable commit (partial clone) must not stop init
};

/** §4.6 + §6.3 step 4: regions a commit changed with no .loom version in that commit get Version {external} BY the git author. */
export async function reconcile(g: LoomGraph, root: string, from: string | null, to: string, cap = 200) {
  const range = from ? `${from}..${to}` : to;
  // the root commit has no parent; with from = null the init baseline already covers it
  const commits = (gitTry(root, 'rev-list', '--reverse', '--no-merges', ...(from ? [] : ['-n', String(cap)]), range)   // no watermark: only the latest `cap` commits, never a whole history (Django has 30k)
     ?? '').split('\n').filter(Boolean)
    .filter((c) => gitTry(root, 'rev-parse', '-q', '--verify', `${c}^`) !== null);
  if (!commits.length) return { commits: 0, versions: 0, capped: false };
  const write = async (id: string, region: string, v: Change, sha: string, by: string, at: number, isRange = false) => {
    if ((await g.query('MATCH (x:Version {id: $id}) RETURN x.id', { id })).length) return 0;
    await g.query(`MERGE (p:Person {id: $by}) MERGE (c:Commit {sha: $sha}) MERGE (rg:Region {id: $region}) ON CREATE SET rg.stub = true
      CREATE (v:Version {id: $id, region: $region, hash: $hash, sig: $sig, deleted: $deleted, degraded: false, external: true,
        commits: [$sha], at: $at, range: $isRange}) CREATE (v)-[:OF]->(rg) CREATE (v)-[:IN]->(c) CREATE (v)-[:BY]->(p)`,
    { id, region, ...v, sha, by, at, isRange });
    return 1;
  };
  let versions = 0;
  if (commits.length > cap) {
    const authors = new Set(commits.map((c) => meta(root, c).by));
    const last = commits.at(-1)!; const { at } = meta(root, last);
    for (const [region, v] of await changedRegions(root, `${commits[0]}^`, last))
      versions += await write(`ext:${commits[0]}..${last}:${region}`, region, v, last, `${authors.size} authors`, at, true);
    return { commits: commits.length, versions, capped: true };
  }
  for (const c of commits) {
    const loomed = new Set((await g.query<{ r: string }>('MATCH (v:Version {external: false})-[:IN]->(:Commit {sha: $c}) RETURN v.region AS r', { c })).map((x) => x.r));
    const { by, at } = meta(root, c);
    for (const [region, v] of await changedRegions(root, `${c}^`, c))
      if (!loomed.has(region)) versions += await write(`ext:${c}:${region}`, region, v, c, by, at);
  }
  return { commits: commits.length, versions, capped: false };
}
