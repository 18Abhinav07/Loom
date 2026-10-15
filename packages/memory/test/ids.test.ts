import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ulid, repoId, tenant, graphName } from '../src/ids.js';
import { ensureLoomDir, readConfig } from '../src/config.js';
import { repo, sh } from './helpers.js';

afterEach(() => { delete process.env.LOOM_HOME; });

test('ulid: 26 Crockford chars, strictly increasing within one millisecond', () => {
  const ids = Array.from({ length: 1000 }, () => ulid(1_700_000_000_000));
  expect(ids.every((i) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(i))).toBe(true);
  expect([...ids].sort()).toEqual(ids);
  expect(new Set(ids).size).toBe(1000);
});

test('repoId: refuses a repo with no commits; smallest root sha with two roots', () => {
  const empty = mkdtempSync(join(tmpdir(), 'loom-e-')); sh(empty, 'init', '-q', '-b', 'main');
  expect(() => repoId(empty)).toThrow(/no commits/);
  const r = repo({ 'a.py': 'x = 1\n' });
  const root1 = sh(r, 'rev-list', '--max-parents=0', 'HEAD');
  sh(r, 'checkout', '-q', '--orphan', 'other'); sh(r, 'commit', '-qm', 'second root', '--allow-empty');
  sh(r, 'checkout', '-q', 'main'); sh(r, 'merge', '-q', '--allow-unrelated-histories', '-m', 'm', 'other');
  const roots = sh(r, 'rev-list', '--max-parents=0', 'HEAD').split('\n').sort();
  expect(roots).toContain(root1);
  expect(repoId(r)).toBe(roots[0]);
});

test('tenant: ~/.loom/config.json wins, else $USER; graphName shape', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-h-')); process.env.LOOM_HOME = home;
  expect(tenant()).toBe(process.env.USER);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'abhinav' }));
  expect(tenant()).toBe('abhinav');
  expect(graphName('abhinav', 'f00')).toBe('loom:abhinav:f00');
});

test('config: written once, repoId kept even when history changes; .gitattributes; share:false excludes sessions', () => {
  const r = repo({ 'a.py': 'x = 1\n' });
  ensureLoomDir(r, { repoId: 'r1', dirs: ['.'], excludes: [], testCmd: null, share: false });
  ensureLoomDir(r, { repoId: 'r2', dirs: ['.'], excludes: [], testCmd: null, share: true });
  expect(readConfig(r)!.repoId).toBe('r1');
  expect(readFileSync(join(r, '.loom/.gitattributes'), 'utf8')).toBe('sessions/*.jsonl merge=union\nregions.lock merge=union\n');
  expect(readFileSync(join(r, '.git/info/exclude'), 'utf8')).toMatch(/^\.loom\/sessions\/$/m);
  expect(existsSync(join(r, '.loom/sessions'))).toBe(true);
});
