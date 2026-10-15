// Budget: postEdit, live edges included, under 100 ms p95 on a module larger than django/db/models/query.py (2685 lines).
// Run alone (vitest.perf.config.ts, after the main suite in `pnpm test`): beside 50 CPU-bound test files it measures the runner.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { ensureLoomDir, indexRepo } from '@loom/memory';
import { Live } from '../../src/live/live.js';

const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
let db: LoomDb; let g: LoomGraph;
beforeAll(async () => { db = await LoomDb.connect(); g = db.graph(`loom:test:budget-${process.pid}`); });
afterAll(async () => { await g.drop().catch(() => {}); await db.close(); });

test('postEdit p95 < 100 ms: body edits, new callers from a second worktree, and a contract change on a 3000-line module', async () => {
  const N = 350;
  const fn = (i: number) => `def fn${i}(a, b=None):\n    x = fn${(i + 1) % N}(a)\n    y = helper${i % 10}(x)\n    if b:\n        y = fn${(i + 7) % N}(y, b)\n    z = [y, x, a]\n    return z\n\n\n`;
  const root = mkdtempSync(join(tmpdir(), 'loom-budget-'));
  writeFileSync(join(root, 'util.py'), Array.from({ length: 10 }, (_, i) => `def helper${i}(v):\n    return v\n\n\n`).join(''));
  writeFileSync(join(root, 'big.py'), `from util import ${Array.from({ length: 10 }, (_, i) => `helper${i}`).join(', ')}\n\n\n` + Array.from({ length: N }, (_, i) => fn(i)).join(''));
  expect(readFileSync(join(root, 'big.py'), 'utf8').split('\n').length).toBeGreaterThan(2685);
  sh(root, 'init', '-q', '-b', 'main');
  ensureLoomDir(root, { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true });
  await indexRepo(g, root);
  sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'base');
  const wt = join(mkdtempSync(join(tmpdir(), 'loom-budget-wt-')), 'q');
  sh(root, 'worktree', 'add', '-q', '-b', 'agent-q', wt);
  const live = new Live(g);
  for (const [id, w] of [['x', root], ['q', wt]]) await live.register({ id, person: id, worktree: w, top: w, upstream: null, run: null, task: `t-${id}`, scope: [] });

  const times: number[] = [];
  const timed = async (id: string, w: string, old: string, nu: string) => {
    expect((await live.preEdit(id, { file: 'big.py', edits: [{ old, new: nu }] })).allow).toBe(true);
    writeFileSync(join(w, 'big.py'), readFileSync(join(w, 'big.py'), 'utf8').replace(old, nu));
    const t = performance.now(); await live.postEdit(id, 'big.py'); times.push(performance.now() - t);
  };
  for (let i = 0; i < 20; i++) {
    await timed('x', root, `    z = [y, x, a]\n    return z\n\n\ndef fn${i * 10 + 1}(`, `    z = [y, x, a, ${i}]\n    return z\n\n\ndef fn${i * 10 + 1}(`);   // body
    await timed('q', wt, `def fn${i * 10 + 5}(a, b=None):`, `def new${i}(v):\n    return fn${i * 10 + 2}(v)\n\n\ndef fn${i * 10 + 5}(a, b=None):`);   // new caller
  }
  await timed('x', root, 'def fn2(a, b=None):', 'def fn2(a, b=None, *, strict):');   // contract change that q's new0 calls
  times.sort((p, q) => p - q);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  console.log(`postEdit n=${times.length} p50=${times[times.length >> 1].toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${times.at(-1)!.toFixed(1)}ms`);
  expect(p95).toBeLessThan(100);
  expect((await live.takeNotices('x')).map((m) => m.kind)).toContain('new_caller');
}, 60_000);
