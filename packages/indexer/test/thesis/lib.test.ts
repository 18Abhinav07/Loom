import { describe, expect, test } from 'vitest';
import { applyHunks, hunks, rebaseUnder, splitLines } from '../../thesis/lib.js';

const L = (...xs: string[]) => xs.map((x) => x + '\n').join('');

describe('thesis lib', () => {
  test('roundtrip: applyHunks(a, hunks(a, b)) === b, including insert/delete at ends', () => {
    const cases: Array<[string, string]> = [
      [L('a', 'b', 'c'), L('a', 'X', 'c')],
      [L('a', 'b', 'c'), L('Z', 'a', 'b', 'c', 'Y')],
      [L('a', 'b', 'c'), L('b')],
      ['', L('a')],
      [L('a'), ''],
    ];
    for (const [a, b] of cases) expect(applyHunks(a, hunks(a, b))).toBe(b);
  });

  test('roundtrip keeps a missing final newline', () => {
    expect(applyHunks('a\nb', hunks('a\nb', 'a\nB'))).toBe('a\nB');
    expect(applyHunks('a\nb\n', hunks('a\nb\n', 'a\nb'))).toBe('a\nb');
    expect(splitLines('x\ny')).toEqual(['x\n', 'y']);
  });

  test('rebaseUnder: disjoint hunks move by the line delta of earlier c1 hunks', () => {
    const base = L('1', '2', '3', '4', '5', '6');
    const ours = L('0', '1', '2', '3', '4', '5', '6');          // c1 inserts at top
    const c2 = L('0', '1', '2', '3', '4', 'FIVE', '6');          // c2 edits line 5
    const r = rebaseUnder(hunks(base, ours), hunks(ours, c2));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') { expect(applyHunks(base, r.theirs)).toBe(L('1', '2', '3', '4', 'FIVE', '6')); expect(r.touch).toBe(false); }
  });

  test('rebaseUnder: c2 changing a line c1 wrote is an overlap', () => {
    const base = L('1', '2', '3');
    const ours = L('1', 'TWO', '3');
    const c2 = L('1', 'TWO!', '3');
    expect(rebaseUnder(hunks(base, ours), hunks(ours, c2)).kind).toBe('overlap');
  });

  test('rebaseUnder: adjacent hunks are touch, not overlap, and rebase exactly', () => {
    const base = L('1', '2', '3', '4');
    const ours = L('1', 'TWO', '3', '4');
    const c2 = L('1', 'TWO', 'THREE', '4');
    const r = rebaseUnder(hunks(base, ours), hunks(ours, c2));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') { expect(r.touch).toBe(true); expect(applyHunks(base, r.theirs)).toBe(L('1', '2', 'THREE', '4')); }
  });
});
