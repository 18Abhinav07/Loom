import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Parser from 'web-tree-sitter';
const require = createRequire(import.meta.url);
await Parser.init();
const L: Record<string, Parser.Language> = {};
for (const g of ['python', 'typescript', 'tsx', 'javascript', 'json']) L[g] = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${g}.wasm`));
const p = new Parser();
const parse = (g: string, s: string) => { p.setLanguage(L[g]); return p.parse(s); };
const show = (n: Parser.SyntaxNode, d = 0, max = 3): string => d > max ? '' : `${'  '.repeat(d)}${n.type}${n.isNamed ? '' : '(anon)'}\n` + n.namedChildren.map((c) => show(c, d + 1, max)).join('');
const he = (n: any) => typeof n.hasError === 'function' ? 'method:' + n.hasError() : 'prop:' + n.hasError;
let t = parse('python', '# c1\n# c2\n@dec\ndef f(a, b=1) -> int:\n    def g(): pass\n    return g()\nx: int = 1\na, b = 1, 2\nclass C(B):\n    """doc"""\n    y = 1\n    # m\n    @property\n    def m(self): return self.n()\n    class D:\n        def k(self): pass\nimport os\nfrom . import z as w\nfrom __future__ import annotations\nfoo()\n');
console.log('PY hasError', he(t.rootNode), he(parse('python', 'def f(:\n').rootNode));
console.log(show(t.rootNode, 0, 2));
const dd = t.rootNode.namedChildren.find((c) => c.type === 'decorated_definition')!;
console.log('decorated.definition =', dd.childForFieldName('definition')?.type, '| fn fields name/params/ret:', dd.childForFieldName('definition')!.childForFieldName('name')?.text, dd.childForFieldName('definition')!.childForFieldName('parameters')?.text, dd.childForFieldName('definition')!.childForFieldName('return_type')?.text);
const asg = t.rootNode.namedChildren.find((c) => c.type === 'expression_statement')!;
console.log('assign:', asg.namedChildren[0].type, asg.namedChildren[0].childForFieldName('left')?.type);
const cls = t.rootNode.namedChildren.find((c) => c.type === 'class_definition')!;
console.log('class body field:', cls.childForFieldName('body')?.type, 'superclasses:', cls.childForFieldName('superclasses')?.text, 'body kids:', cls.childForFieldName('body')!.namedChildren.map((c) => c.type).join(','));
console.log('PY calls:', L.python.query('(call function: (_) @callee) @call').captures(t.rootNode).filter((c) => c.name === 'callee').map((c) => c.node.text));
console.log('offsets utf16? ', parse('python', 's = "é😀"\nx = 1\n').rootNode.namedChildren[1].startIndex, '(utf16=9, utf8=12)');
for (const g of ['typescript', 'tsx', 'javascript']) {
  const src = `import { a as b } from './x';\n// lead\nexport function f(x: number): string { return b(x); }\nexport const g = (y) => new Foo(y);\nlet h = 1;\nexport default class K extends Base {\n  // m\n  m(): void { this.n(); }\n  static s() {}\n}\nexport { f as ff };\n`.replace(g === 'javascript' ? /: (number|string|void)/g : /$^/, '');
  const r = parse(g, src).rootNode;
  console.log(`\n${g} hasError`, he(r)); console.log(show(r, 0, 2));
  const ex = r.namedChildren.filter((c) => c.type === 'export_statement');
  console.log('export.declaration:', ex.map((e) => e.childForFieldName('declaration')?.type ?? 'null'));
  const k = ex[2].childForFieldName('declaration')!;
  console.log('class name/body:', k.childForFieldName('name')?.text, k.childForFieldName('body')?.type, k.childForFieldName('body')!.namedChildren.map((c) => c.type + ':' + (c.childForFieldName('name')?.text ?? '')).join(','));
  const lex = ex[1].childForFieldName('declaration')!;
  const vd = lex.namedChildren.find((c) => c.type === 'variable_declarator')!;
  console.log('lexical:', lex.type, vd.childForFieldName('name')?.text, vd.childForFieldName('value')?.type, vd.childForFieldName('value')?.childForFieldName('parameters')?.text);
  const fn = ex[0].childForFieldName('declaration')!;
  console.log('fn params/ret:', fn.childForFieldName('parameters')?.text, fn.childForFieldName('return_type')?.text);
  console.log('calls:', L[g].query('(call_expression function: (_) @callee) @call (new_expression constructor: (_) @callee) @call').captures(r).filter((c) => c.name === 'callee').map((c) => c.node.text));
  const imp = r.namedChildren[0]; console.log('import source field:', imp.childForFieldName('source')?.text, show(imp, 0, 4));
}
const j = parse('json', '{\n  "a": 1,\n  "b": {"c": [1]}\n}\n').rootNode;
console.log('\nJSON', he(j)); console.log(show(j, 0, 3)); const pr = j.namedChildren[0].namedChildren[0]; console.log('pair key/value:', pr.childForFieldName('key')?.text, pr.childForFieldName('value')?.text);
// Django corpus parse
const root = join(process.cwd(), 'bench/cache/django-src/django');
const files: string[] = []; const walk = (d: string) => { for (const f of readdirSync(d)) { const q = join(d, f); if (statSync(q).isDirectory()) walk(q); else if (f.endsWith('.py')) files.push(q); } }; walk(root);
p.setLanguage(L.python); const ts: number[] = []; let errs = 0; const errFiles: string[] = [];
for (const f of files) { const s = readFileSync(f, 'utf8'); const t0 = performance.now(); const tr = p.parse(s); ts.push(performance.now() - t0); const e = typeof (tr.rootNode as any).hasError === 'function' ? (tr.rootNode as any).hasError() : (tr.rootNode as any).hasError; if (e) { errs++; errFiles.push(f.slice(root.length)); } tr.delete(); }
ts.sort((a, b) => a - b);
console.log(`\nDJANGO files=${files.length} errorParses=${errs} ${errFiles.slice(0, 5)} p50=${ts[Math.floor(ts.length / 2)].toFixed(2)}ms p99=${ts[Math.floor(ts.length * 0.99)].toFixed(2)}ms max=${ts.at(-1)!.toFixed(1)}ms total=${ts.reduce((a, b) => a + b, 0).toFixed(0)}ms`);
