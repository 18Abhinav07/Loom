import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { handover } from '../../src/live/handover.js';

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
  return r.stdout.trim();
};
const read = (wt: string, f: string) => readFileSync(join(wt, f), 'utf8');
const write = (wt: string, f: string, s: string) => writeFileSync(join(wt, f), s);

const BASE = 'def f():\n    return 1\n\n\ndef g():\n    return 2\n';
const LANDED_F = 'return 10';
const DIRTY_G = 'return 20';

/** main and landed both start at a base commit of a.py; landed then commits `landed`. Returns the repo on main. */
function repo(text = BASE, landed = BASE.replace('return 1', LANDED_F)): string {
  const wt = mkdtempSync(join(tmpdir(), 'loom-ho-'));
  git(wt, 'init', '-q', '-b', 'main');
  write(wt, 'a.py', text); git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'base');
  git(wt, 'checkout', '-qb', 'landed');
  write(wt, 'a.py', landed); git(wt, 'commit', '-qam', 'landed');
  git(wt, 'checkout', '-q', 'main');
  return wt;
}

test('RC2: dirty edits in the same file but other lines: plain merge refuses, handover is clean, dirty edits kept', async () => {
  const wt = repo();
  write(wt, 'a.py', BASE.replace('return 2', DIRTY_G));
  expect(spawnSync('git', ['merge', '--no-edit', 'landed'], { cwd: wt }).status).not.toBe(0);   // the RC2 bug, reproduced
  const h = await handover(wt, 'landed');
  expect(h.status).toBe('clean');
  expect(h.stashKept).toBe(false);
  expect(read(wt, 'a.py')).toContain(LANDED_F); expect(read(wt, 'a.py')).toContain(DIRTY_G);
  expect(git(wt, 'stash', 'list')).toBe('');
});

test('committed edits touching-hunk in different regions: git conflicts, regionMerge resolves', async () => {
  const one = 'def f(): return 1\ndef g(): return 2\n';
  const wt = repo(one, one.replace('return 1', 'return 10'));
  write(wt, 'a.py', one.replace('return 2', 'return 20')); git(wt, 'commit', '-qam', 'ours');
  expect(spawnSync('git', ['merge-tree', '--write-tree', 'main', 'landed'], { cwd: wt }).status).toBe(1);   // git alone conflicts
  const h = await handover(wt, 'landed');
  expect(h.status).toBe('resolved');
  expect(git(wt, 'diff', '--name-only', '--diff-filter=U')).toBe('');
  expect(read(wt, 'a.py')).toBe('def f(): return 10\ndef g(): return 20\n');
  expect(git(wt, 'rev-parse', 'HEAD^2')).toBe(git(wt, 'rev-parse', 'landed'));
});

test('same region on both sides: markers left, regions named', async () => {
  const wt = repo();
  write(wt, 'a.py', BASE.replace('return 1', 'return 11')); git(wt, 'commit', '-qam', 'ours');
  const h = await handover(wt, 'landed');
  expect(h).toMatchObject({ status: 'conflict', files: ['a.py'], regions: ['a.py::f::definition#0'] });
  expect(read(wt, 'a.py')).toContain('<<<<<<<');
});

test('stash pop conflict keeps the stash', async () => {
  const wt = repo();
  write(wt, 'a.py', BASE.replace('return 1', 'return 12'));
  const h = await handover(wt, 'landed');
  expect(h.stashKept).toBe(true);
  expect(git(wt, 'stash', 'list')).not.toBe('');
  expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(wt, 'rev-parse', 'landed'));
});

test('already up to date → noop', async () => {
  const wt = repo();
  git(wt, 'merge', '-q', '--no-edit', 'landed');
  expect((await handover(wt, 'landed')).status).toBe('noop');
});
