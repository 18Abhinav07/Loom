import { expect, test } from 'vitest';
import { checkInvariants, regionize, shiftMap } from '../../src/regions/index.js';

const SRC = 'def a():\n    return 1\n\n\ndef b():\n    return 2\n';

test('broken parse with a last clean map keeps ids and cover, marks touched, never re-parses into a new map', async () => {
  const last = await regionize('f.py', SRC);
  const fr = await regionize('f.py', SRC.replace('def b():', 'def b(:'), { lastClean: last });
  expect(fr.degraded).toBe(true);
  expect(fr.regions.map((r) => r.id)).toEqual(last.regions.map((r) => r.id));
  expect(fr.touched).toEqual(['f.py::b::definition#0']);
  expect(checkInvariants(fr)).toEqual([]);
  const mid = await regionize('f.py', SRC.replace('    return 1\n', '    x = (\n    return 1\n'), { lastClean: last });
  expect(mid.degraded).toBe(true);
  expect(mid.touched).toEqual(['f.py::a::definition#0']);
  expect(mid.regions[1].start).toBe(last.regions[1].start + '    x = (\n'.length);
  expect(checkInvariants(mid)).toEqual([]);
});

test('deleting across a boundary drops emptied regions and keeps exact cover', async () => {
  const last = await regionize('f.py', SRC);
  const text = 'def a():\n    return 2\n';            // removes "return 1", the gap and "def b():" lines
  const fr = shiftMap(last, text, []);
  expect(checkInvariants(fr)).toEqual([]);
  expect(fr.regions.map((r) => r.qname)).not.toContain('gap@after:a');
});

test('insertion at offset 0 stays covered (Review Focus 4)', async () => {
  const last = await regionize('f.py', SRC);
  const fr = shiftMap(last, `(\n${SRC}`, []);
  expect(fr.regions[0].start).toBe(0);
  expect(checkInvariants(fr)).toEqual([]);
  expect(fr.touched).toContain('f.py::a::definition#0');
});

test('a degraded or different-pack last map is not used', async () => {
  const last = await regionize('f.py', SRC);
  const fr = await regionize('f.py', 'def (', { lastClean: { ...last, degraded: true } });
  expect(fr.regions.map((r) => r.kind)).toEqual(['file']);
});
