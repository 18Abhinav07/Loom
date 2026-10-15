import { expect, test } from 'vitest';
import { checkInvariants, regionize } from '../../src/regions/index.js';

const TS = [
  "import { a as b } from './x';",
  '// lead',
  'export function f(x: number): string { return b(x); }',
  'export const g = (y: number) => new Foo(y);',
  'let h = 1;',
  'export default class K extends Base {',
  '  // m',
  '  m(): void { this.n(); }',
  '  static n() {}',
  '}',
  'export { f as ff };',
  '',
].join('\n');

const rows = (fr: Awaited<ReturnType<typeof regionize>>) => fr.regions.map((r) => [r.kind, r.qname, fr.text.slice(r.start, r.end)]);

for (const [path, pack, src] of [
  ['src/a.ts', 'typescript@1', TS],
  ['src/a.tsx', 'tsx@1', TS],
  ['src/a.js', 'javascript@1', TS.replace(/: (number|string|void)/g, '')],
] as const) {
  test(`${pack}: exports, arrow consts, class container and members, trailing gap`, async () => {
    const fr = await regionize(path, src);
    expect(fr.pack).toBe(pack);
    const lines = src.split('\n');
    expect(rows(fr)).toEqual([
      ['imports', 'imports', `${lines[0]}\n`],
      ['definition', 'f', `${lines[1]}\n${lines[2]}\n`],
      ['definition', 'g', `${lines[3]}\n`],
      ['definition', 'h', `${lines[4]}\n`],
      ['container', 'K', `${lines[5]}\n`],
      ['definition', 'K.m', `${lines[6]}\n${lines[7]}\n`],
      ['definition', 'K.n', `${lines[8]}\n`],
      ['gap', 'gap@after:K.n', `${lines[9]}\n${lines[10]}\n`],
    ]);
    expect(checkInvariants(fr)).toEqual([]);
  });
}

test('typescript: sigs strip the ":" of return types; one-line class is one definition', async () => {
  const fr = await regionize('src/a.ts', TS);
  const by = Object.fromEntries(fr.regions.map((r) => [r.qname, r]));
  expect(by.f.sig).toBe('f(x: number) -> string');
  expect(by.g.sig).toBe('g(y: number)');
  expect(by['K.m'].sig).toBe('m() -> void');
  const one = await regionize('o.ts', 'class A { m() {} n() {} }\ninterface I { x: number }\ntype T = 1;\nenum E { A }\n');
  expect(one.regions.map((r) => `${r.kind}:${r.qname}`)).toEqual(['definition:A', 'definition:I', 'definition:T', 'definition:E']);
});
