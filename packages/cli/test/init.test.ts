import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { initRepo } from '../src/loom.js';

function gitRepo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-cli-'));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), t); }
  execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
}

test('loom init writes config once, merges hooks without clobbering, is idempotent', () => {
  const repo = gitRepo({ 'pkg/a.py': 'x = 1\n', 'docs/readme.md': '' });
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  initRepo(repo, { hookCmd: 'node /x/loom-hook.cjs', mcpPath: '/x/loom-mcp.cjs' });
  initRepo(repo, { hookCmd: 'node /x/loom-hook.cjs', mcpPath: '/x/loom-mcp.cjs' });
  const cfg = JSON.parse(readFileSync(join(repo, '.loom/config.json'), 'utf8'));
  expect(cfg).toEqual({ run: `coord:local:${basename(repo)}`, dirs: ['pkg'], daemon: 'http://127.0.0.1:4318' });
  const s = JSON.parse(readFileSync(join(repo, '.claude/settings.local.json'), 'utf8'));
  expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
  expect(s.hooks.Stop.flatMap((h: any) => h.hooks.map((x: any) => x.command))).toEqual(['echo mine', 'node /x/loom-hook.cjs claude Stop']);
  expect(s.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit');
  expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toMatch(/^\.loom\/$/m);
  expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toMatch(/^\.mcp\.json$/m);
  expect(JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8')).mcpServers).toEqual({
    other: { command: 'x' }, loom: { command: 'node', args: ['/x/loom-mcp.cjs'] } });
});

test('loom init refuses a worktree of a bare repository (no main checkout to index)', () => {
  const src = gitRepo({ 'pkg/a.py': 'x = 1\n' });
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd });
  g(src, 'add', '-A'); g(src, 'commit', '-qm', 'base');
  const bare = `${src}.git`; g(src, 'clone', '-q', '--bare', src, bare);
  const wt = `${src}-wt`; g(bare, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  expect(() => initRepo(wt, { hookCmd: 'x' })).toThrow(/bare repository/);
});
