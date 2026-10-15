import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LoomDb, type LoomGraph } from '@loom/core';
import { ulid } from '../src/ids.js';

export const sh = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@t', '-c', 'user.name=A', ...a], { cwd, encoding: 'utf8' }).trim();
export const as = (who: string) => (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', `user.email=${who}@t`, '-c', `user.name=${who}`, ...a], { cwd, encoding: 'utf8' }).trim();
export function write(root: string, files: Record<string, string>) {
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(root, dirname(f)), { recursive: true }); writeFileSync(join(root, f), t); }
}
/** A git repo on `main` with one commit holding `files`. */
export function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-mem-'));
  write(d, files); sh(d, 'init', '-q', '-b', 'main'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'base', '--allow-empty');
  return d;
}
/** origin (bare) + two clones a, b — the X2 shape. */
export function pair(files: Record<string, string>) {
  const src = repo(files); const origin = `${src}.git`;
  sh(src, 'clone', '-q', '--bare', src, origin);
  const a = `${src}-a`, b = `${src}-b`;
  sh(src, 'clone', '-q', origin, a); sh(src, 'clone', '-q', origin, b);
  return { origin, a, b };
}
let db: LoomDb | null = null;
export async function testGraph(): Promise<LoomGraph> { db ??= await LoomDb.connect(); return db.graph(`loom:test:${ulid()}`); }
export async function closeDb() { await db?.close(); db = null; }
