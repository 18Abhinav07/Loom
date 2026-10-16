// B1: `loom lead` starts the user's claude with the Loom channel, without a paid key.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { leadArgs, leadEnv, startLead } from '../src/lead.js';

test('leadArgs and leadEnv', () => {
  expect(leadArgs([])).toEqual(['--dangerously-load-development-channels', 'server:loom']);
  expect(leadArgs(['--model', 'haiku'])).toEqual(['--dangerously-load-development-channels', 'server:loom', '--model', 'haiku']);
  const e = leadEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk', ANTHROPIC_BASE_URL: 'x' });
  expect(e).toEqual({ PATH: '/bin', LOOM_LEAD: '1' });
});

test('startLead runs claude at the repo root with the channel flag, LOOM_LEAD=1 and no ANTHROPIC_*', () => {
  const d = mkdtempSync(join(tmpdir(), 'loom-lead-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  writeFileSync(join(d, '.mcp.json'), JSON.stringify({ mcpServers: { loom: { command: 'node', args: ['x'] } } }));
  const out = join(d, 'seen.json');
  const bin = join(d, 'fake-claude');
  writeFileSync(bin, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), lead: process.env.LOOM_LEAD, key: process.env.ANTHROPIC_API_KEY ?? null, cwd: process.cwd() }));\n`);
  chmodSync(bin, 0o755);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try { expect(startLead(d, { bin })).toBe(0); } finally { delete process.env.ANTHROPIC_API_KEY; }
  const seen = JSON.parse(readFileSync(out, 'utf8'));
  expect(seen).toMatchObject({ argv: ['--dangerously-load-development-channels', 'server:loom'], lead: '1', key: null });
  expect(execFileSync('pwd', { cwd: seen.cwd, encoding: 'utf8' }).trim()).toBe(execFileSync('pwd', { cwd: d, encoding: 'utf8' }).trim());
});

test('startLead refuses a repo without the loom MCP server', () => {
  const d = mkdtempSync(join(tmpdir(), 'loom-lead-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  expect(() => startLead(d, { bin: '/bin/true' })).toThrow(/loom init/);
});
