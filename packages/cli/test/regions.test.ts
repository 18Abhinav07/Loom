import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { regionsCmd } from '../src/regions.js';

function repo(files: Record<string, string | Buffer>): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-regions-'));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), t); }
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['add', '-A'], { cwd: d });
  return d;
}
const run = async (args: string[], cwd: string) => { const out: string[] = []; const code = await regionsCmd(args, cwd, (s) => out.push(s)); return { code, out: out.join('\n') }; };

test('loom regions <file> lists regions with lines; --json is machine-readable', async () => {
  const d = repo({ 'a.py': 'def f(x):\n    return x\n\n\ndef g():\n    pass\n' });
  const { code, out } = await run(['a.py'], d);
  expect(code).toBe(0);
  expect(out.split('\n')).toEqual(['1-2    definition  f  f(x)', '3-4    gap         gap@after:f', '5-6    definition  g  g()']);
  const j = JSON.parse((await run(['a.py', '--json'], d)).out);
  expect(j.regions.map((r: { id: string }) => r.id)).toEqual(['a.py::f::definition#0', 'a.py::gap@after:f::gap#0', 'a.py::g::definition#0']);
});

test('loom regions check: exit 0 on a clean tree, counts degraded files', async () => {
  const d = repo({ 'a.py': 'def f():\n    pass\n', 'b.py': 'def (\n', 'r.md': '# T\n', 'i.bin': Buffer.from([0xff, 0xfe]) });
  const { code, out } = await run(['check'], d);
  expect(code).toBe(0);
  expect(out).toMatch(/files 4 · regions \d+ · degraded 1 · violations 0/);
});

test('loom regions mark inserts a valid marker block, rejects one that cuts a definition', async () => {
  const d = repo({ 'a.py': 'X = 1\nY = 2\n\n\ndef f():\n    a = 1\n    return a\n' });
  expect((await run(['mark', 'a.py', '1', '2', 'consts'], d)).code).toBe(0);
  expect(readFileSync(join(d, 'a.py'), 'utf8')).toBe('# loom:region consts\nX = 1\nY = 2\n# loom:end\n\n\ndef f():\n    a = 1\n    return a\n');
  const before = readFileSync(join(d, 'a.py'), 'utf8');
  const bad = await run(['mark', 'a.py', '8', '8', 'half'], d);
  expect(bad.code).toBe(1);
  expect(bad.out).toMatch(/half cuts definition f/);
  expect(readFileSync(join(d, 'a.py'), 'utf8')).toBe(before);
});

test('loom regions accepts an absolute path from another cwd', async () => {
  const d = repo({ 'a.py': 'def f():\n    pass\n' });
  const { code, out } = await run([join(d, 'a.py')], tmpdir());
  expect(code).toBe(0);
  expect(out).toBe('1-2    definition  f  f()');
});
