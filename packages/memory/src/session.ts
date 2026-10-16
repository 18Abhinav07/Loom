import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { appendEvent } from './events.js';
import { git, gitTry } from './git.js';
import { ulid } from './ids.js';
import { sync } from './sync.js';

export interface ActiveSession { sid: string; writer: string; by: string; task: string | null; claude?: string | null }
/** Per worktree: git-dir (not common dir), so two worktrees never share an active session (ruling 6);
 *  and per Claude session id inside it, so the lead and a second terminal in one checkout never share one (B3). */
const activeDir = (root: string) => join(git(root, 'rev-parse', '--path-format=absolute', '--git-dir'), 'loom', 'sessions');
const key = (claudeSid?: string | null) => (claudeSid || 'default').replace(/[^\w.-]/g, '_');
const activePath = (root: string, claudeSid?: string | null) => join(activeDir(root), `${key(claudeSid)}.json`);
export function writeActive(root: string, a: ActiveSession, claudeSid?: string | null) {
  const p = activePath(root, claudeSid); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(a));
}
/** The session for this Claude sid. Without one (git hooks, the CLI): `default`, else the most recently started session. */
export function activeSession(root: string, claudeSid?: string | null): ActiveSession | null {
  const p = activePath(root, claudeSid);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  if (claudeSid) return null;
  const d = activeDir(root);
  if (!existsSync(d)) return null;
  const latest = readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => join(d, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return latest ? JSON.parse(readFileSync(latest, 'utf8')) : null;
}
export const readActive = activeSession;
export function clearActive(root: string, claudeSid?: string | null) { rmSync(activePath(root, claudeSid), { force: true }); }

export interface SessionOpts { person: string; kind: 'interactive' | 'run'; writer?: 'lead' | 'main' | string; model?: string;
  claudeSid?: string | null; surface?: 'terminal' | 'dashboard' | 'headless'; parent?: string | null; team?: string | null; plan?: string | null; task?: string | null }
export async function startSession(g: LoomGraph, root: string, o: SessionOpts) {
  const sid = ulid(); const writer = o.writer ?? 'main';
  appendEvent(root, sid, writer, { type: 'session', person: o.person, kind: o.kind, base: gitTry(root, 'rev-parse', 'HEAD'), upstream: null,
    surface: o.surface ?? null, claude: o.claudeSid ?? null, parent: o.parent ?? null, team: o.team ?? null, plan: o.plan ?? null, task: o.task ?? null });
  appendEvent(root, sid, writer, { type: 'agent', name: writer, model: o.model ?? null });
  writeActive(root, { sid, writer, by: writer, task: o.task ?? null, claude: o.claudeSid ?? null }, o.claudeSid);
  const { briefing } = await sync(g, root, { me: o.person, fetch: true, quiet: true });
  return { sid, briefing };
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
  const act = o.claudeSid ? activeSession(root, o.claudeSid) : activeSession(root, null);
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
