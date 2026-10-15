import { indexPython } from '../packages/indexer/src/index.ts';
import { readFileSync, globSync } from 'node:fs';
const t = Date.now(); let n = 0, f = 0;
for (const p of globSync('django/**/*.py', { cwd: 'bench/cache/django-src' })) { n += (await indexPython(p, readFileSync('bench/cache/django-src/' + p, 'utf8'))).symbols.length; f++; }
console.log(f, 'files', n, 'symbols', Date.now() - t, 'ms');
