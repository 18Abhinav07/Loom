// S1: 32 simulated agents × 200 lease ops on one graph, no LLM. Bar: 0 double grants. Reports p50/p99.
import { LoomDb } from '../../packages/core/src/db.js';
import { acquire, release } from '../../packages/daemon/src/lease.js';
const AGENTS = 32, OPS = 200, REGIONS = 64;
const db = await LoomDb.connect(); const g = db.graph(`loom:s1:${Date.now()}`);
await g.query('UNWIND range(0, $n - 1) AS i CREATE (:Region {id: "r" + toString(i)})', { n: REGIONS });
await g.query('UNWIND range(0, $n - 1) AS i CREATE (:Agent {id: "a" + toString(i)})', { n: AGENTS });
const lat: number[] = []; let doubles = 0; let grants = 0;
await Promise.all(Array.from({ length: AGENTS }, async (_, i) => {
  for (let k = 0; k < OPS; k++) {
    const r = `r${Math.floor(Math.random() * REGIONS)}`; const t = performance.now();
    const got = await acquire(g, `a${i}`, [r], 'write', 's1'); lat.push(performance.now() - t);
    if (got) {
      grants++;
      const [{ n }] = await g.query<{ n: number }>('MATCH (:Agent)-[l:LEASED]->(:Region {id: $r}) WHERE l.expires > $now RETURN count(l) AS n', { r, now: Date.now() });
      if (n > 1) doubles++;
      await release(g, `a${i}`, [r]);
    }
  }
}));
lat.sort((a, b) => a - b);
const p = (q: number) => lat[Math.floor(q * (lat.length - 1))].toFixed(1);
console.log(`S1 agents=${AGENTS} ops=${AGENTS * OPS} grants=${grants} double_grants=${doubles} p50_ms=${p(0.5)} p99_ms=${p(0.99)}`);
await g.drop(); await db.close(); process.exit(doubles ? 1 : 0);
