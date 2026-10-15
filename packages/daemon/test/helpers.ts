import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });

/** A committed git repo holding `files` (path -> content). */
export function gitTree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-'));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), t); }
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base', '--allow-empty');
  return d;
}

/** A throwaway directory for the daemon's events.jsonl recording. */
export const tmpRecord = () => mkdtempSync(join(tmpdir(), 'loom-rec-'));
