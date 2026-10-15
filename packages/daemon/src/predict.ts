import { indexPython } from '@loom/indexer';
import type { LeaseMode } from './lease.js';

export type EditIntent = { file: string; edits: { old: string; new: string; all?: boolean }[] } | { file: string; content: string };

/** The file as the tool would leave it, or null when an old_string is absent (the tool itself will fail). */
export function applyEdits(current: string, it: EditIntent): string | null {
  if ('content' in it) return it.content;
  let out = current;
  for (const e of it.edits) {
    if (!e.old || !out.includes(e.old)) return null;
    out = e.all ? out.split(e.old).join(e.new) : out.replace(e.old, () => e.new);
  }
  return out;
}

/** Which existing symbols an edit touches, and whether it changes a signature (contract) or only a body (write). */
export async function predictLease(file: string, current: string, next: string): Promise<{ sids: string[]; mode: LeaseMode | null }> {
  const [a, b] = await Promise.all([indexPython(file, current), indexPython(file, next)]);
  const after = new Map(b.symbols.map((s) => [s.id, s]));
  const contract: string[] = []; const write: string[] = [];
  for (const s of a.symbols) {
    const n = after.get(s.id);
    if (!n || n.sigHash !== s.sigHash) contract.push(s.id);
    else if (s.kind !== 'class' && n.bodyHash !== s.bodyHash) write.push(s.id);
  }
  return { sids: [...contract, ...write], mode: contract.length ? 'contract' : write.length ? 'write' : null };
}
