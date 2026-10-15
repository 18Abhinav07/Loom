import { posix } from 'node:path';
import type Parser from 'web-tree-sitter';
import { language, type Pack } from './pack.js';
import type { FileRegions } from './types.js';

type Node = Parser.SyntaxNode;
export interface RawRefs { calls: Array<{ at: number; name: string }>; imports: Array<{ at: number; local: string; module: string; name: string | null }> }

const queries = new Map<string, Parser.Query>();

export async function readRefs(pack: Pack, root: Node, path: string): Promise<RawRefs> {
  let q = queries.get(pack.name);
  if (!q) { q = (await language(pack.grammar)).query(pack.calls); queries.set(pack.name, q); }
  const calls = q.captures(root).filter((c) => c.name === 'callee').map((c) => ({ at: c.node.startIndex, name: c.node.text }));
  return { calls, imports: pack.importReader === 'python' ? pyImports(root, path) : esImports(root, path) };
}

function pyImports(root: Node, path: string): RawRefs['imports'] {
  const out: RawRefs['imports'] = [];
  const fileMod = path.replace(/\.pyi?$/, '').replace(/\/__init__$/, '').replaceAll('/', '.');
  const isPkg = /\/__init__\.pyi?$/.test(path);
  for (const st of root.namedChildren) {
    if (st.type === 'import_from_statement') {
      const mn = st.childForFieldName('module_name');
      if (!mn) continue;
      let mod = mn.text;
      if (mn.type === 'relative_import') {
        const dots = /^\.+/.exec(mod)![0].length;
        const rest = mod.slice(dots);
        const parts = fileMod.split('.');
        const base = isPkg ? parts : parts.slice(0, -1);
        mod = [...base.slice(0, base.length - (dots - 1)), ...(rest ? [rest] : [])].join('.');
      }
      for (const n of st.childrenForFieldName('name')) {
        const [name, local] = n.type === 'aliased_import' ? [n.childForFieldName('name')!.text, n.childForFieldName('alias')!.text] : [n.text, n.text];
        out.push({ at: st.startIndex, local, module: mod, name });
      }
    } else if (st.type === 'import_statement') {
      for (const n of st.childrenForFieldName('name')) {
        if (n.type === 'aliased_import') out.push({ at: st.startIndex, local: n.childForFieldName('alias')!.text, module: n.childForFieldName('name')!.text, name: null });
        else out.push({ at: st.startIndex, local: n.text.split('.')[0], module: n.text.split('.')[0], name: null });
      }
    }
  }
  return out;
}

function esImports(root: Node, path: string): RawRefs['imports'] {
  const out: RawRefs['imports'] = [];
  const dir = posix.dirname(path);
  for (const st of root.namedChildren) {
    if (st.type !== 'import_statement') continue;
    const src = st.childForFieldName('source');
    const clause = st.namedChildren.find((c) => c.type === 'import_clause');
    if (!src || !clause) continue;
    const spec = src.text.slice(1, -1);
    const module = spec.startsWith('.') ? posix.normalize(posix.join(dir, spec)).replace(/\.(d\.ts|[cm]?[jt]sx?)$/, '') : spec;
    for (const c of clause.namedChildren) {
      if (c.type === 'identifier') out.push({ at: st.startIndex, local: c.text, module, name: 'default' });
      else if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((x) => x.type === 'identifier');
        if (id) out.push({ at: st.startIndex, local: id.text, module, name: null });
      } else if (c.type === 'named_imports') {
        for (const s of c.namedChildren) {
          if (s.type !== 'import_specifier') continue;
          const name = s.childForFieldName('name')!.text;
          out.push({ at: st.startIndex, local: s.childForFieldName('alias')?.text ?? name, module, name });
        }
      }
    }
  }
  return out;
}

/** Map raw offsets to the region that contains them. */
export function attachRefs(fr: FileRegions, raw: RawRefs): void {
  const at = (i: number) => {
    let lo = 0, hi = fr.regions.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fr.regions[mid].start <= i) lo = mid; else hi = mid - 1; }
    return fr.regions[lo].id;
  };
  fr.calls = raw.calls.map((c) => ({ from: at(c.at), name: c.name }));
  fr.imports = raw.imports.map((b) => ({ from: at(b.at), local: b.local, module: b.module, name: b.name }));
}
