import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { graphName, repoId, tenant } from '@loom/memory';
import { initRepo } from '../src/loom.js';

let db: LoomDb;
beforeAll(async () => { db = await LoomDb.connect(); });
afterAll(async () => { await db.close(); });

function gitRepo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-cli-'));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), t); }
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'base');   // v2: init needs a first commit (repoId)
  return d;
}

test('loom init writes config once, merges hooks without clobbering, is idempotent', async () => {
  const repo = gitRepo({ 'pkg/a.py': 'x = 1\n', 'docs/readme.md': '' });
  mkdirSync(join(repo, '.claude'));
  writeFileSync(join(repo, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  await initRepo(repo, { hookCmd: 'node /x/loom-hook.cjs', mcpPath: '/x/loom-mcp.cjs', loomCmd: 'node /x/loom.cjs', db });
  await initRepo(repo, { hookCmd: 'node /x/loom-hook.cjs', mcpPath: '/x/loom-mcp.cjs', loomCmd: 'node /x/loom.cjs', db });
  const cfg = JSON.parse(readFileSync(join(repo, '.loom/config.json'), 'utf8'));
  expect(cfg).toMatchObject({ run: `coord:local:${basename(repo)}`, dirs: ['pkg'], daemon: 'http://127.0.0.1:4318', repoId: repoId(repo) });   // v1 keys kept until P3
  const s = JSON.parse(readFileSync(join(repo, '.claude/settings.local.json'), 'utf8'));
  expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
  expect(s.enabledMcpjsonServers).toEqual(['loom']);   // pre-approved: claude's own prompt defaults to "continue without", which leaves the lead with no channel
  expect(s.hooks.Stop.flatMap((h: any) => h.hooks.map((x: any) => x.command))).toEqual(['echo mine', 'node /x/loom-hook.cjs claude Stop']);
  expect(s.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|Bash');
  expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).not.toMatch(/^\.loom\/$/m);   // v2: .loom/ records travel through git
  expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toMatch(/^\.mcp\.json$/m);
  expect(JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8')).mcpServers).toEqual({
    other: { command: 'x' }, loom: { command: 'node', args: ['/x/loom-mcp.cjs'] } });
  await db.graph(graphName(tenant(), repoId(repo))).drop();
});

test('loom init refuses a worktree of a bare repository (no main checkout to index)', async () => {
  const src = gitRepo({ 'pkg/a.py': 'x = 1\n' });
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd });
  const bare = `${src}.git`; g(src, 'clone', '-q', '--bare', src, bare);
  const wt = `${src}-wt`; g(bare, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  await expect(initRepo(wt, { hookCmd: 'x', loomCmd: 'l', db })).rejects.toThrow(/bare repository/);
});

test('config v2: languages, compiler and source dirs across languages; an older config is upgraded keeping its keys', async () => {
  const repo = gitRepo({ 'src/a.ts': 'export function f() {}\n', 'tsconfig.json': '{}', 'lib/b.py': 'x = 1\n', 'docs/r.md': '' });
  await initRepo(repo, { hookCmd: 'h', loomCmd: 'l', db });
  const cfg = JSON.parse(readFileSync(join(repo, '.loom/config.json'), 'utf8'));
  expect(cfg).toMatchObject({ v: 2, dirs: ['lib', 'src'], compile: 'npx tsc --noEmit -p .', langs: { ts: 1, python: 1, md: 1, json: 1 } });
  const old = { ...cfg, dirs: ['lib'], testCmd: 'make t', mine: 1 }; delete old.v; delete old.langs; delete old.compile;
  writeFileSync(join(repo, '.loom/config.json'), JSON.stringify(old));
  await initRepo(repo, { hookCmd: 'h', loomCmd: 'l', db });
  expect(JSON.parse(readFileSync(join(repo, '.loom/config.json'), 'utf8'))).toMatchObject({ v: 2, dirs: ['lib'], testCmd: 'make t', mine: 1, compile: 'npx tsc --noEmit -p .' });
  await db.graph(graphName(tenant(), repoId(repo))).drop();
});
