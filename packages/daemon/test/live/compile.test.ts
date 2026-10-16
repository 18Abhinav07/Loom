// B2: the landing gate runs the repo's compiler and refuses only errors the landed base did not already have.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { compileErrors, newErrors } from '../../src/live/compile.js';
import { landOne } from '../../src/live/queue.js';
import { git, gitTree } from '../helpers.js';

const MOD = 'module m\n\ngo 1.21\n';
const BASE_ERR = 'package m\n\nfunc F() int {\n\treturn x\n}\n';   // one vet error the base already has
let db: LoomDb; let g: LoomGraph;
beforeAll(async () => { db = await LoomDb.connect(); g = db.graph(`ct-${Date.now()}`); });
afterAll(async () => { await g.drop().catch(() => {}); await db.close(); });

function repo() {
  const r = gitTree({ 'go.mod': MOD, 'a.go': BASE_ERR });
  git(r, 'branch', 'landed');
  const w = mkdtempSync(join(tmpdir(), 'c-x-')); git(r, 'worktree', 'add', '-q', '-b', 'x', w);
  return { r, w };
}
const job = (r: string, wt: string) => ({ repo: r, wt, landed: 'landed', agent: 'x', title: 'x', testCmd: null, compileCmd: 'go build ./...', g });
const rev = (r: string) => git(r, 'rev-parse', 'landed').trim();

test('newErrors is head minus base, counting repeats', () => {
  expect(newErrors(['a.go: x undefined'], ['a.go: x undefined', 'b.go: y undefined'])).toEqual(['b.go: y undefined']);
  expect(newErrors(['e'], ['e', 'e'])).toEqual(['e']);
  expect(newErrors(['e', 'f'], ['f'])).toEqual([]);
});

test('compileErrors strips positions and keeps only error lines', () => {
  const { r } = repo();
  const c = compileErrors('go build ./...', r);
  expect(c.ok).toBe(false);
  expect(c.errors).toEqual(['./a.go: undefined: x']);
  expect(compileErrors('echo "src/a.ts(3,5): error TS2304: Cannot find name y"; exit 2', r).errors).toEqual(['src/a.ts: error TS2304: Cannot find name y']);
});

test('a change that adds a new undefined call → compile_failed naming it; landed does not move', async () => {
  const { r, w } = repo();
  const before = rev(r);
  writeFileSync(join(w, 'b.go'), 'package m\n\nfunc G() int {\n\treturn y\n}\n');
  const res = await landOne(job(r, w));
  expect(res.status).toBe('compile_failed');
  expect(res.tail).toContain('undefined: y');
  expect(res.tail).not.toContain('undefined: x');
  expect(rev(r)).toBe(before);
});

test('a change that adds no new error lands despite the base error', async () => {
  const { r, w } = repo();
  writeFileSync(join(w, 'c.go'), 'package m\n\nfunc H() int {\n\treturn 1\n}\n');
  const res = await landOne(job(r, w));
  expect(res.status).toBe('landed');
  expect(rev(r)).toBe(res.sha);
});

const TSC = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsc');
test('TS: changing f(x: number) to f(x: string) breaks a caller in another file → compile_failed naming TS2345', async () => {
  const r = gitTree({ 'tsconfig.json': '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src"]}\n',
    'src/a.ts': 'export function f(x: number): number {\n  return x;\n}\n', 'src/b.ts': "import { f } from './a';\nexport const y = f(1);\n" });
  git(r, 'branch', 'landed');
  const w = mkdtempSync(join(tmpdir(), 'c-ts-')); git(r, 'worktree', 'add', '-q', '-b', 'x', w);
  writeFileSync(join(w, 'src/a.ts'), 'export function f(x: string): string {\n  return x;\n}\n');
  const res = await landOne({ ...job(r, w), compileCmd: `${TSC} --noEmit -p .` });
  expect(res.status).toBe('compile_failed');
  expect(res.tail).toMatch(/src\/b\.ts: error TS2345/);
});
