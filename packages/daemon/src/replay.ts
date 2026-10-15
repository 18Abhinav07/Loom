// Spec §3.4 replay: re-send a recorded events.jsonl into a fresh run graph through the daemon's own routes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface Ev { t: number; route: string; body: any }
export interface ReplayMeta { repo?: string; commit?: string; dirs?: string[]; root?: string }
export interface ReplayProgress { run: string; total: number; sent: number; failed: string[]; done: boolean }

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=loom@replay', '-c', 'user.name=loom', ...a], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/** What an edit did to `files`, as a diff against HEAD (new files diff against /dev/null): recorded so a replay can redo Bash edits. */
export function filePatch(root: string, files: string[]): string {
  let out = '';
  for (const f of files) {
    let tracked = true;
    try { git(root, 'ls-files', '--error-unmatch', '--', f); } catch { tracked = false; }
    try { out += tracked ? git(root, 'diff', 'HEAD', '--', f) : git(root, 'diff', '--no-index', '--', '/dev/null', f); }
    catch (e: any) { out += String(e.stdout ?? ''); }   // --no-index exits 1 when the files differ
  }
  return out;
}

/** Put `files` back to HEAD (untracked ones removed), then apply the recorded patch. */
export function applyPatch(root: string, files: string[], patch: string) {
  for (const f of files) {
    try { git(root, 'checkout', 'HEAD', '--', f); } catch { rmSync(join(root, f), { force: true }); }
  }
  if (patch.trim()) execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: root, input: patch });
}

/** Older recordings carry no patch: redo Edit / MultiEdit / Write from the tool's own strings. */
function applyToolInput(tool: string, ti: any) {
  const p = String(ti.file_path);
  mkdirSync(dirname(p), { recursive: true });
  if (tool === 'Write') { writeFileSync(p, String(ti.content ?? '')); return; }
  let s = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const edits = tool === 'MultiEdit' ? ti.edits ?? [] : [ti];
  for (const e of edits) s = e.replace_all ? s.split(e.old_string).join(e.new_string) : s.replace(e.old_string, () => e.new_string);
  writeFileSync(p, s);
}

/** The base tree the recording ran against: a pinned tarball in the recording, else the recorded repo at the recorded commit. */
function checkoutBase(dir: string, meta: ReplayMeta, into: string): string {
  const base = join(into, 'base');
  if (existsSync(join(dir, 'repo.tar.gz'))) {
    execFileSync('mkdir', ['-p', base]);
    execFileSync('tar', ['-xzf', join(dir, 'repo.tar.gz'), '-C', base]);
    git(base, 'init', '-q'); git(base, 'add', '-A'); git(base, 'commit', '-qm', 'replay base');
  } else {
    if (!meta.repo) throw new Error('recording has neither repo.tar.gz nor a repo to check out');
    git(into, 'clone', '-q', '--shared', '--no-checkout', meta.repo, base);
    git(base, 'checkout', '-q', '--detach', meta.commit ?? 'HEAD');
  }
  return base;
}

export function readRecording(dir: string): { events: Ev[]; meta: ReplayMeta } {
  const events: Ev[] = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta: ReplayMeta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {};
  const adm = events.find((e) => e.route === '/admin/runs')?.body;
  meta.root ??= adm?.root;
  meta.dirs ??= adm?.dirs;
  if (!meta.repo && meta.root) { meta.repo = meta.root; meta.commit ??= git(meta.root, 'rev-parse', 'HEAD').trim(); }
  return { events, meta };
}

/**
 * Drive one recording into `run`: base checkout, one detached worktree per agent, every recorded path rewritten to
 * its replay twin, edits redone on disk just before the PostToolUse that reports them. `send` is the daemon's own HTTP.
 */
export async function replay(dir: string, run: string, send: (route: string, body: unknown, headers?: Record<string, string>) => Promise<void>,
  opts: { speed?: number; maxGapMs?: number; progress?: ReplayProgress } = {}): Promise<ReplayProgress> {
  const { events, meta } = readRecording(dir);
  const p = opts.progress ?? { run, total: events.length, sent: 0, failed: [], done: false };
  p.total = events.length;
  const into = mkdtempSync(join(tmpdir(), 'loom-replay-'));
  const base = checkoutBase(dir, meta, into);
  const origRun = String(events.find((e) => e.body?.run)?.body.run ?? '');

  // agent -> recorded root: registered worktree, else the cwd of its first hook
  const roots = new Map<string, string>();
  for (const e of events) {
    if (e.route === '/admin/agents') roots.set(e.body.agent, e.body.worktree);
    else if (e.route.startsWith('/hook/') && e.body.input?.cwd && !roots.has(e.body.agent)) roots.set(e.body.agent, e.body.input.cwd);
  }
  const map: [string, string][] = [];
  const wt = new Map<string, string>();
  for (const [agent, orig] of roots) {
    const w = orig === meta.root ? base : join(into, 'wt', agent.replace(/[^\w.-]/g, '_'));
    if (w !== base) git(base, 'worktree', 'add', '-q', '--detach', w);
    wt.set(agent, w); map.push([orig, w]);
  }
  if (meta.root) map.push([meta.root, base]);
  map.sort((a, b) => b[0].length - a[0].length);   // a worktree under the main root rewrites before the root does
  const rewrite = (v: unknown): any => {
    let s = JSON.stringify(v);
    for (const [o, n] of map) s = s.split(o).join(n);
    if (origRun) s = s.split(origRun).join(run);
    return JSON.parse(s);
  };

  if (!events.some((e) => e.route === '/admin/runs')) {   // attach recording: the run was created by its first hook
    await send('/admin/runs', { run, root: base, dirs: meta.dirs ?? ['.'], baseKey: run, lessons: false });
    for (const [agent, w] of wt) await send('/admin/agents', { run, agent, harness: 'claude', worktree: w });
  }
  const speed = opts.speed ?? 4;
  let prev = 0;
  for (const e of events) {
    const gap = speed > 0 ? Math.min((e.t - prev) / speed, opts.maxGapMs ?? 3000) : 0;
    prev = e.t;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    try {
      const b = rewrite(e.body);
      if (e.route.startsWith('/admin/')) {
        if (e.route === '/admin/runs') { b.run = run; b.baseKey = run; b.lessons = false; }   // replay output must not depend on global lessons
        await send(e.route, { ...b, run });
      } else if (e.route.startsWith('/hook/')) {
        const w = wt.get(b.agent) ?? base;
        if (e.route.endsWith('/PostToolUse')) {
          if (b.patch !== undefined) applyPatch(w, b.patchFiles ?? [], b.patch);
          else if (['Edit', 'MultiEdit', 'Write'].includes(b.input.tool_name) && b.input.tool_input?.file_path) applyToolInput(b.input.tool_name, b.input.tool_input);
        }
        await send(e.route, { ...b.input, cwd: w }, { 'x-loom-run': run, 'x-loom-agent': b.agent });
      } else if (e.route.startsWith('/mcp/')) {
        await send(e.route, { args: b.args ?? {}, cwd: wt.get(b.agent) ?? base }, { 'x-loom-run': run, 'x-loom-agent': b.agent });
      }
    } catch (err) { p.failed.push(`${e.route}: ${String((err as Error).message ?? err)}`); }
    p.sent++;
  }
  p.done = true;
  return p;
}
