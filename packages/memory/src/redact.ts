import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// §4.4: tokens and secrets are never written. Every turn passes through here before it reaches .loom/.
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /sk-ant-[\w-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[\w-]{10,}/g,
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(text: string, envValues: string[] = []): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, '[redacted]');
  for (const v of envValues) if (v.length >= 8) out = out.replace(new RegExp(esc(v), 'g'), '[redacted]');
  return out;
}

/** Values of `.env*` files at the repo root, 8+ chars: what a user may paste into a prompt. */
export function envValues(root: string): string[] {
  if (!existsSync(root)) return [];
  const vals: string[] = [];
  for (const f of readdirSync(root).filter((f) => /^\.env(\..+)?$/.test(f))) {
    try {
      for (const l of readFileSync(join(root, f), 'utf8').split('\n')) {
        const m = /^\s*(?:export\s+)?[\w.]+\s*=\s*(.*)$/.exec(l);
        const v = m?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
        if (v && v.length >= 8) vals.push(v);
      }
    } catch { /* unreadable .env: nothing to match */ }
  }
  return vals;
}

export const TURN_CAP = 4000;
export function turnEvent(from: string, text: string, tools?: Record<string, number>, env: string[] = []) {
  const clean = redact(text, env);
  return { type: 'turn' as const, from, text: clean.slice(0, TURN_CAP), ...(clean.length > TURN_CAP ? { cut: true as const } : {}), ...(tools ? { tools } : {}) };
}
