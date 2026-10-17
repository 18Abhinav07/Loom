import { readFileSync } from 'node:fs';
import { parse } from '../src/regions/pack.js';
const f = process.argv[2];
const t = await parse('tree-sitter-typescript.wasm', readFileSync(f, 'utf8'));
const walk = (n: any): void => { if (n.type === 'ERROR' || n.isMissing) console.log(n.type, n.isMissing, n.startPosition.row + 1, JSON.stringify(n.text.slice(0, 80))); for (const c of n.children) if (c.hasError || c.isMissing || c.type==='ERROR') walk(c); };
walk(t.rootNode);
