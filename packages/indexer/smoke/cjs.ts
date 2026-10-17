declare const __filename: string;
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
const require = createRequire(import.meta.url ?? __filename);
async function main() {
  await Parser.init();
  const l = await Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'));
  const p = new Parser(); p.setLanguage(l); console.log('CJS OK', p.parse('def f(): pass\n').rootNode.namedChildren[0].type);
}
main();
