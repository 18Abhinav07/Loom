import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// §4.4: tokens and secrets are never written. Every turn passes through here before it reaches .loom/.
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /sk-ant-[\w-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,
  /\b[sr]k_live_[A-Za-z0-9]{16,}/g,
  /AIza[\w-]{35}/g,
  /xox[baprs]-[\w-]{10,}/g,
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redact(text: string, envValues: string[] = []): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, '[redacted]');
  for (const v of envValues) if (v.length >= 8) out = out.replace(new RegExp(esc(v), 'g'), '[redacted]');
  return out;
}

const SKIP = new Set(['.git', '.loom', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', 'vendor']);
const cache = new Map<string, { mtime: number; vals: string[] }>();

/** `.env*` files anywhere in the repo (dependencies and build output skipped), depth 6. */
function envFiles(dir: string, depth = 0, out: string[] = []): string[] {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.isFile() && /^\.env(\..+)?$/.test(e.name)) out.push(join(dir, e.name));
    else if (e.isDirectory() && depth < 6 && !SKIP.has(e.name)) envFiles(join(dir, e.name), depth + 1, out);
  }
  return out;
}

/** Values of 8+ chars in the repo's `.env*` files: what a user may paste into a prompt. Each file is re-read when it changes. */
export function envValues(root: string): string[] {
  if (!existsSync(root)) return [];
  const vals: string[] = [];
  for (const f of envFiles(root)) {
    try {
      const mtime = statSync(f).mtimeMs; const hit = cache.get(f);
      if (hit && hit.mtime === mtime) { vals.push(...hit.vals); continue; }
      const mine: string[] = [];
      for (const l of readFileSync(f, 'utf8').split('\n')) {
        const m = /^\s*(?:export\s+)?[\w.]+\s*=\s*(.*)$/.exec(l);
        const v = m?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
        if (v && v.length >= 8) mine.push(v);
      }
      cache.set(f, { mtime, vals: mine }); vals.push(...mine);
    } catch { /* unreadable .env: nothing to match */ }
  }
  return vals;
}

/** Every string in an event, at any depth, redacted. */
export function redactDeep<T>(x: T, env: string[]): T {
  if (typeof x === 'string') return redact(x, env) as T;
  if (Array.isArray(x)) return x.map((y) => redactDeep(y, env)) as T;
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, redactDeep(v, env)])) as T;
  return x;
}

export const TURN_CAP = 4000;
export function turnEvent(from: string, text: string, tools?: Record<string, number>, env: string[] = []) {
  const clean = redact(text, env);
  return { type: 'turn' as const, from, text: clean.slice(0, TURN_CAP), ...(clean.length > TURN_CAP ? { cut: true as const } : {}), ...(tools ? { tools } : {}) };
}
