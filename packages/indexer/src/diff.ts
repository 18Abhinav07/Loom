import type { ChangeRec, FileIndex, SymbolRec } from '@loom/core';

/** Source lines of a symbol with docstring blocks dropped: notices show code, not prose. */
const lines = (idx: FileIndex, s: SymbolRec) => {
  const out: string[] = [];
  let inDoc = false;
  for (const l of idx.source.split('\n').slice(s.startLine - 1, s.endLine)) {
    const t = l.trim();
    const q = (t.match(/"""|'''/g) ?? []).length;
    if (inDoc) { if (q % 2) inDoc = false; continue; }
    if (t.startsWith('"""') || t.startsWith("'''")) { if (q % 2) inDoc = true; continue; }
    out.push(l);
  }
  return out;
};

/** Up to 6 lines, new code first in the budget: what the code does now matters more than what it stopped doing. */
function bodyDiff(prev: FileIndex, a: SymbolRec, next: FileIndex, b: SymbolRec): string[] {
  const before = lines(prev, a);
  const after = lines(next, b);
  const plus = after.filter((l) => l.trim() && !before.includes(l)).map((l) => `+ ${l}`).slice(0, 4);
  const minus = before.filter((l) => l.trim() && !after.includes(l)).map((l) => `- ${l}`).slice(0, 6 - plus.length);
  return [...minus, ...plus];
}

/** Changes from one agent's previous view of a file to its new view. Classes report contract/removed only. */
export function diffFile(prev: FileIndex | undefined, next: FileIndex | undefined): ChangeRec[] {
  const before = new Map((prev?.symbols ?? []).map((s) => [s.id, s]));
  const after = new Map((next?.symbols ?? []).map((s) => [s.id, s]));
  const added = [...after.values()].filter((s) => !before.has(s.id));
  const out: ChangeRec[] = [];
  // source of symbols added in the same edit that the new body references (e.g. a new return wrapper class)
  const relatedTo = (b: SymbolRec) => {
    const body = lines(next!, b).join('\n');
    return added.filter((s) => new RegExp(`\\b${s.name}\\b`).test(body)).map((s) => lines(next!, s).slice(0, 8).join('\n'));
  };

  for (const [id, a] of before) {
    const b = after.get(id);
    if (!b) {
      const renamedTo = added.find((s) => s.bodyHash === a.bodyHash && s.kind === a.kind);
      out.push({ kind: 'removed', symbol: a, renamedTo, bodyDiff: [], related: [] });
    } else if (a.sigHash !== b.sigHash) {
      out.push({ kind: 'contract', symbol: a, after: b, bodyDiff: bodyDiff(prev!, a, next!, b), related: relatedTo(b) });
    } else if (a.bodyHash !== b.bodyHash && a.exported && a.kind !== 'class') {
      out.push({ kind: 'behavior', symbol: a, after: b, bodyDiff: bodyDiff(prev!, a, next!, b), related: relatedTo(b) });
    }
  }
  for (const s of added) out.push({ kind: 'added', symbol: s, after: s, bodyDiff: [], related: [] });
  return out;
}
