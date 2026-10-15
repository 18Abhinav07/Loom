import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gitTry } from './git.js';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastT = -1; let lastR: number[] = [];
/** Monotonic ulid: within one millisecond the random part is incremented, so ids sort in creation order. */
export function ulid(now = Date.now()): string {
  if (now === lastT) { let i = 15; while (lastR[i] === 31) lastR[i--] = 0; lastR[i]++; }
  else { lastT = now; lastR = [...randomBytes(16)].map((b) => b & 31); lastR[0] &= 15; }
  let t = ''; for (let i = 0, x = now; i < 10; i++, x = Math.floor(x / 32)) t = B32[x % 32] + t;
  return t + lastR.map((n) => B32[n]).join('');
}

export function repoId(root: string): string {
  const roots = gitTry(root, 'rev-list', '--max-parents=0', 'HEAD');
  if (!roots) throw new Error('no commits: make a first commit before loom init');
  return roots.split('\n').sort()[0];
}

export const loomHome = () => process.env.LOOM_HOME ?? join(homedir(), '.loom');
export function tenant(): string {
  const p = join(loomHome(), 'config.json');
  const t = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).tenant : undefined;
  return String(t ?? process.env.USER ?? 'local');
}
export const graphName = (tenant: string, repoId: string) => `loom:${tenant}:${repoId}`;
