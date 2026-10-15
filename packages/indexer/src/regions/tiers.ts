import type Parser from 'web-tree-sitter';
import { lineEnd } from './text.js';
import type { Piece, RegionizeOpts } from './types.js';

const MB = 1 << 20;
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|[^/]+\.lock)$/;

export function wholeFileReason(path: string, text: string, bytes: number, opts: RegionizeOpts): string | null {
  if (bytes > MB) return 'over 1 MB';
  if (LOCKFILE.test(path)) return 'lockfile';
  if (opts.generated || /@generated/.test(text.split('\n', 5).join('\n'))) return 'generated';
  const lines = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  if (text.length / lines > 300) return 'minified';
  return null;
}

export function COMMENT_SYNTAX(path: string): [string, string] | null {
  if (/\.(py|pyi|sh|ya?ml|toml|rb)$/.test(path)) return ['# ', ''];
  if (/\.([cm]?[jt]sx?|go|rs|java|c|h|cpp|swift|kt)$/.test(path)) return ['// ', ''];
  if (/\.(md|markdown|html?)$/i.test(path)) return ['<!-- ', ' -->'];
  if (/\.sql$/.test(path)) return ['-- ', ''];
  return null;
}

export interface Block { start: number; end: number; name: string }
const OPEN = /^[ \t]*(?:#|\/\/|--|<!--)[ \t]*loom:region[ \t]+(\S+)/;
const CLOSE = /^[ \t]*(?:#|\/\/|--|<!--)[ \t]*loom:end\b/;

export function markerBlocks(text: string, warnings: string[]): Block[] {
  const blocks: Block[] = [];
  let open: { start: number; name: string; line: number; bad: boolean } | null = null;
  let off = 0;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const start = off;
    off += line.length + (i < lines.length - 1 ? 1 : 0);
    const o = OPEN.exec(line);
    if (o) {
      if (open) { warnings.push(`marker: nested loom:region at line ${i + 1}; ${open.name} ignored`); open.bad = true; }
      else open = { start, name: o[1].replace(/--[>]$/, '') /* tree-sitter-typescript 0.20.5 misreads a literal --> in a regex (ledger S-14) */, line: i + 1, bad: false };
    } else if (CLOSE.test(line)) {
      if (!open) warnings.push(`marker: loom:end without loom:region at line ${i + 1}`);
      else { if (!open.bad) blocks.push({ start: open.start, end: off, name: open.name }); open = null; }
    }
  });
  if (open) warnings.push(`marker: unclosed loom:region ${(open as { name: string }).name} at line ${(open as { line: number }).line}`);
  return blocks;
}

/** A block replaces the pieces inside it; one that cuts through a piece is ignored (gaps may be split). */
export function overlayMarkers(pieces: Piece[], blocks: Block[], warnings: string[]): Piece[] {
  let out = pieces;
  for (const b of blocks) {
    const cut = out.find((p) => p.start < b.end && p.end > b.start && (p.start < b.start || p.end > b.end));
    if (cut) { warnings.push(`marker: ${b.name} cuts ${cut.kind} ${cut.qname}; ignored`); continue; }
    out = [...out.filter((p) => !(p.start >= b.start && p.end <= b.end)), { start: b.start, end: b.end, kind: 'section', qname: b.name, sig: null }];
  }
  return out;
}

export function jsonPieces(root: Parser.SyntaxNode): Piece[] | null {
  const obj = root.namedChildren.find((c) => c.type !== 'comment');
  if (obj?.type !== 'object') return null;
  return obj.namedChildren.filter((c) => c.type === 'pair').map((p) => {
    const k = p.childForFieldName('key')!;
    const next = p.nextSibling;
    let name: string;
    try { name = String(JSON.parse(k.text)); } catch { name = k.text; }
    return { start: p.startIndex, end: next?.type === ',' ? next.endIndex : p.endIndex, kind: 'key' as const, qname: name, nameStart: k.startIndex, nameEnd: k.endIndex, sig: null };
  });
}

export function markdownPieces(text: string): Piece[] {
  const out: Piece[] = [];
  const stack: string[] = [];
  let fence: string | null = null;
  let off = 0;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const start = off;
    off += line.length + (i < lines.length - 1 ? 1 : 0);
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return; }
    if (f) { fence = f[1]; return; }
    const h = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*\r?$/.exec(line);
    if (!h) return;
    const level = h[1].length;
    stack.length = level;
    stack[level - 1] = (h[2] ?? '').trim();
    const qname = stack.slice(0, level).filter((s) => s).join('/') || '(untitled)';
    const prev = out.at(-1);
    if (prev) prev.end = start;
    out.push({ start, end: text.length, kind: 'section', qname, sig: null });
  });
  return out;
}

export function definedPieces(text: string, defined: Array<{ start: number; end: number; name: string }>, warnings: string[]): Piece[] | null {
  const ds = [...defined].sort((a, b) => a.start - b.start);
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    const why = !/^\S+$/.test(d.name) ? `bad name "${d.name}"` : d.start < 0 || d.end > text.length || d.end <= d.start ? `${d.name} out of bounds`
      : i > 0 && d.start < ds[i - 1].end ? `${d.name} overlaps ${ds[i - 1].name}` : null;
    if (why) { warnings.push(`defined: ${why}; ignored`); return null; }
  }
  return ds.map((d) => ({ start: d.start, end: d.end, kind: 'section' as const, qname: d.name, sig: null }));
}

export { lineEnd };
