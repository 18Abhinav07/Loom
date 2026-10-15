// E4 indexer slice (plan 04 Task 6): time of one incremental Coordinator.onEdit on Django's text.py, against a graph
// of the whole django/ tree. Alternates a body edit (behavior) with a signature edit (contract → impact + notices).
// Needs FalkorDB up. Usage: pnpm exec tsx bench/e4/indexer.mts   (E4_N edits, default 100)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LoomDb } from '../../packages/core/src/db.js';
import { Coordinator } from '../../packages/daemon/src/coordinator.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'bench/cache/django-src');
const N = Number(process.env.E4_N ?? 100);
const F = 'django/utils/text.py';
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: +Math.max(...xs).toFixed(1) });

const wt = mkdtempSync(join(tmpdir(), 'loom-e4i-'));
mkdirSync(join(wt, 'django/utils'), { recursive: true });
copyFileSync(join(SRC, F), join(wt, F));
execFileSync('git', ['init', '-q'], { cwd: wt });
const BASE = readFileSync(join(wt, F), 'utf8');
const EDITS: [string, (s: string) => string][] = [
  ['body', (s) => s.replace('    return x[0].upper() + x[1:]', '    return x[:1].upper() + x[1:]')],
  ['signature', (s) => s.replace('def capfirst(x):', 'def capfirst(x, *, strict=False):')],
];
if (EDITS.some(([, f]) => f(BASE) === BASE)) throw new Error('edit fixtures no longer match django/utils/text.py');

const db = await LoomDb.connect();
const run = `coord:e4i:${Date.now()}`;
const g = db.graph(run);
try {
  const c = await Coordinator.create(g, run);
  const t0 = performance.now();
  await c.indexBase(SRC, ['django']);
  const baseMs = performance.now() - t0;
  await c.registerAgent('E4', 'claude', wt);
  const [{ n: symbols }] = await g.query<{ n: number }>('MATCH (s:Symbol) RETURN count(s) AS n');
  const lat: Record<string, number[]> = { body: [], signature: [] };
  for (let i = 0; i < N; i++) {
    const [kind, f] = EDITS[(i >> 1) % 2];
    writeFileSync(join(wt, F), i % 2 ? BASE : f(BASE));      // body, back, signature, back: every call sees a real change
    const t = performance.now(); await c.onEdit('E4', wt, F); lat[kind].push(performance.now() - t);
  }
  const all = [...lat.body, ...lat.signature];
  const out = { n: N, file: F, graph_symbols: symbols, base_index_s: +(baseMs / 1000).toFixed(1),
    onEdit: stats(all), body: stats(lat.body), signature: stats(lat.signature), pass: pct(all, 0.95) < 150 };
  mkdirSync(join(ROOT, 'bench/results'), { recursive: true });
  writeFileSync(join(ROOT, 'bench/results/e4-indexer.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out));
} finally { await g.drop(); await db.close(); }
