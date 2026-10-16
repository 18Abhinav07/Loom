import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

/** The machine's dashboard token: `<loom home>/token`, 32 hex, mode 0600. Anything that can read it may talk to the lead. */
export function machineToken(loomHome = join(homedir(), '.loom')): string {
  const p = join(loomHome, 'token');
  if (existsSync(p)) { const t = readFileSync(p, 'utf8').trim(); if (/^[0-9a-f]{32}$/.test(t)) return t; }
  mkdirSync(loomHome, { recursive: true });
  const t = randomBytes(16).toString('hex');
  writeFileSync(p, t + '\n', { mode: 0o600 }); chmodSync(p, 0o600);
  return t;
}

export function authorized(req: IncomingMessage, token: string): boolean {
  const got = String(req.headers['x-loom-token'] ?? new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '');
  return got.length === token.length && timingSafeEqual(Buffer.from(got), Buffer.from(token));
}
