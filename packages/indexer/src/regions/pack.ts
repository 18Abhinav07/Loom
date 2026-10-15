import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import javascript from './packs/javascript.json' with { type: 'json' };
import python from './packs/python.json' with { type: 'json' };
import tsx from './packs/tsx.json' with { type: 'json' };
import typescript from './packs/typescript.json' with { type: 'json' };
import { lineEnd, lineStart, onlySpaceBefore, squash } from './text.js';
import type { Piece } from './types.js';

declare const __filename: string;
// import.meta.url is undefined inside the CLI's CJS bundle (smoke 2026-10-15)
const require = createRequire(import.meta.url ?? __filename);

export interface Pack {
  name: string; version: number; extensions: string[]; grammar: string; comment: string;
  importReader: 'python' | 'ecmascript';
  wrappers: Record<string, string>; definitions: string[]; assignments: string[];
  containers: Record<string, string>; members: string[]; imports: string[]; calls: string; params: string[];
}
type Node = Parser.SyntaxNode;

export const PACKS: Pack[] = [python, typescript, tsx, javascript] as Pack[];
export const packFor = (path: string): Pack | undefined => PACKS.find((p) => p.extensions.some((e) => path.endsWith(e)));

let ready: Promise<void> | null = null;
const langs = new Map<string, Promise<Parser.Language>>();
const parsers = new Map<string, Parser>();

export async function language(grammar: string): Promise<Parser.Language> {
  ready ??= Parser.init();
  await ready;
  let l = langs.get(grammar);
  if (!l) { l = Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${grammar}`)); langs.set(grammar, l); }
  return l;
}

export async function parse(grammar: string, text: string): Promise<Parser.Tree> {
  const lang = await language(grammar);
  let p = parsers.get(grammar);
  if (!p) { p = new Parser(); p.setLanguage(lang); parsers.set(grammar, p); }
  return p.parse(text);
}

/** web-tree-sitter 0.22.6 exposes hasError as a property; tolerate the method form of other versions. */
export function hasError(n: Node): boolean {
  const h = (n as unknown as { hasError: boolean | (() => boolean) }).hasError;
  return typeof h === 'function' ? h.call(n) : h;
}

const unwrap = (pack: Pack, n: Node): Node => {
  const f = pack.wrappers[n.type];
  return (f && n.childForFieldName(f)) || n;
};

function nameNode(pack: Pack, def: Node): Node | null {
  if (pack.assignments.includes(def.type)) {
    const c = def.namedChildren[0];
    const n = c?.type === 'assignment' ? c.childForFieldName('left') : c?.type === 'variable_declarator' ? c.childForFieldName('name') : null;
    return n?.type === 'identifier' ? n : null;
  }
  if (!pack.definitions.includes(def.type) && !pack.members.includes(def.type)) return null;
  return def.childForFieldName('name');
}

function sigOf(pack: Pack, def: Node, name: string): string | null {
  const holder = pack.assignments.includes(def.type) ? def.namedChildren[0]?.childForFieldName('value') ?? null : def;
  if (!holder) return null;
  let params: Node | null = null;
  for (const f of pack.params) if ((params = holder.childForFieldName(f))) break;
  if (!params) return null;
  const ret = holder.childForFieldName('return_type');
  const r = ret ? squash(ret.text).replace(/^:\s*/, '') : '';
  return `${name}${squash(params.text)}${r ? ` -> ${r}` : ''}`;
}

/** Line start of n, extended up over comment lines directly above it (no blank line between). */
function extStart(text: string, n: Node): number {
  let first = n;
  for (let p = n.previousNamedSibling; p && p.type === 'comment' && p.endPosition.row === first.startPosition.row - 1
    && onlySpaceBefore(text, p.startIndex); p = p.previousNamedSibling) first = p;
  return lineStart(text, first.startIndex);
}

const isMember = (pack: Pack, c: Node): boolean => pack.members.includes(c.type) && nameNode(pack, unwrap(pack, c)) !== null;

export function packPieces(pack: Pack, root: Node, text: string): Piece[] {
  const out: Piece[] = [];
  walk(pack, root.namedChildren, text, '', true, out);
  return out;
}

function walk(pack: Pack, nodes: Node[], text: string, prefix: string, top: boolean, out: Piece[]): void {
  for (const n of nodes) {
    if (n.type === 'comment') continue;
    if (top && pack.imports.includes(n.type)) {
      const start = extStart(text, n), end = lineEnd(text, n.endIndex);
      const prev = out.at(-1);
      if (prev?.kind === 'imports' && prev.end === start) prev.end = end;
      else out.push({ start, end, kind: 'imports', qname: 'imports', sig: null });
      continue;
    }
    if (!top && !isMember(pack, n)) continue;
    const def = unwrap(pack, n);
    const nm = nameNode(pack, def);
    if (!nm) continue;
    const qname = prefix + nm.text;
    const start = extStart(text, n), end = lineEnd(text, n.endIndex);
    const piece: Piece = { start, end, kind: 'definition', qname, nameStart: nm.startIndex, nameEnd: nm.endIndex, sig: sigOf(pack, def, nm.text) };
    const field = pack.containers[def.type];
    const body = field ? def.childForFieldName(field) : null;
    const members = body ? body.namedChildren.filter((c) => isMember(pack, c)) : [];
    if (members.length) {
      const headerEnd = extStart(text, members[0]);
      if (headerEnd > start) {
        out.push({ ...piece, kind: 'container', end: headerEnd });
        walk(pack, body!.namedChildren, text, `${qname}.`, false, out);
        continue;
      }
    }
    out.push(piece);
  }
}
