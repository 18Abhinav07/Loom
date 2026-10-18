import { describe, expect, it } from 'vitest';
import { allowedTools } from '../src/run.js';

describe('allowedTools', () => {
  it('covers git, python, npm, npx and node by default', () => {
    const t = allowedTools({});
    for (const x of ['Bash(git:*)', 'Bash(python:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'mcp__loom__*']) expect(t).toContain(x);
  });
  it("adds the plan's test and compile commands", () => {
    const t = allowedTools({ test: 'pytest -q tests', compile: 'go vet ./...' });
    expect(t).toContain('Bash(pytest:*)');
    expect(t).toContain('Bash(go:*)');
  });
  it('skips leading env assignments', () => {
    expect(allowedTools({ test: 'FOO=1 make test' })).toContain('Bash(make:*)');
  });
  it('allows python3 (macOS has no python) and every command in a cd && ... | tail test line', () => {
    const t = allowedTools({ test: 'cd tests && PYTHONPATH=.. python3 runtests.py utils_tests --parallel 1 2>&1 | tail -15' });
    expect(t).toContain('Bash(python3:*)');
    expect(t).not.toContain('Bash(tail:*)');
  });
  it('blind agents get no mcp tools', () => {
    expect(allowedTools({ blind: true }).some((x) => x.startsWith('mcp__'))).toBe(false);
  });
  it('has no duplicates', () => {
    const t = allowedTools({ test: 'python -m pytest', compile: 'npx tsc --noEmit' });
    expect(new Set(t).size).toBe(t.length);
  });
});
