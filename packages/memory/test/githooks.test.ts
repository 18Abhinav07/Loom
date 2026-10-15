import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { installGitHooks } from '../src/githooks.js';
import { repo, sh, write } from './helpers.js';

/** A fake loom that logs its argv and stdin, so the test sees exactly what each hook passed. */
function fakeLoom(r: string) {
  const p = join(r, '..', `fake-loom-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(p, `#!/bin/sh\necho "LOOM $* $(cat)" >> "${r}.log"\n`); chmodSync(p, 0o755); return p;
}
const hook = (r: string, name: string, body: string) => { const p = join(r, '.git/hooks', name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };

test('installs five hooks; an existing hook is kept as .pre-loom and runs before loom; idempotent', () => {
  const r = repo({ 'a.py': 'x = 1\n' }); const loom = fakeLoom(r);
  hook(r, 'post-commit', `echo MINE >> "${r}.log"`);
  const first = installGitHooks(r, loom); const second = installGitHooks(r, loom);
  expect(first.chained).toEqual(['post-commit']);
  expect(second.chained).toEqual([]);
  expect(readFileSync(join(r, '.git/hooks/post-commit.pre-loom'), 'utf8')).toMatch(/MINE/);
  write(r, { 'b.py': 'y = 2\n' }); sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'two');
  const log = readFileSync(`${r}.log`, 'utf8').trim().split('\n');
  expect(log.filter((l) => l.startsWith('LOOM hook git pre-commit'))).toHaveLength(1);
  expect(log.filter((l) => l.startsWith('LOOM hook git post-commit'))).toHaveLength(1);
  expect(log.indexOf('MINE')).toBeGreaterThan(-1);
  expect(log.indexOf('MINE')).toBeLessThan(log.findIndex((l) => l.startsWith('LOOM hook git post-commit')));
});

test('post-rewrite: the rewrite map on stdin reaches both the old hook and loom', () => {
  const r = repo({ 'a.py': 'x = 1\n' }); const loom = fakeLoom(r);
  hook(r, 'post-rewrite', `echo "OLD $(cat)" >> "${r}.log"`);
  installGitHooks(r, loom);
  sh(r, 'commit', '-q', '--amend', '-m', 'amended');
  const log = readFileSync(`${r}.log`, 'utf8');
  expect(log).toMatch(/OLD [0-9a-f]{40} [0-9a-f]{40}/);
  expect(log).toMatch(/LOOM hook git post-rewrite amend [0-9a-f]{40} [0-9a-f]{40}/);
});

test('core.hooksPath (husky): hooks go into that directory; a failing loom never blocks the commit', () => {
  const r = repo({ 'a.py': 'x = 1\n' });
  mkdirSync(join(r, '.husky')); sh(r, 'config', 'core.hooksPath', '.husky');
  const bad = join(r, '..', `bad-loom-${Date.now()}.sh`); writeFileSync(bad, '#!/bin/sh\nexit 3\n'); chmodSync(bad, 0o755);
  const { dir } = installGitHooks(r, bad);
  expect(dir).toBe(join(r, '.husky'));
  expect(existsSync(join(r, '.husky/pre-commit'))).toBe(true);
  write(r, { 'b.py': 'y = 2\n' }); sh(r, 'add', '-A');
  expect(() => sh(r, 'commit', '-qm', 'ok')).not.toThrow();
});

test("an existing hook that fails still blocks the commit (we do not swallow the user's hook)", () => {
  const r = repo({ 'a.py': 'x = 1\n' }); const loom = fakeLoom(r);
  hook(r, 'pre-commit', 'exit 1');
  installGitHooks(r, loom);
  write(r, { 'b.py': 'y = 2\n' }); sh(r, 'add', '-A');
  expect(() => sh(r, 'commit', '-qm', 'no')).toThrow();
});
