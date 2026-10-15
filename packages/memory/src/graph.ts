import type { LoomGraph } from '@loom/core';
import type { Edge, FileRegions } from '@loom/indexer';

const B = 2000;   // S-24: UNWIND batches of 2,000 write Django's 77k regions in under a second
export async function batched<T>(xs: T[], f: (b: T[]) => Promise<unknown>) { for (let i = 0; i < xs.length; i += B) await f(xs.slice(i, i + B)); }

/** Current state of the regions of these files; regions no longer present are tombstoned, never deleted (versions point at them). */
export async function writeRegions(g: LoomGraph, frs: FileRegions[]): Promise<void> {
  const rows = frs.flatMap((fr) => fr.regions.map((r) => ({ id: r.id, path: fr.path, kind: r.kind, qname: r.qname,
    start: r.start, end: r.end, hash: r.hash, sig: r.sig, degraded: fr.degraded })));
  // create-then-set, not MERGE: UNWIND … MERGE grew superlinearly on FalkorDB (10.8k regions: 619 ms vs 241 ms; see P2-11)
  await batched(rows, async (rs) => {
    await g.query('UNWIND $rs AS r OPTIONAL MATCH (o:Region {id: r.id}) WITH r, o WHERE o IS NULL CREATE (:Region {id: r.id})', { rs });
    await g.query(`UNWIND $rs AS r MATCH (n:Region {id: r.id})
      SET n.path = r.path, n.kind = r.kind, n.qname = r.qname, n.start = r.start, n.end = r.end, n.hash = r.hash,
          n.sig = r.sig, n.degraded = r.degraded, n.tombstoned = false, n.stub = false`, { rs });
  });
  await g.query(`UNWIND $fs AS f MATCH (n:Region {path: f.path}) WHERE NOT n.id IN f.ids SET n.tombstoned = true`,
    { fs: frs.map((fr) => ({ path: fr.path, ids: fr.regions.map((r) => r.id) })) });
}

/** Code edges are derived state: those leaving the reparsed files are replaced wholesale. */
export async function writeEdges(g: LoomGraph, paths: string[], edges: Edge[]): Promise<void> {
  await g.query(`MATCH (a:Region)-[e:CALLS|IMPORTS|TESTS|CONTAINS]->() WHERE a.path IN $paths DELETE e`, { paths });
  for (const kind of ['CALLS', 'IMPORTS', 'TESTS', 'CONTAINS'] as const) {
    // the old edges of these files are gone, so CREATE after a dedupe; MERGE onto a hub region scans its edges
    const es = [...new Map(edges.filter((e) => e.kind === kind).map((e) => [`${e.from}>${e.to}`, { a: e.from, b: e.to, via: e.via }])).values()];
    await batched(es, (b) => g.query(`UNWIND $es AS e MATCH (a:Region {id: e.a}), (b:Region {id: e.b})
      CREATE (a)-[:${kind} {via: e.via}]->(b)`, { es: b }));
  }
}
