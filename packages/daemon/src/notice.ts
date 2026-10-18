import type { ChangeKind, ChangeRec } from '@loom/core';

export const REL: Record<string, number> = { EDITED: 1.0, LEASED: 0.9, READ: 0.8, SCOPE: 0.6 };
export const HOP = [1, 0.8, 0.5, 0.3];
export const KIND: Record<ChangeKind, number> = { removed: 1.0, contract: 0.9, behavior: 0.4, added: 0 };
export const THRESHOLD = 0.25;
export const MAX_PER_DELIVERY = 3;

export function score(rel: string, hops: number, kind: ChangeKind): number {
  return (REL[rel] ?? 0) * (HOP[hops] ?? 0) * KIND[kind];
}

export function renderNotice(from: string, ch: ChangeRec, via: { rel: string; hops: number; path: string[] }, example?: string): string {
  const s = ch.symbol;
  const out = [`[loom] agent ${from} changed ${s.qname} in ${s.file} (${ch.kind}, in progress, not in your checkout yet)`];
  if (ch.kind === 'removed') {
    out.push(`  removed: ${s.sig}`);
    if (ch.renamedTo) out.push(`  renamed to: ${ch.renamedTo.sig} (same body)`);
  } else {
    out.push(`  before: ${s.sig}`, `  after:  ${ch.after!.sig}`);
    // a contract change with the same header text (decorator moved, wrapper added) is only visible in the body
    if (ch.kind === 'behavior' || s.sig === ch.after!.sig) out.push('  body change:', ...ch.bodyDiff.map((l) => `    ${l}`));
  }
  if (example) out.push(`  ${from} now calls it as: ${example}`);
  for (const r of ch.related) out.push('  new in the same change:', ...r.split('\n').map((l) => `    ${l}`));
  out.push(via.hops === 0
    ? `  you ${via.rel === 'READ' ? 'read' : via.rel === 'LEASED' ? 'hold a lease on' : 'edited'} it directly`
    : `  you depend on it: ${via.path.join(' → ')}`);
  out.push('  Both changes will be merged: make your code work with the AFTER version.',
    '  Change your code now to fit it (a different return type or value breaks callers that expect the old one), then run it against the AFTER behaviour before you finish.');
  return out.join('\n');
}

export function renderBarrier(rows: { holder: string; qname: string; after: string | null }[]): string {
  return ['[loom] not done yet: another agent is changing code you depend on and has not landed it.',
    ...rows.map((r) => `  agent ${r.holder} holds a contract lease on ${r.qname}${r.after ? `; pending signature: ${r.after}` : ''}`),
    '  Finish your other work now. You will be re-woken with the final signature when it lands.'].join('\n');
}

export function renderWake(holder: string, qname: string, sig: string, why: 'landed' | 'lapsed'): string {
  return why === 'landed'
    ? `[loom] agent ${holder}'s change to ${qname} has landed. Final signature: ${sig}\n  You stopped earlier waiting for it: update your code to this version.`
    : `[loom] agent ${holder}'s lease on ${qname} lapsed without a commit. Current signature in the graph: ${sig}\n  Re-check your code against it.`;
}
