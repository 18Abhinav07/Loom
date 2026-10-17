// B4: `loom team start --wait` against a real daemon with fake claude, then status/msg/stop. Real FalkorDB.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { LoomDb } from '@loom/core';
import { startServer } from '../../daemon/src/server.js';
import { ensureLoomDir, graphName, repoId } from '@loom/memory';
import { teamCmd } from '../src/team.js';
import { git, gitTree } from '../../daemon/test/helpers.js';

const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'tcl' }));
const BIN = join(__dirname, '..', '..', 'daemon', 'test', 'fake-claude.mjs');
let db: LoomDb; let srv: { port: number; close(): Promise<void> }; let url: string; const graphs: string[] = [];
beforeAll(async () => {
  process.env.FAKE_COMMIT = '1';
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: null, recordDir: mkdtempSync(join(tmpdir(), 'rec-')), home, teamBin: BIN, teamPoll: 100 });
  url = `http://127.0.0.1:${srv.port}`;
});
afterAll(async () => { await srv.close(); for (const g of graphs) await db.graph(g).drop().catch(() => {}); await db.close(); delete process.env.FAKE_COMMIT; });

function repo() {
  const r = gitTree({ 'a.py': 'x = 1\n' });
  const cfg = ensureLoomDir(r, { repoId: repoId(r), dirs: ['.'], excludes: [], testCmd: null, share: true });
  graphs.push(graphName('tcl', cfg.repoId));
  mkdirSync(join(r, '.loom', 'plans'), { recursive: true });
  writeFileSync(join(r, '.loom', 'plans', 'p.md'), '---\ngoal: g\ntest: \'true\'\ntasks:\n  - id: a\n    title: a\n    owns: [a.py]\n    after: []\n    done: ok\n    prompt: do a\n---\nbody\n');
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'loom init');
  return r;
}
const run = async (args: string[], cwd: string) => {
  const out: string[] = [];
  const lg = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  const er = vi.spyOn(console, 'error').mockImplementation((...a) => { out.push(a.join(' ')); });
  try { return { code: await teamCmd(args, url, cwd), out: out.join('\n') }; } finally { lg.mockRestore(); er.mockRestore(); }
};

test('team start --wait exits 0 and prints landed', async () => {
  const r = repo();
  const x = await run(['start', 'p', '--wait'], r);
  expect(x.code).toBe(0);
  expect(x.out).toMatch(/a\s+landed/);
}, 30_000);

test('a bad plan prints its problems and exits 1; status lists the earlier team', async () => {
  const r = repo();
  const bad = await run(['start', 'nope'], r);
  expect(bad.code).toBe(1); expect(bad.out).toMatch(/problem: no plan file/);
  await run(['start', 'p', '--wait'], r);
  const s = await run(['status'], r);
  expect(s.code).toBe(0); expect(s.out).toMatch(/\(p\): done/);
}, 30_000);
