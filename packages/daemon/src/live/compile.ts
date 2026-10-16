// B2: typed languages are checked by their own compiler at landing. Only errors the landed base did not already have count,
// so a repo that never compiled clean can still land work that does not make it worse.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEEP = /error|vet:|cannot|undefined/i;
/** One error per line, with line and column positions removed so a moved error still matches. */
export function compileErrors(cmd: string, cwd: string): { ok: boolean; errors: string[] } {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900_000 });
  const errors = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n')
    .map((l) => l.replace(/\(\d+,\d+\)/g, '').replace(/:\d+(:\d+)?/g, '').trim()).filter((l) => KEEP.test(l));
  return { ok: r.status === 0, errors };
}

/** head minus base, counting repeats: two copies of an error the base had once is one new error. */
export function newErrors(base: string[], head: string[]): string[] {
  const left = new Map<string, number>();
  for (const e of base) left.set(e, (left.get(e) ?? 0) + 1);
  return head.filter((e) => { const n = left.get(e) ?? 0; if (n > 0) { left.set(e, n - 1); return false; } return true; });
}

const baseCache = new Map<string, string[]>();
/** The errors at a landed sha, compiled once in a throwaway checkout and remembered. */
export function baseErrors(cmd: string, repo: string, sha: string): string[] {
  const key = `${cmd}\0${sha}`;
  const hit = baseCache.get(key);
  if (hit) return hit;
  const d = mkdtempSync(join(tmpdir(), 'loom-base-'));
  try {
    spawnSync('git', ['worktree', 'add', '-q', '--detach', d, sha], { cwd: repo });
    const e = compileErrors(cmd, d).errors;
    baseCache.set(key, e);
    return e;
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', d], { cwd: repo });
    rmSync(d, { recursive: true, force: true });
  }
}
