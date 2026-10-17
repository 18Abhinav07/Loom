import type { LoomGraph } from '@loom/core';
import { writeCollision } from './collide.js';
import { collisionId } from './events.js';
import { gitTry } from './git.js';
import { importSessions } from './importer.js';
import { activeSession } from './session.js';

const revs = (root: string, a: string, b: string) => new Set((gitTry(root, 'rev-list', `${a}..${b}`) ?? '').split('\n').filter(Boolean));

/** §4.3 divergence: since the merge base I and someone else each landed a Version of the same region. One record per region,
 *  written to my active session (else my newest) and imported at once; a second sync finds it already there. Returns the new records. */
export async function detectDivergence(g: LoomGraph, root: string, me: string, up: string): Promise<number> {
  const base = gitTry(root, 'merge-base', 'HEAD', up);
  if (!base) return 0;
  const mine = revs(root, base, 'HEAD'), theirs = revs(root, base, up);
  if (!mine.size || !theirs.size) return 0;
  const rows = await g.query<{ id: string; region: string; commits: string[]; at: number; sid: string | null; person: string | null }>(
    `MATCH (v:Version)-[:OF]->(r:Region) WHERE NOT coalesce(v.baseline, false) AND size(coalesce(v.commits, [])) > 0
     OPTIONAL MATCH (v)-[:BY]->(b) OPTIONAL MATCH (s:Session {id: split(coalesce(b.id, ''), '/')[0]})
     RETURN v.id AS id, r.id AS region, v.commits AS commits, v.at AS at, s.id AS sid, s.person AS person`);
  const newest = (xs: typeof rows) => xs.reduce((m, x) => (!m || x.at > m.at || (x.at === m.at && x.id > m.id) ? x : m), null as (typeof rows)[number] | null);
  const regions = [...new Set(rows.map((r) => r.region))].sort();
  const mySid = activeSession(root)?.sid ?? (await g.query<{ id: string }>('MATCH (s:Session {person: $me}) RETURN s.id AS id ORDER BY s.started DESC, s.id DESC LIMIT 1', { me }))[0]?.id;
  if (!mySid) return 0;
  const writer = activeSession(root)?.writer ?? 'main';
  let n = 0;
  for (const region of regions) {
    const here = rows.filter((r) => r.region === region && r.person && r.sid);
    const a = newest(here.filter((r) => r.person === me && r.commits.some((c) => mine.has(c))));
    const b = newest(here.filter((r) => r.person !== me && r.commits.some((c) => theirs.has(c))));
    if (!a || !b) continue;
    const parties = [{ person: a.person!, session: a.sid! }, { person: b.person!, session: b.sid! }];
    const version = a.id > b.id ? a.id : b.id;
    const id = collisionId('divergence', parties, [region], version);
    if ((await g.query('MATCH (c:Collision {id: $id}) RETURN c.id', { id })).length) continue;
    writeCollision(root, mySid, { kind: 'divergence', region: [region], parties, outcome: 'open', version,
      detail: `${a.person} and ${b.person} each changed ${region.split('::')[1] ?? region} since ${base.slice(0, 7)}` }, writer);
    n++;
  }
  if (n) await importSessions(g, root, null);
  return n;
}
