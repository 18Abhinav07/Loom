import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { checkInvariants } from '../../src/regions/invariants.js';
import { decodeUtf8, lineEnd, lineStart, onlySpaceBefore, sha1, squash } from '../../src/regions/text.js';
import type { FileRegions } from '../../src/regions/types.js';

test('sha1 hashes UTF-8 bytes, same as git/shasum', () => {
  const s = 'é😀\n';
  expect(sha1(s)).toBe(execFileSync('shasum', ['-a', '1'], { input: Buffer.from(s, 'utf8') }).toString().split(' ')[0]);
});

test('decodeUtf8 rejects invalid UTF-8', () => {
  expect(decodeUtf8(Buffer.from('ok é', 'utf8'))).toBe('ok é');
  expect(decodeUtf8(Buffer.from([0xff, 0xfe, 0x00]))).toBeNull();
});

test('lineStart / lineEnd extend to whole lines, newline included', () => {
  const t = 'ab\ncd\nef';
  expect(lineStart(t, 0)).toBe(0);
  expect(lineStart(t, 4)).toBe(3);
  expect(lineStart(t, 3)).toBe(3);
  expect(lineEnd(t, 4)).toBe(6);   // node ends inside "cd" → after its \n
  expect(lineEnd(t, 6)).toBe(6);   // already at a line start
  expect(lineEnd(t, 7)).toBe(8);   // last line has no \n → end of text
  expect(lineStart('\nx', 0)).toBe(0);
});

test('onlySpaceBefore and squash', () => {
  expect(onlySpaceBefore('  # c', 2)).toBe(true);
  expect(onlySpaceBefore('x = 1  # c', 7)).toBe(false);
  expect(squash('( a,\n   b )')).toBe('(a, b)');
});

test('checkInvariants reports gaps in cover, empties, bad hashes and duplicate ids', () => {
  const text = 'abcdef';
  const r = (id: string, start: number, end: number, hash = sha1(text.slice(start, end))) =>
    ({ id, kind: 'gap' as const, qname: id, start, end, hash, masked: hash, sig: null });
  const fr = (regions: ReturnType<typeof r>[]): FileRegions => ({ path: 'f', pack: 'file', degraded: false, text, regions, warnings: [] });
  expect(checkInvariants(fr([r('a', 0, 3), r('b', 3, 6)]))).toEqual([]);
  expect(checkInvariants(fr([r('a', 0, 2), r('b', 3, 6)]))).toEqual(['b: starts at 3, expected 2']);
  expect(checkInvariants(fr([r('a', 0, 3), r('b', 3, 3), r('c', 3, 6)]))).toEqual(['b: empty']);
  expect(checkInvariants(fr([r('a', 0, 3, 'x'), r('b', 3, 6)]))).toEqual(['a: hash mismatch']);
  expect(checkInvariants(fr([r('a', 0, 3), r('a', 3, 6)]))).toEqual(['a: duplicate id']);
  expect(checkInvariants(fr([r('a', 0, 3)]))).toEqual(['cover ends at 3, text length 6']);
});
