// `loom lead`: the user's own claude, started with the Loom channel so the dashboard can talk to it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { subscriptionEnv } from '@loom/core';

export const leadArgs = (extra: string[]) => ['--dangerously-load-development-channels', 'server:loom', ...extra];

/** The user's env minus any paid key (the lead runs on the subscription), marked as the lead for Loom's hooks. */
export function leadEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...subscriptionEnv(env), LOOM_LEAD: '1' };
}

/** Runs claude in the foreground at the repo root and returns its exit code. */
export function startLead(cwd: string, o: { bin?: string; extra?: string[] } = {}): number {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  const mp = join(root, '.mcp.json');
  if (!existsSync(mp) || !JSON.parse(readFileSync(mp, 'utf8')).mcpServers?.loom) throw new Error('the Loom MCP server is not set up here: run `loom init` first');
  console.log('Claude will ask you to confirm the Loom channel; choose "I am using this for local development".');
  const r = spawnSync(o.bin ?? process.env.LOOM_CLAUDE_BIN ?? 'claude', leadArgs(o.extra ?? []), { cwd: root, stdio: 'inherit', env: leadEnv(process.env) });
  if (r.error) throw r.error;
  return r.status ?? 1;
}
