import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectCompile, detectLangs, sourceDirs } from '../src/detect.js';
import { detectTestCmd } from '../src/loom.js';

const dir = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'loom-detect-'));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
  return d;
};

describe('detect', () => {
  it('counts languages by extension', () => {
    expect(detectLangs(['src/a.ts', 'src/b.tsx', 'lib/c.py', 'README.md'])).toEqual({ ts: 1, tsx: 1, python: 1, md: 1 });
    expect(detectLangs(['a.go', 'b.go', 'c.rs', 'D.java', 'e.mjs', 'x.png'])).toEqual({ go: 2, rust: 1, java: 1, js: 1 });
  });
  it('finds the compiler', () => {
    expect(detectCompile(dir({ 'tsconfig.json': '{}' }), { ts: 3 })).toBe('npx tsc --noEmit -p .');
    expect(detectCompile(dir({ 'tsconfig.json': '{}' }), { python: 3 })).toBeNull();
    expect(detectCompile(dir({ 'go.mod': 'module m' }), { go: 1 })).toBe('go vet ./...');
    expect(detectCompile(dir({ 'Cargo.toml': '' }), { rust: 1 })).toBe('cargo check -q');
    expect(detectCompile(dir({ 'pom.xml': '' }), { java: 1 })).toBe('mvn -q compile');
    expect(detectCompile(dir({ 'build.gradle.kts': '' }), { java: 1 })).toBe('gradle -q compileJava');
    expect(detectCompile(dir({}), {})).toBeNull();
  });
  it('finds source dirs across languages', () => {
    const d = dir({});
    expect(sourceDirs(d, ['src/a.ts', 'pkg/m.go', 'docs/x.md'])).toEqual(['pkg', 'src']);
    expect(sourceDirs(d, ['main.py', 'src/a.ts'])).toEqual(['.']);
    expect(sourceDirs(d, ['docs/x.md'])).toEqual(['.']);
  });
  it('finds go and cargo test commands', () => {
    expect(detectTestCmd(dir({ 'go.mod': 'module m' }))).toBe('go test ./...');
    expect(detectTestCmd(dir({ 'Cargo.toml': '' }))).toBe('cargo test -q');
  });
});
