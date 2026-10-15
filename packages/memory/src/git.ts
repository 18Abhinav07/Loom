import { execFileSync, spawnSync } from 'node:child_process';

export const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 }).replace(/\n$/, '');
export function gitTry(cwd: string, ...a: string[]): string | null { try { return git(cwd, ...a); } catch { return null; } }

const anc = new Map<string, boolean>();
const SHA = /^[0-9a-f]{40}$/;
/** `a` is an ancestor of (or equal to) `b`. Cached by sha only: commits are immutable, refs (HEAD, origin/main) move. */
export function isAncestor(root: string, a: string, b: string): boolean {
  const sa = SHA.test(a) ? a : gitTry(root, 'rev-parse', '--verify', '-q', `${a}^{commit}`);
  const sb = SHA.test(b) ? b : gitTry(root, 'rev-parse', '--verify', '-q', `${b}^{commit}`);
  if (!sa || !sb) return false;
  a = sa; b = sb;
  const k = `${a}>${b}`;
  if (!anc.has(k)) anc.set(k, spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root }).status === 0);
  return anc.get(k)!;
}

const ZERO = /^0{40}$/;
/** One blame call per file: each line with the commit that introduced it (null = not committed). */
export function blame(root: string, file: string, ref: string | null): Array<{ commit: string | null; text: string }> {
  const out = git(root, 'blame', '--line-porcelain', ...(ref ? [ref] : []), '--', file);
  const rows: Array<{ commit: string | null; text: string }> = [];
  let sha = '';
  for (const l of out.split('\n')) {
    if (l.startsWith('\t')) rows.push({ commit: ZERO.test(sha) ? null : sha, text: l.slice(1) });
    else if (/^[0-9a-f]{40} \d+ \d+/.test(l)) sha = l.slice(0, 40);
  }
  return rows;
}

/** `git show <spec>` with the bytes untouched (git() trims the final newline, which changes hashes and blob shas); null if absent. */
export function showRaw(cwd: string, spec: string): string | null {
  const r = spawnSync('git', ['show', spec], { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : null;
}
