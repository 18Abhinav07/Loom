// What `loom init` learns about a repo: its languages, its compiler, and the top-level dirs that hold source.
import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const LANG: Record<string, string> = {
  '.py': 'python', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.md': 'md', '.json': 'json',
};
const SOURCE = new Set(['python', 'ts', 'tsx', 'js', 'go', 'rust', 'java']);
const SKIP = new Set(['node_modules', '.venv', 'venv', 'dist', 'build', 'target', 'vendor']);

/** Tracked files counted by language; files of other types are left out. */
export function detectLangs(files: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) { const l = LANG[extname(f).toLowerCase()]; if (l) out[l] = (out[l] ?? 0) + 1; }
  return out;
}

/** The command that type-checks the repo, or null when it has no compiled language Loom knows. */
export function detectCompile(root: string, langs: Record<string, number>): string | null {
  const has = (f: string) => existsSync(join(root, f));
  if (has('tsconfig.json') && ((langs.ts ?? 0) + (langs.tsx ?? 0)) > 0) return 'npx tsc --noEmit -p .';
  if (has('go.mod')) return 'go vet ./...';
  if (has('Cargo.toml')) return 'cargo check -q';
  if (has('pom.xml')) return 'mvn -q compile';
  if (readdirSync(root).some((f) => f.startsWith('build.gradle'))) return 'gradle -q compileJava';
  return null;
}

/** Top-level dirs holding source in any language; ['.'] when source sits at the root or nothing qualifies. */
export function sourceDirs(_root: string, files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    if (!SOURCE.has(LANG[extname(f).toLowerCase()] ?? '')) continue;
    const i = f.indexOf('/');
    if (i < 0) return ['.'];
    const d = f.slice(0, i);
    if (!d.startsWith('.') && !SKIP.has(d)) dirs.add(d);
  }
  return dirs.size ? [...dirs].sort() : ['.'];
}
