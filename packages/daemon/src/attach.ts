import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Attach mode: a plain `claude` session in an initialised repo (or any of its worktrees) joins that repo's run. */
export interface Attach { run: string; mainRoot: string; root: string; dirs: string[] }
const cache = new Map<string, Attach | null>();
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function resolveAttach(cwd: string): Attach | null {
  if (cache.has(cwd)) return cache.get(cwd)!;
  let out: Attach | null = null;
  try {
    const root = git(cwd, 'rev-parse', '--show-toplevel');
    const mainRoot = dirname(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    const p = join(mainRoot, '.loom', 'config.json');
    if (existsSync(p)) { const c = JSON.parse(readFileSync(p, 'utf8')); out = { run: c.run, mainRoot, root, dirs: c.dirs }; }
  } catch { out = null; }
  cache.set(cwd, out);
  return out;
}
