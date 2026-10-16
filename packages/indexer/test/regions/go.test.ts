// B2: Go has no grammar pack, so a .go file is one whole-file region; locks are per file and merge/tests/compiler still gate it.
import { expect, test } from 'vitest';
import { checkInvariants, regionize } from '../../src/regions/index.js';

test('go: one whole-file region, not degraded', async () => {
  const src = 'package m\n\nfunc F() int {\n\treturn 1\n}\n\nfunc G() int {\n\treturn 2\n}\n';
  const fr = await regionize('pkg/m.go', src);
  expect(fr.pack).toBe('file');
  expect(fr.regions.map((r) => [r.kind, r.start, r.end])).toEqual([['file', 0, src.length]]);
  expect(fr.degraded).toBe(false);
  expect(checkInvariants(fr)).toEqual([]);
});
