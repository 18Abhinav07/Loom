import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { diffRegions, gitBlobSha, parseLock, regionize, serializeLock, toLockEntry, type LockEntry } from '@loom/indexer';
import { appendEvent, sessionFile } from './events.js';
import { git, gitTry, showRaw } from './git.js';
import { importSessions } from './importer.js';
import { activeSession, ancestors } from './session.js';
import { currentVersion } from './versions.js';

const show = showRaw;

/** §6.2 step 5: parse the staged (index) text of each staged file, write a version event per changed region, rewrite the lock, stage both. */
export async function preCommit(root: string, g: LoomGraph | null): Promise<{ versions: number }> {
  const act = activeSession(root, null, ancestors()); if (!act) return { versions: 0 };   // two terminals: the one this commit runs under
  const staged = git(root, 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD').split('\0').filter((f) => f && !f.startsWith('.loom/'));
  const lockPath = join(root, '.loom', 'regions.lock');
  const lock: Map<string, LockEntry[]> = existsSync(lockPath) ? parseLock(readFileSync(lockPath, 'utf8')) : new Map();
  const mergeHead = gitTry(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD');
  const refs = ['HEAD', ...(mergeHead ? [mergeHead] : [])];
  let versions = 0;
  for (const f of staged) {
    const idx = show(root, `:${f}`); const old = show(root, `HEAD:${f}`);
    const before = old === null ? [] : (await regionize(f, old)).regions;
    const after = idx === null ? null : await regionize(f, idx);
    const d = diffRegions(before, after?.regions ?? []);
    const byId = new Map((after?.regions ?? []).map((r) => [r.id, r]));
    const renamedFrom = new Map(d.renamed.map((x) => [x.to, x.from]));
    // ruling 12: rename targets are in neither `created` nor `updated`; they get a version carrying renamed_from
    const changed = [...d.updated, ...d.created, ...d.renamed.map((x) => x.to)].map((id) => ({ id, deleted: false }))
      .concat(d.tombstoned.map((id) => ({ id, deleted: true })));
    for (const c of after?.degraded ? [] : changed) {               // §3.6: no Versions from degraded maps; lock still updated
      const r = byId.get(c.id); const lineage = renamedFrom.get(c.id) ?? c.id;
      const prev = g ? (await Promise.all(refs.map((ref) => currentVersion(g, root, lineage, ref)))).filter((x): x is string => !!x) : [];
      appendEvent(root, act.sid, act.writer, { type: 'version', region: c.id, hash: r?.hash ?? null, sig: r?.sig ?? null, deleted: c.deleted,
        degraded: false, prev: [...new Set(prev)], by: act.by, task: act.task, renamed_from: renamedFrom.get(c.id) ?? null });
      versions++;
    }
    if (idx === null) lock.delete(f); else lock.set(f, [toLockEntry(after!, gitBlobSha(idx))]);   // replaces union-merge leftovers
  }
  writeFileSync(lockPath, serializeLock([...lock.values()].flat()));
  git(root, 'add', '--', lockPath, ...(versions ? [join(root, sessionFile(root, act.sid, act.writer))] : []));
  return { versions };
}

/** HEAD edge of each region → its current version on the local HEAD (§4.3). */
export async function refreshHead(g: LoomGraph, root: string, regions?: string[]) {
  const ids = regions ?? (await g.query<{ id: string }>('MATCH (r:Region) RETURN r.id AS id')).map((r) => r.id);
  for (const id of ids) {
    const v = await currentVersion(g, root, id, 'HEAD'); if (!v) continue;
    await g.query(`MATCH (r:Region {id: $id}), (v:Version {id: $v}) OPTIONAL MATCH (r)-[h:HEAD]->(o) WHERE o.id <> $v DELETE h
      WITH DISTINCT r, v MERGE (r)-[:HEAD]->(v)`, { id, v });
  }
}

/** §6.2 step 5 post-commit: import the now-committed lines (blame gives HEAD), then move HEAD on the regions they name. */
export async function postCommit(root: string, g: LoomGraph): Promise<void> {
  await importSessions(g, root, null);
  const head = git(root, 'rev-parse', 'HEAD');
  const rs = await g.query<{ id: string }>('MATCH (v:Version)-[:IN]->(:Commit {sha: $head}) RETURN DISTINCT v.region AS id', { head });
  await refreshHead(g, root, rs.map((r) => r.id));
}
