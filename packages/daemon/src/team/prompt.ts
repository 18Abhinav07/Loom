// What a team agent is told and may run. The CLI's v1 `loom run` re-exports these.
export const SUFFIX = "\n\nYou are one of several agents working in parallel on this repo, coordinated by Loom. [loom] notices about other "
  + "agents' changes arrive on their own in your context and clear once your code fits them; you need no tool call to fetch or "
  + 'acknowledge them. If Loom denies an edit, follow its message. Do not commit; Loom commits your work when you finish.';
// Blind agents still know they are not alone; they just have no channel to the others.
export const SUFFIX_BLIND = "\n\nYou are one of several agents working in parallel on this repo; other agents may be changing shared code at the "
  + 'same time, and all changes will be merged together when everyone finishes. Do not commit; your work is committed when you finish.';
export const SUFFIX_TEAM = SUFFIX.replace('Loom commits your work when you finish.',
  'Loom commits your work and lands it on the shared branch when you finish; if it cannot land, you are told the reason.');
const TOOLS = ['Edit', 'Write', 'MultiEdit', 'Read', 'Grep', 'Glob', 'Bash(git:*)', 'Bash(python:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'mcp__loom__*'];
/** The command word of a shell line: the first token that is not a VAR=value assignment. */
const word = (cmd: string) => cmd.trim().split(/\s+/).find((t) => !/^\w+=/.test(t));
/** What a worker may run: the base tools plus the plan's test and compile commands. Blind workers get no Loom tools. */
export function allowedTools(o: { test?: string | null; compile?: string | null; blind?: boolean }): string[] {
  const extra = [o.test, o.compile].map((c) => (c ? word(c) : undefined)).filter((w): w is string => !!w).map((w) => `Bash(${w}:*)`);
  return [...new Set([...TOOLS, ...extra])].filter((t) => !(o.blind && t.startsWith('mcp__')));
}
/** A worker waiting along a chain of holders (A, then B, then C) is resumed once per landing. */
export const MAX_RESUMES = 3;

const LIMIT = /usage limit|hit your limit|limit reached/i;
/** True for a stream-json error line saying the usage limit was hit. A normal answer that mentions limits does not count. */
export function usageLimited(line: string): boolean {
  let j: any;
  try { j = JSON.parse(line); } catch { return false; }
  if (j?.type === 'result' && j.is_error === true) return LIMIT.test(String(j.result ?? ''));
  if (j?.type === 'assistant' && j.error) return LIMIT.test(JSON.stringify(j.message?.content ?? ''));
  return false;
}
