// Throwaway smoke: can the repo graph hold Django's regions+edges, and how fast? (P2 Task 0)
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { LoomDb } from '@loom/core';
import { regionize, buildEdges } from '../src/regions/index.js';
const SRC = '/Users/18abhinav07/Documents/loom-v2/bench/cache/django-src';
const files = execFileSync('git', ['ls-files', 'django', 'tests'], { cwd: SRC, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.py'));
let t = Date.now();
const frs = [];
for (const f of files) frs.push(await regionize(f, readFileSync(`${SRC}/${f}`)));
const tParse = Date.now() - t; t = Date.now();
const { edges, unresolved } = buildEdges(frs);
const tEdges = Date.now() - t;
const regions = frs.flatMap((fr) => fr.regions.map((r) => ({ id: r.id, path: fr.path, kind: r.kind, qname: r.qname, hash: r.hash, sig: r.sig })));
const db = await LoomDb.connect(); const g = db.graph('loom:smoke:django');
try { await g.drop(); } catch {}
await g.query('CREATE INDEX FOR (r:Region) ON (r.id)');
t = Date.now();
for (let i = 0; i < regions.length; i += 2000) await g.query('UNWIND $rs AS r CREATE (n:Region) SET n = r', { rs: regions.slice(i, i + 2000) });
const tNodes = Date.now() - t; t = Date.now();
for (const kind of ['CALLS', 'IMPORTS', 'TESTS', 'CONTAINS']) {
  const es = edges.filter((e) => e.kind === kind).map((e) => ({ a: e.from, b: e.to, via: e.via }));
  for (let i = 0; i < es.length; i += 2000) await g.query(`UNWIND $es AS e MATCH (a:Region {id: e.a}), (b:Region {id: e.b}) CREATE (a)-[:${kind} {via: e.via}]->(b)`, { es: es.slice(i, i + 2000) });
}
const tEdgesW = Date.now() - t; t = Date.now();
const [c] = await g.query<{ n: number; m: number }>('MATCH (r:Region) WITH count(r) AS n MATCH ()-[e]->() RETURN n, count(e) AS m');
const id = regions.find((r) => r.qname === 'slugify')!.id;
const q = await g.query(`MATCH (r:Region {id: $id})<-[:CALLS*1..3]-(c) RETURN count(DISTINCT c) AS callers`, { id });
const tQ = Date.now() - t;
console.log(JSON.stringify({ files: files.length, regions: regions.length, edges: edges.length, unresolved, tParse, tEdges, tNodes, tEdgesW, graph: c, slugifyCallers3: q[0], tQ }));
await g.drop(); await db.close();
