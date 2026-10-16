import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './git.js';

export interface LoomConfig { repoId: string; dirs: string[]; excludes: string[]; testCmd: string | null; share: boolean;
  /** v2 (B1): the tracked-file count per language, and the repo's type-check command. */
  v?: 2; langs?: Record<string, number>; compile?: string | null }
export const DEFAULT_EXCLUDES = ['node_modules', '.venv', 'dist', 'build', '.git'];
const ATTRS = 'sessions/*.jsonl merge=union\nregions.lock merge=union\n';

export function readConfig(root: string): LoomConfig | null {
  const p = join(root, '.loom', 'config.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Common dir's info/exclude: shared by every worktree of the clone. */
export function exclude(root: string, line: string) {
  const ex = join(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'exclude');
  mkdirSync(dirname(ex), { recursive: true });
  const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
  if (!cur.split('\n').includes(line)) appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/** Creates `.loom/` once; an existing config is never rewritten (repoId is fixed at first init, §4.1). */
export function ensureLoomDir(root: string, cfg: LoomConfig): LoomConfig {
  mkdirSync(join(root, '.loom', 'sessions'), { recursive: true });
  const cur = readConfig(root) ?? (writeFileSync(join(root, '.loom', 'config.json'), JSON.stringify(cfg, null, 2) + '\n'), cfg);
  writeFileSync(join(root, '.loom', '.gitattributes'), ATTRS);
  if (!cur.share) exclude(root, '.loom/sessions/');
  return cur;
}
