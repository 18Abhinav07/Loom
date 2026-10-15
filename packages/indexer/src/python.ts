import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import type { CallRec, FileIndex, ParamSpec, SymbolRec } from '@loom/core';

type Node = Parser.SyntaxNode;
const require = createRequire(import.meta.url);
let parserP: Promise<Parser> | null = null;

function parser(): Promise<Parser> {
  parserP ??= (async () => {
    await Parser.init();
    const lang = await Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'));
    const p = new Parser();
    p.setLanguage(lang);
    return p;
  })();
  return parserP;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const squash = (s: string) => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

function stripComments(n: Node, src: string): string {
  const cuts: Array<[number, number]> = [];
  const walk = (x: Node) => { if (x.type === 'comment') cuts.push([x.startIndex, x.endIndex]); x.children.forEach(walk); };
  walk(n);
  let out = '';
  let at = n.startIndex;
  for (const [s, e] of cuts) { out += src.slice(at, s); at = e; }
  return out + src.slice(at, n.endIndex);
}

/** dotted module of a file path: django/utils/text.py -> django.utils.text */
const fileModule = (file: string) => file.replace(/\.py$/, '').replace(/\/__init__$/, '').replaceAll('/', '.');
const isPkg = (file: string) => file.endsWith('/__init__.py');
const modulePath = (mod: string) => mod.replaceAll('.', '/');

interface Imports { names: Map<string, string>; modules: Map<string, string> } // local -> dotted target

function readImports(root: Node, file: string): Imports {
  const names = new Map<string, string>();
  const modules = new Map<string, string>();
  for (const st of root.namedChildren) {
    if (st.type === 'import_from_statement') {
      const modNode = st.childForFieldName('module_name')!;
      let mod = modNode.text;
      if (modNode.type === 'relative_import') {
        const dots = (mod.match(/^\.+/) ?? [''])[0].length;
        const rest = mod.slice(dots);
        const parts = fileModule(file).split('.');
        const base = isPkg(file) ? parts : parts.slice(0, -1);
        mod = [...base.slice(0, base.length - (dots - 1)), ...(rest ? [rest] : [])].join('.');
      }
      for (const n of st.childrenForFieldName('name')) {
        const [name, alias] = n.type === 'aliased_import'
          ? [n.childForFieldName('name')!.text, n.childForFieldName('alias')!.text] : [n.text, n.text];
        names.set(alias, `${mod}.${name}`);
      }
    } else if (st.type === 'import_statement') {
      for (const n of st.childrenForFieldName('name')) {
        if (n.type === 'aliased_import') modules.set(n.childForFieldName('alias')!.text, n.childForFieldName('name')!.text);
        else modules.set(n.text.split('.')[0], n.text.split('.')[0]);
      }
    }
  }
  return { names, modules };
}

function resolve(callee: Node, file: string, imps: Imports, local: Set<string>, cls: string | null): string[] {
  const target = (dotted: string) => {
    const i = dotted.lastIndexOf('.');
    const mod = modulePath(dotted.slice(0, i));
    const name = dotted.slice(i + 1);
    return [`${mod}.py::${name}`, `${mod}/__init__.py::${name}`];
  };
  if (callee.type === 'identifier') {
    const n = callee.text;
    if (local.has(n)) return [`${file}::${n}`];
    const d = imps.names.get(n);
    return d ? target(d) : [];
  }
  if (callee.type === 'attribute') {
    const obj = callee.childForFieldName('object')!;
    const attr = callee.childForFieldName('attribute')!.text;
    if (obj.type === 'identifier') {
      if (obj.text === 'self' && cls) return [`${file}::${cls}.${attr}`];
      const asName = imps.names.get(obj.text);       // from django.utils import html as H
      if (asName) return target(`${asName}.${attr}`);
      const asMod = imps.modules.get(obj.text);      // import django.utils.html as H
      if (asMod) return target(`${asMod}.${attr}`);
    }
  }
  return [];
}

function readParams(ps: Node, isMethod: boolean, decorators: string[]): ParamSpec {
  const out: ParamSpec = { posonly: [], pos: [], vararg: false, kwonly: [], kwarg: false,
    self: isMethod && !decorators.some((d) => d === '@staticmethod') };
  let kwonly = false;
  for (const p of ps.children) {
    const t = p.type;
    if (t === '/' || t === 'positional_separator') { out.posonly.push(...out.pos); out.pos = []; continue; }
    if (t === '*' || t === 'keyword_separator') { kwonly = true; continue; }
    if (!p.isNamed || t === 'comment') continue;
    const head = t === 'typed_parameter' ? p.namedChildren[0] : p;
    if (head.type === 'list_splat_pattern') { out.vararg = true; kwonly = true; continue; }
    if (head.type === 'dictionary_splat_pattern') { out.kwarg = true; continue; }
    const name = t === 'identifier' ? p.text : t === 'typed_parameter' ? head.text : p.childForFieldName('name')?.text;
    if (!name) continue;
    (kwonly ? out.kwonly : out.pos).push({ name, default: t === 'default_parameter' || t === 'typed_default_parameter' });
  }
  return out;
}

/** First statement a string literal → its text without quotes, first 300 chars (planner full-text). */
function docOf(body: Node): { doc?: string } {
  const first = body.namedChildren[0];
  const str = first?.type === 'expression_statement' ? first.namedChildren[0] : null;
  if (str?.type !== 'string') return {};
  const doc = str.text.replace(/^[rRuUbBfF]*("{3}|'{3}|"|')/, '').replace(/("{3}|'{3}|"|')$/, '').trim().slice(0, 300);
  return doc ? { doc } : {};
}

export async function indexPython(file: string, source: string): Promise<FileIndex> {
  const tree = (await parser()).parse(source);
  const root = tree.rootNode;
  const imps = readImports(root, file);
  const symbols: SymbolRec[] = [];
  const calls: CallRec[] = [];
  const defs: Array<{ sym: SymbolRec; def: Node; cls: string | null }> = [];

  const visit = (outer: Node, prefix: string, cls: string | null) => {
    const def = outer.type === 'decorated_definition' ? outer.childForFieldName('definition')! : outer;
    if (def.type !== 'function_definition' && def.type !== 'class_definition') return;
    const decorators = outer.type === 'decorated_definition'
      ? outer.namedChildren.filter((c) => c.type === 'decorator').map((c) => squash(c.text)) : [];
    const name = def.childForFieldName('name')!.text;
    const body = def.childForFieldName('body')!;
    const isClass = def.type === 'class_definition';
    const sig = isClass
      ? `class ${name}${squash(def.childForFieldName('superclasses')?.text ?? '')}`
      : `def ${name}${squash(def.childForFieldName('parameters')!.text)}` +
        (def.childForFieldName('return_type') ? ` -> ${squash(def.childForFieldName('return_type')!.text)}` : '');
    const sym: SymbolRec = {
      id: `${file}::${prefix}${name}`, file, name, qname: `${prefix}${name}`,
      kind: isClass ? 'class' : prefix ? 'method' : 'function',
      startLine: outer.startPosition.row + 1, endLine: outer.endPosition.row + 1,
      sig, sigHash: sha([sig, ...decorators].join('|')),
      bodyHash: sha(squash(stripComments(body, source))),
      exported: !name.startsWith('_') && !(prefix && prefix.startsWith('_')),
      ...docOf(body),
      ...(isClass ? {} : { params: readParams(def.childForFieldName('parameters')!, Boolean(prefix), decorators) }),
    };
    symbols.push(sym);
    if (isClass) { for (const c of body.namedChildren) visit(c, `${prefix}${name}.`, name); }
    else defs.push({ sym, def: body, cls });
  };
  for (const c of root.namedChildren) visit(c, '', null);

  const local = new Set(symbols.filter((s) => s.kind !== 'method').map((s) => s.qname));
  for (const { sym, def, cls } of defs) {
    for (const call of def.descendantsOfType('call')) {
      const fn = call.childForFieldName('function')!;
      if (fn.type !== 'identifier' && fn.type !== 'attribute') continue;
      const args = call.childForFieldName('arguments');
      const named = args?.type === 'argument_list' ? args.namedChildren.filter((a) => a.type !== 'comment') : [];
      calls.push({
        from: sym.id, callee: fn.text, to: resolve(fn, file, imps, local, cls), line: call.startPosition.row + 1,
        argc: args?.type === 'argument_list' ? named.filter((a) => !['keyword_argument', 'list_splat', 'dictionary_splat'].includes(a.type)).length : 1,
        kwargs: named.filter((a) => a.type === 'keyword_argument').map((a) => a.childForFieldName('name')!.text),
        star: named.some((a) => a.type === 'list_splat'),
        dstar: named.some((a) => a.type === 'dictionary_splat'),
        method: fn.type === 'attribute',
      });
    }
  }
  tree.delete();
  return { file, source, symbols, calls };
}
