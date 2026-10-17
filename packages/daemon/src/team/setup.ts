// Repo and worktree setup shared by `loom init` and the team scheduler.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SKIP = new Set(['node_modules', 'venv', '.venv']);
// Bash is in the PreToolUse matcher: an agent named it as the way round an Edit deny (S-22). The pre-commit hook stays the hard check.
// UserPromptSubmit and Stop stay while the v1 run mode serves them (server.ts onHook).
const EVENTS: [string, string | undefined][] = [['SessionStart', undefined], ['UserPromptSubmit', undefined],
  ['PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit|Bash'], ['PostToolUse', '*'], ['Stop', undefined], ['SessionEnd', undefined]];

function hasPy(d: string): boolean {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    if (e.isFile() && e.name.endsWith('.py')) return true;
    if (e.isDirectory() && hasPy(join(d, e.name))) return true;
  }
  return false;
}

/** Top-level dirs that hold Python: the base a run indexes. */
export function pyDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name) && hasPy(join(root, e.name))).map((e) => e.name).sort();
}

/** Append lines to the repo's .git/info/exclude once each. */
export function exclude(mainRoot: string, lines: string[]) {
  const ex = join(mainRoot, '.git', 'info', 'exclude');
  mkdirSync(dirname(ex), { recursive: true });
  const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
  for (const line of lines)
    if (!cur.split('\n').includes(line)) appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/** The Claude hooks, merged into a settings file next to whatever hooks it already has. */
export function mergeHooks(sp: string, hookCmd: string) {
  const s = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')) : {};
  s.hooks ??= {};
  for (const [ev, matcher] of EVENTS) {
    const list: { matcher?: string; hooks: { command?: string }[] }[] = (s.hooks[ev] ??= []);
    const ours = (h: { hooks: { command?: string }[] }) => h.hooks?.some((x) => x.command?.includes('loom-hook'));
    const want = `${hookCmd} claude ${ev}`;
    if (list.some((h) => h.hooks?.some((x) => x.command === want))) continue;
    for (let i = list.length - 1; i >= 0; i--) if (ours(list[i])) list.splice(i, 1);   // a stale loom-hook (old install path) is replaced, not kept beside the new one
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `${hookCmd} claude ${ev}`, timeout: 30 } as never] });
  }
  mkdirSync(dirname(sp), { recursive: true });
  writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
}
