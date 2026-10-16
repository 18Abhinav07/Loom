// B2: per-function locks hold on TypeScript the same way they do on Python.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { ensureLoomDir, indexRepo } from '@loom/memory';
import { Live, type LiveAgent } from '../../src/live/live.js';

const A_TS = 'export function f(): number {\n  return 1;\n}\n\nexport function g(): number {\n  return 2;\n}\n';
const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();

let db: LoomDb; let g: LoomGraph; let root: string; let live: Live; let n = 0;
const agent = (id: string, person: string): LiveAgent =>
  ({ id, person, worktree: root, top: root, upstream: null, run: null, task: `t-${id}`, scope: [] });
const edit = (a: string, old: string, nu: string) => live.preEdit(a, { file: 'src/a.ts', edits: [{ old, new: nu }] });
const leases = (a: string) => g.query<{ id: string }>('MATCH (:Agent {id: $a})-[:LEASED]->(r:Region) RETURN r.id AS id ORDER BY id', { a });

beforeAll(async () => { db = await LoomDb.connect(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'loom-ts-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.ts'), A_TS);
  sh(root, 'init', '-q', '-b', 'main');
  ensureLoomDir(root, { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true });
  g = db.graph(`loom:test:ts-${process.pid}-${n++}`);
  await indexRepo(g, root);
  sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'base');
  live = new Live(g, { now: () => 1_000_000_000_000 });
  for (const a of [agent('x', 'P1'), agent('y', 'P2')]) await live.register(a);
});
afterEach(async () => { await g.drop(); });

test('TS: x edits f → allow; y edits f → deny naming x; y edits g → allow', async () => {
  expect(await edit('x', 'return 1;', 'return 10;')).toMatchObject({ allow: true });
  const d = await edit('y', 'return 1;', 'return 11;');
  expect(d.allow).toBe(false);
  if (!d.allow) { expect(d.reason).toContain('agent x'); expect(d.reason).toContain('t-x'); }
  expect(await edit('y', 'return 2;', 'return 20;')).toMatchObject({ allow: true });
  const [x] = await leases('x'), [y] = await leases('y');
  expect(x.id).toMatch(/^src\/a\.ts::f::/);
  expect(y.id).toMatch(/^src\/a\.ts::g::/);
});
