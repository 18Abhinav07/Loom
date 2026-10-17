import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { appendEvent } from './events.js';
import { git, gitTry } from './git.js';
import { leadBriefing } from './plandocs.js';
import { ulid } from './ids.js';
import { sync } from './sync.js';

export interface ActiveSession { sid: string; writer: string; by: string; task: string | null; claude?: string | null;
  /** The SessionStart hook's ancestor pids (its claude process first): how a git hook finds the session it runs under. */ pids?: number[] }
/** Per worktree: git-dir (not common dir), so two worktrees never share an active session (ruling 6);
 *  and per Claude session id inside it, so the lead and a second terminal in one checkout never share one (B3). */
const activeDir = (root: string) => join(git(root, 'rev-parse', '--path-format=absolute', '--git-dir'), 'loom', 'sessions');
const key = (claudeSid?: string | null) => (claudeSid || 'default').replace(/[^\w.-]/g, '_');
const activePath = (root: string, claudeSid?: string | null) => join(activeDir(root), `${key(claudeSid)}.json`);
export function writeActive(root: string, a: ActiveSession, claudeSid?: string | null) {
  const p = activePath(root, claudeSid); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(a));
}
/** This process and its ancestors, nearest first, up to 8 levels. */
export function ancestors(): number[] {
  const out: number[] = [process.pid]; let p = process.ppid;
  for (let i = 0; i < 8 && p > 1; i++) {
    out.push(p);
    try { p = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8', timeout: 500 }).trim()); } catch { break; }
  }
  return out;
}

/** The session for this Claude sid. Without one (git hooks, the CLI): the session whose recorded pids hold the nearest of
 *  `anc` (two terminals share only far ancestors such as the terminal app), else `default`, else the most recently started. */
export function activeSession(root: string, claudeSid?: string | null, anc?: number[]): ActiveSession | null {
  const p = activePath(root, claudeSid);
  if (!anc && existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  if (claudeSid) return null;
  const d = activeDir(root);
  if (!existsSync(d)) return null;
  const all = readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => join(d, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .map((f) => { try { return JSON.parse(readFileSync(f, 'utf8')) as ActiveSession; } catch { return null; } }).filter((a): a is ActiveSession => !!a);
  for (const pid of anc ?? []) { const hit = all.find((a) => a.pids?.includes(pid)); if (hit) return hit; }
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  return all[0] ?? null;
}
export const readActive = activeSession;
export function clearActive(root: string, claudeSid?: string | null) { rmSync(activePath(root, claudeSid), { force: true }); }

export interface SessionOpts { person: string; kind: 'interactive' | 'run'; writer?: 'lead' | 'main' | string; model?: string;
  claudeSid?: string | null; pids?: number[]; surface?: 'terminal' | 'dashboard' | 'headless'; parent?: string | null; team?: string | null; plan?: string | null; task?: string | null }
export async function startSession(g: LoomGraph, root: string, o: SessionOpts) {
  const sid = ulid(); const writer = o.writer ?? 'main';
  appendEvent(root, sid, writer, { type: 'session', person: o.person, kind: o.kind, base: gitTry(root, 'rev-parse', 'HEAD'), upstream: null,
    surface: o.surface ?? null, claude: o.claudeSid ?? null, parent: o.parent ?? null, team: o.team ?? null, plan: o.plan ?? null, task: o.task ?? null });
  appendEvent(root, sid, writer, { type: 'agent', name: writer, model: o.model ?? null });
  writeActive(root, { sid, writer, by: writer, task: o.task ?? null, claude: o.claudeSid ?? null, ...(o.pids?.length ? { pids: o.pids } : {}) }, o.claudeSid);
  const { briefing } = await sync(g, root, { me: o.person, fetch: true, quiet: true });
  return { sid, briefing: writer === 'lead' ? `${briefing ? `${briefing}\n\n` : ''}${leadBriefing(root)}` : briefing };
}

/** Last assistant text in a Claude Code transcript (jsonl); '' when unreadable. */
function lastAssistant(path?: string): string {
  if (!path || !existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').trim().split('\n').reverse();
  for (const l of lines) {
    try {
      const m = JSON.parse(l); if (m.type !== 'assistant') continue;
      const t = (m.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
      if (t) return t.slice(0, 500);
    } catch { /* skip */ }
  }
  return '';
}

/** §6.2 step 6. `commit: true` makes a commit that touches only .loom/ (`git commit -- .loom` with the pathspec). */
export async function finishSession(g: LoomGraph, root: string, o: { transcriptPath?: string; commit?: boolean; claudeSid?: string | null }) {
  const act = o.claudeSid ? activeSession(root, o.claudeSid) : activeSession(root, null, ancestors());
  let handoff = '';
  if (act) {
    const open = await g.query<{ id: string }>(`MATCH (t:Task) WHERE t.claimed_by STARTS WITH $sid AND t.status IN ['open','claimed'] RETURN t.id AS id`, { sid: act.sid });
    handoff = appendEvent(root, act.sid, act.writer, { type: 'handoff', summary: lastAssistant(o.transcriptPath), open_tasks: open.map((t) => t.id), open_leases: [] }).id;
    clearActive(root, act.claude ?? o.claudeSid);
  }
  const dirty = () => !!gitTry(root, 'status', '--porcelain', '-uall', '--', '.loom/');
  if (o.commit && dirty()) {
    const sid = act?.sid ?? /sessions\/(\w+)\./.exec(gitTry(root, 'status', '--porcelain', '-uall', '--', '.loom/sessions') ?? '')?.[1] ?? 'unknown';
    gitTry(root, 'add', '--', '.loom'); gitTry(root, 'commit', '-q', '--no-verify', '-m', `loom: session ${sid} records`, '--', '.loom');
  } else if (dirty()) process.stderr.write('[loom] session records not committed: `loom finish --commit` commits only .loom/\n');
  return { handoff, uncommitted: dirty() };
}
