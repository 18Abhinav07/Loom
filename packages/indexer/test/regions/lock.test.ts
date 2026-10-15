import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { fromLockEntry, fromUtf8Offsets, gitBlobSha, parseLock, pickEntry, regionize, serializeLock, toLockEntry, toUtf8Offsets } from '../../src/regions/index.js';

const SRC = 's = "é😀"\n\n\ndef f():\n    return "ü"\n';

test('gitBlobSha equals git hash-object', () => {
  expect(gitBlobSha(SRC)).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: SRC }).toString().trim());
});

test('UTF-16 ↔ UTF-8 offsets round-trip', () => {
  const offs = [0, SRC.indexOf('\n') + 1, SRC.indexOf('def'), SRC.length];
  const bytes = toUtf8Offsets(SRC, offs);
  expect(bytes).toEqual(offs.map((o) => Buffer.byteLength(SRC.slice(0, o))));
  expect(fromUtf8Offsets(SRC, bytes)).toEqual(offs);
});

test('lock entry round-trip gives the same regions', async () => {
  const fr = await regionize('u.py', SRC);
  const e = toLockEntry(fr, gitBlobSha(SRC));
  expect(e.regions[1].start).toBe(Buffer.byteLength(SRC.slice(0, fr.regions[1].start)));
  expect(fromLockEntry(e, SRC).regions).toEqual(fr.regions);
});

test('serialize is sorted, one entry per path; parse tolerates union-merge leftovers and picks by blob', async () => {
  const a = toLockEntry(await regionize('b.py', 'X = 1\n'), 'blob-b1');
  const b = toLockEntry(await regionize('a.py', 'Y = 1\n'), 'blob-a');
  const out = serializeLock([a, b, { ...a, blob: 'blob-b2' }]);
  expect(out.split('\n').filter(Boolean).map((l) => JSON.parse(l).path)).toEqual(['a.py', 'b.py']);
  const merged = `${serializeLock([a])}${serializeLock([{ ...a, blob: 'blob-b2' }])}<<<<<<< ours\nnot json\n`;
  const m = parseLock(merged);
  expect(m.get('b.py')!.map((e) => e.blob)).toEqual(['blob-b1', 'blob-b2']);
  expect(pickEntry(m.get('b.py'), 'blob-b2')!.blob).toBe('blob-b2');
  expect(pickEntry(m.get('b.py'), 'nope')).toBeUndefined();
});
