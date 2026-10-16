import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { graphName, readConfig, repoId, tenant } from '@loom/memory';
import { initRepo, main } from '../src/loom.js';

let db: LoomDb;
afterAll(async () => { await db?.close(); });
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=a@t', '-c', 'user.name=A', ...a], { cwd, encoding: 'utf8' }).trim();
function repo() { const d = mkdtempSync(join(tmpdir(), 'loom-cli2-')); mkdirSync(join(d, 'pkg')); writeFileSync(join(d, 'pkg/a.py'), 'def f():\n    return 1\n');
  g(d, 'init', '-q', '-b', 'main'); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'base'); return d; }

test('init: a repo with no commits gets a first commit (B1 state A); writes config with repoId; lock; baseline; git hooks; Claude hooks with Bash matcher; idempotent', async () => {
  db = await LoomDb.connect();
  const empty = mkdtempSync(join(tmpdir(), 'loom-e2-')); g(empty, 'init', '-q');
  expect((await initRepo(empty, { hookCmd: 'node /x/h.cjs', loomCmd: 'node /x/loom.cjs', db })).state).toBe('A');   // spec §3.1 replaced the v1 refusal
  await db.graph(graphName(tenant(), repoId(empty))).drop();
  const r = repo();
  const a = await initRepo(r, { hookCmd: 'node /x/h.cjs', loomCmd: 'node /x/loom.cjs', db });
  const b = await initRepo(r, { hookCmd: 'node /x/h.cjs', loomCmd: 'node /x/loom.cjs', db });
  expect(readConfig(r)!.repoId).toBe(repoId(r));
  expect(existsSync(join(r, '.loom/regions.lock'))).toBe(true);
  expect(readFileSync(join(r, '.git/hooks/pre-commit'), 'utf8')).toMatch(/node \/x\/loom\.cjs hook git pre-commit/);
  const s = JSON.parse(readFileSync(join(r, '.claude/settings.local.json'), 'utf8'));
  expect(s.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|Bash');
  // UserPromptSubmit and Stop stay while the v1 run mode serves them (server.ts onHook); P3 decides
  expect(Object.keys(s.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  expect(a.text).toMatch(/files: 1 · regions: \d+ · degraded: 0 · unresolved calls: \d+ · sessions: 0 · people: 1/);
  expect(b.text).toMatch(/reparsed: 0/);
  await db.graph(graphName(tenant(), repoId(r))).drop();
});

test('loom sync --json and loom lesson add/list run against the repo graph', async () => {
  const r = repo(); await initRepo(r, { hookCmd: 'h', loomCmd: 'l', db });
  const cwd = process.cwd(); process.chdir(r);
  try {
    expect(await main(['lesson', 'add', 'pkg/a.py::f::definition#0', 'keep f pure'])).toBe(0);
    const log: string[] = []; const orig = console.log; console.log = (s: string) => log.push(s);
    try { expect(await main(['lesson', 'list', '--json'])).toBe(0); expect(await main(['sync', '--no-fetch', '--json'])).toBe(0); } finally { console.log = orig; }
    expect(JSON.parse(log[0]).map((l: any) => l.text)).toEqual(['keep f pure']);
    expect(JSON.parse(log[1])).toMatchObject({ briefing: expect.stringMatching(/^\[loom\]/) });
  } finally { process.chdir(cwd); await db.graph(graphName(tenant(), repoId(r))).drop(); }
});
