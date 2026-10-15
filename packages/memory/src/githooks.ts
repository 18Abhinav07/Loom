import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { git, gitTry } from './git.js';

export const GIT_HOOKS = ['pre-commit', 'post-commit', 'post-merge', 'post-checkout', 'post-rewrite'] as const;
const MARK = '# loom-hook v1';

/** The user's hook runs first and keeps its exit status; loom runs after it and never fails the hook (fail-open, R17). */
const script = (name: string, loom: string) => `#!/bin/sh
${MARK}
in=$(cat 2>/dev/null)
if [ -x "$0.pre-loom" ]; then printf '%s' "$in" | "$0.pre-loom" "$@" || exit $?; fi
printf '%s' "$in" | ${loom} hook git ${name} "$@" >&2 || echo "[loom] ${name} hook failed; continuing" >&2
exit 0
`;

/** `loomCmd` is a shell command prefix (e.g. `node /abs/loom.cjs`), inserted unquoted. */
export function installGitHooks(root: string, loomCmd: string): { dir: string; chained: string[] } {
  const hp = gitTry(root, 'config', 'core.hooksPath');
  const dir = hp ? (isAbsolute(hp) ? hp : join(root, hp)) : join(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'hooks');
  mkdirSync(dir, { recursive: true });
  const chained: string[] = [];
  for (const h of GIT_HOOKS) {
    const p = join(dir, h);
    if (existsSync(p) && readFileSync(p, 'utf8').includes(MARK)) continue;
    if (existsSync(p)) { renameSync(p, `${p}.pre-loom`); chained.push(h); }
    writeFileSync(p, script(h, loomCmd)); chmodSync(p, 0o755);
  }
  return { dir, chained };
}
