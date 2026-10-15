// E2: lease CAS under contention. 50 agents × 200 attempts on 20 symbols, each worker on its own connection.
// Run: pnpm tsx bench/e2/leases.mts  → bench/results/e2.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoomDb } from '../../packages/core/src/db.js';
import { acquire, CONFLICTS, release, type LeaseMode } from '../../packages/daemon/src/lease.js';

// The detector keeps its own copy of the matrix; E2_BROKEN=1 empties the CAS's copy as a negative control (must report > 0).
const MATRIX = structuredClone(CONFLICTS);
if (process.env.E2_BROKEN) { CONFLICTS.write = []; CONFLICTS.contract = []; }
const AGENTS = 50, ATTEMPTS = 200, SYMBOLS = 20, READERS = 5;
const run = `coord:e2:${Date.now()}`;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every grant: CAS issued (t0) and returned (t1), and when the holder stopped using it (tu, before release, so the
// DB lease covers [t1, tu] for sure). Checked after the run: see countDoubleGrants().
interface Grant { agent: string; mode: LeaseMode; t0: number; t1: number; tu: number }
const grants = new Map<string, Grant[]>();

const admin = await LoomDb.connect();
const g0 = admin.graph(run);
await g0.query(`UNWIND range(0, $n - 1) AS i CREATE (:Region {id: 's' + toString(i)})`, { n: SYMBOLS });
await g0.query(`UNWIND range(0, $n - 1) AS i CREATE (:Agent {id: 'a' + toString(i)})`, { n: AGENTS });

let attempts = 0, granted = 0, denied = 0, graphViolations = 0;
let doubleGrants: number;
const lat: number[] = [], readLat: number[] = [];
let done = false;

async function worker(i: number) {
  const db = await LoomDb.connect(); const g = db.graph(run); const agent = `a${i}`;
  for (let k = 0; k < ATTEMPTS; k++) {
    const n = 1 + Math.floor(Math.random() * 3);
    const sids = [...new Set(Array.from({ length: n }, () => `s${Math.floor(Math.random() * SYMBOLS)}`))];
    const mode: LeaseMode = Math.random() < 0.7 ? 'write' : 'contract';
    const t0 = performance.now();
    const got = await acquire(g, agent, sids, mode, 't');
    lat.push(performance.now() - t0); attempts++;
    if (got !== sids.length) { denied++; continue; }
    granted++;
    const gr: Grant = { agent, mode, t0, t1: performance.now(), tu: 0 };
    await sleep(Math.random() * 3);
    gr.tu = performance.now();
    for (const s of sids) { if (!grants.has(s)) grants.set(s, []); grants.get(s)!.push(gr); }
    await release(g, agent, sids);
  }
  await db.close();
}

async function reader() {
  const db = await LoomDb.connect(); const g = db.graph(run);
  while (!done) { const t = performance.now(); await g.query(`MATCH (a:Agent)-[l:LEASED]->(s:Region) RETURN count(l)`); readLat.push(performance.now() - t); }
  await db.close();
}

async function crossCheck() {
  const db = await LoomDb.connect(); const g = db.graph(run);
  while (!done) {
    const [r] = await g.query<{ n: number }>(`MATCH (s:Region)<-[l:LEASED]-() WITH s, collect(l.mode) AS m, count(l) AS n
      WHERE n > 1 AND (size([x IN m WHERE x = 'write']) > 1 OR size([x IN m WHERE x = 'contract']) > 1) RETURN count(s) AS n`);
    graphViolations += r?.n ?? 0;
    await sleep(100);
  }
  await db.close();
}

/** Two leases on one symbol both live at once: the one granted second must not conflict with the first.
 *  If the CAS windows overlap the order is unknown, so only a conflict in both directions counts. */
function countDoubleGrants(): number {
  let n = 0;
  for (const gs of grants.values()) for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
    const [x, y] = [gs[i], gs[j]];
    if (x.agent === y.agent || Math.max(x.t1, y.t1) >= Math.min(x.tu, y.tu)) continue;
    const yAfter = MATRIX[y.mode].includes(x.mode), xAfter = MATRIX[x.mode].includes(y.mode);
    if (x.t1 < y.t0 ? yAfter : y.t1 < x.t0 ? xAfter : yAfter && xAfter) n++;
  }
  return n;
}

const t0 = performance.now();
const side = [...Array.from({ length: READERS }, reader), crossCheck()];
await Promise.all(Array.from({ length: AGENTS }, (_, i) => worker(i)));
const secs = (performance.now() - t0) / 1000;
done = true; await Promise.all(side);
doubleGrants = countDoubleGrants();
await g0.drop(); await admin.close();

const out = { attempts, granted, denied, double_grants: doubleGrants, graph_violations: graphViolations,
  throughput_per_s: Math.round(attempts / secs), p50_ms: pct(lat, 0.5), p99_ms: pct(lat, 0.99),
  read_p50_ms: pct(readLat, 0.5), read_p99_ms: pct(readLat, 0.99) };
const f = join(dirname(fileURLToPath(import.meta.url)), '..', 'results', process.env.E2_BROKEN ? 'e2-control.json' : 'e2.json');
mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out));
