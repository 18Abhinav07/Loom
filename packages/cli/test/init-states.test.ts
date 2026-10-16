// B1: `loom init` in each repo state — A: no commits, B: commits but no .loom, C: .loom already there.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { graphName, repoId, tenant } from '@loom/memory';
import { initRepo } from '../src/loom.js';

let db: LoomDb;
const made: string[] = [];
beforeAll(async () => { db = await LoomDb.connect(); });
afterAll(async () => { for (const r of made) await db.graph(graphName(tenant(), repoId(r))).drop().catch(() => {}); await db.close(); });

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim();
function dir(files: Record<string, string>, commit: boolean): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-states-'));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), t); }
  git(d, 'init', '-q');
  if (commit) { git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base'); }
  made.push(d);
  return d;
}
const init = (d: string, commit?: boolean) => initRepo(d, { hookCmd: 'h', loomCmd: 'l', db, commit });

test('state A: an empty repo gets an initial commit then a full init', async () => {
  const d = dir({ 'a.py': 'def f():\n    return 1\n' }, false);
  const r = await init(d);
  expect(r.state).toBe('A');
  expect(Number(git(d, 'rev-list', '--count', 'HEAD'))).toBeGreaterThanOrEqual(1);
  expect(git(d, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(expect.arrayContaining(['.gitignore', 'a.py']));
  expect(JSON.parse(readFileSync(join(d, '.loom/config.json'), 'utf8')).v).toBe(2);
  expect(r.summary).toMatchObject({ files: 2, regions: { python: 1 } });   // a.py and the .gitignore init wrote
});

test('state B: commit:true commits .loom', async () => {
  const d = dir({ 'a.py': 'x = 1\n' }, true);
  const r = await init(d, true);
  expect(r).toMatchObject({ state: 'B', committed: true });
  expect(git(d, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(expect.arrayContaining(['.loom/config.json', '.loom/regions.lock']));
});

test('state B: commit:false leaves .loom untracked', async () => {
  const d = dir({ 'a.py': 'x = 1\n' }, true);
  const r = await init(d, false);
  expect(r).toMatchObject({ state: 'B', committed: false });
  expect(git(d, 'ls-files', '.loom')).toBe('');
  expect(git(d, 'rev-list', '--count', 'HEAD')).toBe('1');
});
