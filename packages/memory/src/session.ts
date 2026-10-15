import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { appendEvent } from './events.js';
import { git, gitTry } from './git.js';
import { ulid } from './ids.js';
import { sync } from './sync.js';

export interface ActiveSession { sid: string; writer: string; by: string; task: string | null }
/** Per worktree: git-dir (not common dir), so two worktrees never share an active session (ruling 6). */
const activePath = (root: string) => join(git(root, 'rev-parse', '--path-format=absolute', '--git-dir'), 'loom', 'session.json');
export function writeActive(root: string, a: ActiveSession) { const p = activePath(root); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(a)); }
export function readActive(root: string): ActiveSession | null { const p = activePath(root); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; }
export function clearActive(root: string) { rmSync(activePath(root), { force: true }); }

export async function startSession(g: LoomGraph, root: string, o: { person: string; kind: 'interactive' | 'run'; writer?: string; model?: string }) {
  const sid = ulid(); const writer = o.writer ?? 'main';
  appendEvent(root, sid, writer, { type: 'session', person: o.person, kind: o.kind, base: gitTry(root, 'rev-parse', 'HEAD'), upstream: null });
  appendEvent(root, sid, writer, { type: 'agent', name: writer, model: o.model ?? null });
  writeActive(root, { sid, writer, by: writer, task: null });
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
export async function finishSession(g: LoomGraph, root: string, o: { transcriptPath?: string; commit?: boolean }) {
  const act = readActive(root);
  let handoff = '';
  if (act) {
    const open = await g.query<{ id: string }>(`MATCH (t:Task) WHERE t.claimed_by STARTS WITH $sid AND t.status IN ['open','claimed'] RETURN t.id AS id`, { sid: act.sid });
    handoff = appendEvent(root, act.sid, act.writer, { type: 'handoff', summary: lastAssistant(o.transcriptPath), open_tasks: open.map((t) => t.id), open_leases: [] }).id;
    clearActive(root);
  }
  const dirty = () => !!gitTry(root, 'status', '--porcelain', '-uall', '--', '.loom/');
  if (o.commit && dirty()) {
    const sid = act?.sid ?? /sessions\/(\w+)\./.exec(gitTry(root, 'status', '--porcelain', '-uall', '--', '.loom/sessions') ?? '')?.[1] ?? 'unknown';
    gitTry(root, 'add', '--', '.loom'); gitTry(root, 'commit', '-q', '--no-verify', '-m', `loom: session ${sid} records`, '--', '.loom');
  } else if (dirty()) process.stderr.write('[loom] session records not committed: `loom finish --commit` commits only .loom/\n');
  return { handoff, uncommitted: dirty() };
}
