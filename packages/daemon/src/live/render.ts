// Notice and denial texts for the live layer. Built at delivery from the graph as it is then (RC3): nothing here is stored before it is read.

export interface DenyRow { holder: string; qname: string; mode: string; task: string | null; ageMs: number | null; medianMs: number | null }
export interface ChangeView { author: string; qname: string; path: string; kind: string; before: string | null; after: string | null; diff?: string; holder: string | null }

const dur = (ms: number | null) => ms === null ? 'unknown' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;

export function renderDeny(rows: DenyRow[]): string {
  const out = ['[loom] edit blocked before it happened:'];
  for (const r of rows) {
    out.push(`  ${r.qname} is leased by agent ${r.holder} (${r.mode}${r.task ? `, task ${r.task}` : ''}), held ${dur(r.ageMs)}; ` +
      `finished tasks here take a median of ${dur(r.medianMs)}.`);
  }
  out.push(`  Work on something else first; Loom wakes you when ${rows[0]?.holder ?? 'the holder'} lands it or the lease lapses.`);
  return out.join('\n');
}

export const renderBackoff = (qname: string, holder: string) =>
  `[loom] stop editing ${qname}; you will be woken when agent ${holder} lands it or its lease lapses. Do other work or finish now.`;
export const renderGate = (qname: string) => `[loom] wait for the wake on ${qname}.`;

export function renderStale(summaries: Array<{ summary: string; notice: string }>): string {
  return summaries.map((s) => `[loom] ${s.summary}\n  pull, or call ack_notice ${s.notice} to proceed.`).join('\n');
}
export function renderStaleRun(rows: Array<{ summary: string; qname: string }>): string {
  return rows.map((r) => `[loom] ${r.summary}; your file now contains it, re-read ${r.qname}.`).join('\n');
}

export function renderChange(c: ChangeView, unleased: boolean): string {
  const out = [unleased
    ? `[loom] agent ${c.author} wrote ${c.qname} in ${c.path} without a lease (${c.kind}, not in your checkout yet)`
    : `[loom] agent ${c.author} changed ${c.qname} in ${c.path} (${c.kind}, in progress, not in your checkout yet)`];
  if (c.kind === 'removed') out.push(`  removed: ${c.before ?? c.qname}`);
  else out.push(`  before: ${c.before ?? '(new)'}`, `  after:  ${c.after ?? '(unparsed)'}`);
  if (c.diff) out.push('  what changed inside it (the signature above does not show this; a return value or type may differ):', ...c.diff.split('\n').map((l) => `    ${l}`));
  if (c.holder) out.push(`  current lease holder: agent ${c.holder}`);
  out.push(c.kind === 'body' ? '  Both changes will be merged: make your code work with the AFTER version.' : SECOND);
  return out.join('\n');
}

// The AFTER signature does not exist in the reader's checkout yet; calling it there would break the reader's own landing.
const SECOND = '  Keep your code valid against your checkout. Whichever of you lands second is handed every call that no longer fits, and fixes it.';

export function renderContractUse(c: { author: string; qname: string; path: string; before: string | null; after: string | null }): string {
  return [`[loom] you now call ${c.qname} (${c.path}), whose signature agent ${c.author} is changing (in progress, not in your checkout yet)`,
    `  before: ${c.before ?? c.qname}`, `  after:  ${c.after ?? '(unparsed)'}`, SECOND].join('\n');
}

export function renderNewCaller(author: string, qname: string, callers: string[]): string {
  return [`[loom] agent ${author} added calls to ${qname}, whose signature you are changing: ${callers.join(', ')} (in their checkout, not in yours yet)`,
    '  If you land after them, Loom hands you each of these calls that does not fit your signature; if they land after you, they fix them.'].join('\n');
}

export function renderConflict(regions: string[]): string {
  return [`[loom] syncing the landed work left a conflict in ${regions.join(', ')}; resolve the markers, then continue.`,
    ...regions.map((r) => `  conflict in ${r}`)].join('\n');
}

export function renderLessons(rows: Array<{ text: string; region: string }>): string {
  return ['[loom] lessons on the code you are about to edit:', ...rows.map((r) => `  - ${r.region.split('::')[1] ?? r.region}: ${r.text}`)].join('\n');
}
