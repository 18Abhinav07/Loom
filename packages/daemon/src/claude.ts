import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { EditIntent } from './predict.js';

export interface ClaudeHookInput {
  hook_event_name: string;
  cwd: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  prompt?: string;
}

export type Intent =
  | { kind: 'read'; file: string; start?: number; end?: number }
  | { kind: 'edit'; file: string }
  | { kind: 'bash'; command: string }
  | { kind: 'other' };

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Resolve symlinks (macOS /var → /private/var); a file not yet written resolves through its directory. */
const real = (p: string): string => {
  try { return realpathSync(p); } catch { return dirname(p) === p ? p : join(real(dirname(p)), basename(p)); }
};

export function relIn(root: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : `${root}/${p}`;
  const inside = (r: string) => (r.startsWith('..') || isAbsolute(r) ? null : r);
  return inside(relative(root, abs)) ?? inside(relative(real(root), real(abs)));
}

export function parsePostToolUse(input: ClaudeHookInput, root: string): Intent {
  const ti = input.tool_input ?? {};
  const tool = input.tool_name ?? '';
  if (tool === 'Read' && typeof ti.file_path === 'string') {
    const file = relIn(root, ti.file_path);
    if (!file) return { kind: 'other' };
    const offset = typeof ti.offset === 'number' ? ti.offset : undefined;
    const limit = typeof ti.limit === 'number' ? ti.limit : undefined;
    return { kind: 'read', file, start: offset, end: offset !== undefined && limit !== undefined ? offset + limit - 1 : undefined };
  }
  if (EDIT_TOOLS.has(tool) && typeof ti.file_path === 'string') {
    const file = relIn(root, ti.file_path);
    return file ? { kind: 'edit', file } : { kind: 'other' };
  }
  if (tool === 'Bash' && typeof ti.command === 'string') return { kind: 'bash', command: ti.command };
  return { kind: 'other' };
}

export const contextJson = (event: string, text: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

export const stopBlockJson = (text: string) =>
  JSON.stringify({ decision: 'block', reason: `${text}\n\nAddress the change above, then finish.` });

export function parsePreToolUse(input: ClaudeHookInput, root: string): EditIntent | null {
  const ti = input.tool_input ?? {};
  const file = typeof ti.file_path === 'string' ? relIn(root, ti.file_path) : null;
  if (!file) return null;
  if (input.tool_name === 'Write' && typeof ti.content === 'string') return { file, content: ti.content };
  if (input.tool_name === 'Edit') return { file, edits: [{ old: String(ti.old_string ?? ''), new: String(ti.new_string ?? ''), all: Boolean(ti.replace_all) }] };
  if (input.tool_name === 'MultiEdit' && Array.isArray(ti.edits)) {
    return { file, edits: (ti.edits as Record<string, unknown>[]).map((e) => ({ old: String(e.old_string ?? ''), new: String(e.new_string ?? ''), all: Boolean(e.replace_all) })) };
  }
  return null;
}

export const denyJson = (reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
