// Spec §5.9 mutation strength: five small edits inside one symbol; tests that still pass on them prove little about it.
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import type { SymbolRec } from '@loom/core';

type Node = Parser.SyntaxNode;
export type MutantOp = 'cmp' | 'not' | 'ret' | 'const' | 'arg';
export interface Mutant { op: MutantOp; start: number; end: number; text: string }

declare const __filename: string;
// import.meta.url is undefined inside the CLI's CJS bundle
const require = createRequire(import.meta.url ?? __filename);
let parserP: Promise<Parser> | null = null;
const parser = () => (parserP ??= (async () => {
  await Parser.init();
  const p = new Parser();
  p.setLanguage(await Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')));
  return p;
})());

const FLIP: Record<string, string> = { '<': '>=', '>': '<=', '<=': '>', '>=': '<', '==': '!=', '!=': '==' };

function* preorder(n: Node): Generator<Node> {
  yield n;
  for (const c of n.children) yield* preorder(c);
}

/** At most one mutant per operator: the first site inside `sym`'s body, in source order. */
export async function mutants(source: string, sym: Pick<SymbolRec, 'name' | 'startLine' | 'endLine'>): Promise<Mutant[]> {
  const tree = (await parser()).parse(source);
  try {
    const def = [...preorder(tree.rootNode)].find((n) => n.type === 'function_definition'
      && n.childForFieldName('name')?.text === sym.name && n.startPosition.row + 1 >= sym.startLine && n.endPosition.row + 1 <= sym.endLine);
    if (!def) return [];
    const out = new Map<MutantOp, Mutant>();
    const add = (op: MutantOp, n: Node, text: string) => { if (!out.has(op)) out.set(op, { op, start: n.startIndex, end: n.endIndex, text }); };
    for (const n of preorder(def.childForFieldName('body')!)) {
      if (n.type === 'comparison_operator') {
        const op = n.children.find((c) => !c.isNamed && FLIP[c.type]);
        if (op) add('cmp', op, FLIP[op.type]);
      } else if (n.type === 'if_statement') {
        const c = n.childForFieldName('condition');
        if (c) add('not', c, `not (${c.text})`);
      } else if (n.type === 'return_statement') {
        if (n.namedChildren.length && n.namedChildren[0].text !== 'None') add('ret', n, 'return None');
      } else if (n.type === 'integer' && /^\d+$/.test(n.text)) {
        add('const', n, String(Number(n.text) + 1));
      } else if (n.type === 'call') {
        const args = n.childForFieldName('arguments');
        const named = args?.type === 'argument_list' ? args.namedChildren.filter((a) => a.type !== 'comment') : [];
        if (named.length) add('arg', args!, `(${named.slice(0, -1).map((a) => a.text).join(', ')})`);
      }
      if (out.size === 5) break;
    }
    return [...out.values()];
  } finally { tree.delete(); }
}

export const applyMutant = (source: string, m: Mutant) => source.slice(0, m.start) + m.text + source.slice(m.end);
