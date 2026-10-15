import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureRepoSchema, type LoomGraph } from '@loom/core';
import { buildEdges, diffRegions, fromLockEntry, gitBlobSha, parseLock, pickEntry, regionize, serializeLock, toLockEntry,
  type FileRegions, type LockEntry } from '@loom/indexer';
import { readConfig, type LoomConfig } from './config.js';
import { git } from './git.js';
import { batched, writeEdges, writeRegions } from './graph.js';

export function listFiles(root: string, cfg: LoomConfig): string[] {
  const ex = cfg.excludes.map((e) => new RegExp(`(^|/)${e.replace(/\./g, '\\.')}(/|$)`));
  return git(root, 'ls-files', '-co', '--exclude-standard', '-z').split('\0')
    .filter((f) => f && !f.startsWith('.loom/') && !ex.some((r) => r.test(f)) && existsSync(join(root, f)));
}

/** §6.1 step 3: blobs that match the lock are loaded from it; only mismatches are reparsed. Edges are rebuilt from all maps. */
/** `writeLock: false` (sync, git hooks): the lock is tracked, so only init and pre-commit write it. Rewriting it from a
 * hook dirties the worktree mid-rebase and git aborts the next pick (L0 gate step 6). Misses are reparsed, not stored. */
export async function indexRepo(g: LoomGraph, root: string, opts: { baseline?: boolean; writeLock?: boolean } = {}) {
  const cfg = readConfig(root)!;
  await ensureRepoSchema(g);
  const lockPath = join(root, '.loom', 'regions.lock');
  const lock = existsSync(lockPath) ? parseLock(readFileSync(lockPath, 'utf8')) : new Map<string, LockEntry[]>();
  const files = listFiles(root, cfg);
  const frs: FileRegions[] = []; const changed: FileRegions[] = []; const entries: LockEntry[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  for (const f of files) {
    const buf = readFileSync(join(root, f)); const blob = gitBlobSha(buf);
    const hit = pickEntry(lock.get(f), blob);
    const prev = lock.get(f)?.[0];
    const fr = hit ? fromLockEntry(hit, buf.toString('utf8')) : await regionize(f, buf);
    frs.push(fr);
    if (!hit) {
      changed.push(fr);
      if (prev) for (const { from, to } of diffRegions(fromLockEntry(prev, '').regions, fr.regions).renamed) renames.push({ from, to });
    }
    entries.push(toLockEntry(fr, blob));
  }
  const fresh = !(await g.query('MATCH (r:Region) RETURN r LIMIT 1')).length;
  await writeRegions(g, fresh ? frs : changed);
  const { edges, unresolved } = buildEdges(frs);
  await writeEdges(g, (fresh ? frs : changed).map((f) => f.path), edges.filter((e) => fresh || changed.some((c) => e.from.startsWith(`${c.path}::`))));
  if (renames.length) await g.query(`UNWIND $rs AS x MATCH (n:Region {id: x.to}), (o:Region {id: x.from}) MERGE (n)-[:RENAMED_FROM]->(o)`, { rs: renames });
  if (opts.writeLock !== false) writeFileSync(lockPath, serializeLock(entries));
  if (opts.baseline) await baseline(g, root);
  return { files: files.length, reparsed: changed.length, regions: frs.reduce((n, f) => n + f.regions.length, 0),
    degraded: frs.filter((f) => f.degraded).map((f) => f.path), unresolved, edges: edges.length };
}

/** §6.1 step 4: one external Version per live region at HEAD; HEAD points at it. Re-running creates nothing.
 *  Batched CREATE, not one MERGE over all regions: MERGE (v)-[:IN]->(c) onto the one Commit hub was quadratic (P2-11). */
async function baseline(g: LoomGraph, root: string) {
  const head = git(root, 'rev-parse', 'HEAD'); const at = Number(git(root, 'show', '-s', '--format=%ct', head)) * 1000;
  const email = git(root, 'show', '-s', '--format=%ae', head);
  await g.query('MERGE (p:Person {id: $email}) MERGE (c:Commit {sha: $head}) SET c.at = $at', { head, at, email });
  const live = await g.query<{ id: string }>('MATCH (r:Region) WHERE NOT r.tombstoned RETURN r.id AS id');
  await batched(live.map((r) => r.id), (ids) => g.query(`MATCH (p:Person {id: $email}), (c:Commit {sha: $head})
    UNWIND $ids AS id MATCH (r:Region {id: id}) OPTIONAL MATCH (old:Version {id: 'ext:' + $head + ':' + id})
    WITH p, c, r, old WHERE old IS NULL
    CREATE (v:Version {id: 'ext:' + $head + ':' + r.id, region: r.id, hash: r.hash, sig: r.sig, deleted: false, degraded: r.degraded,
      external: true, commits: [$head], at: $at, baseline: true})
    CREATE (v)-[:OF]->(r) CREATE (v)-[:IN]->(c) CREATE (v)-[:BY]->(p)
    WITH r, v OPTIONAL MATCH (r)-[h:HEAD]->() DELETE h CREATE (r)-[:HEAD]->(v)`, { ids, head, at, email }));
}
