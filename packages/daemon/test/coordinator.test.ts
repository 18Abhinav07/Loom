import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { Coordinator } from '../src/coordinator.js';

const TEXT = 'def phone2numeric(phone):\n    return phone.upper()\n\ndef other(x):\n    return x\n';
let db: LoomDb; let g: LoomGraph; let c: Coordinator; let base: string; let wa: string; let wb: string;

function tree(text: string) {
  const d = mkdtempSync(join(tmpdir(), 'loom-'));
  mkdirSync(join(d, 'django/utils'), { recursive: true });
  writeFileSync(join(d, 'django/utils/text.py'), text);
  return d;
}

beforeEach(async () => {
  db = await LoomDb.connect(); g = db.graph(`test:coord:${Date.now()}:${Math.random()}`);
  base = tree(TEXT); wa = tree(TEXT); wb = tree(TEXT);
  c = await Coordinator.create(g, 'r1');
  await c.indexBase(base, ['django']);
  await c.registerAgent('A', 'replay', wa); await c.registerAgent('B', 'claude', wb);
});
afterEach(async () => { await g.drop(); await db.close(); });

test('mid-run: B wrote a caller, then A changes the contract -> B gets one notice with the path', async () => {
  writeFileSync(join(wb, 'django/utils/text.py'), TEXT + '\ndef phone2numeric_clean(p):\n    return phone2numeric(p)\n');
  await c.onEdit('B', wb, 'django/utils/text.py');
  expect(await c.takeNotices('B')).toEqual([]);

  writeFileSync(join(wa, 'django/utils/text.py'), TEXT.replace('(phone):', '(phone, *, strict):'));
  const r = await c.onEdit('A', wa, 'django/utils/text.py');
  expect(r.notices).toBe(1);
  const [n] = await c.takeNotices('B');
  expect(n.text).toContain('after:  def phone2numeric(phone, *, strict)');
  expect(await c.takeNotices('B')).toEqual([]);     // delivered once
  expect(await c.takeNotices('A')).toEqual([]);     // never notify the author
});

test('read-after-change: A changes first, B reads later -> B is notified on the read', async () => {
  writeFileSync(join(wa, 'django/utils/text.py'), TEXT.replace('def phone2numeric', 'def phone2numeric_v2').replace('return phone.upper()', 'return phone.upper()'));
  await c.onEdit('A', wa, 'django/utils/text.py');
  expect(await c.takeNotices('B')).toEqual([]);
  await c.onRead('B', 'django/utils/text.py');
  const [n] = await c.takeNotices('B');
  expect(n.text).toContain('renamed to: def phone2numeric_v2(phone)');
});

test('rettype: behavior notice carries the body diff and the new wrapper class', async () => {
  await c.onRead('B', 'django/utils/text.py', 1, 2);
  writeFileSync(join(wa, 'django/utils/text.py'),
    'class _CoordT:\n    def __init__(self, text):\n        self.text = text\n\n' + TEXT.replace('return phone.upper()', 'return _CoordT(phone.upper())'));
  await c.onEdit('A', wa, 'django/utils/text.py');
  const [n] = await c.takeNotices('B');
  expect(n.text).toContain('return _CoordT(phone.upper())');
  expect(n.text).toContain('self.text = text');
});

test('a read limited to an unrelated range does not target B', async () => {
  await c.onRead('B', 'django/utils/text.py', 4, 5); // only `other`
  writeFileSync(join(wa, 'django/utils/text.py'), TEXT.replace('(phone):', '(phone, *, strict):'));
  await c.onEdit('A', wa, 'django/utils/text.py');
  expect(await c.takeNotices('B')).toEqual([]);
});

test('contract notice shows how the author now calls the helper, even when that caller is ingested later', async () => {
  writeFileSync(join(wb, 'django/utils/text.py'), TEXT + '\ndef phone2numeric_clean(p):\n    return phone2numeric(p)\n');
  await c.onEdit('B', wb, 'django/utils/text.py');
  writeFileSync(join(wa, 'django/utils/text.py'), TEXT.replace('(phone):', '(phone, *, strict):'));
  await c.onEdit('A', wa, 'django/utils/text.py');
  writeFileSync(join(wa, 'django/utils/html.py'),
    'from django.utils.text import phone2numeric\n\ndef dial(n):\n    return phone2numeric(n, strict=False)\n');
  await c.onEdit('A', wa, 'django/utils/html.py');
  const [n] = await c.takeNotices('B');
  expect(n.text).toContain('A now calls it as: phone2numeric(n, strict=False)');
});

test('preEdit: C about to change A-leased signature is denied with the reason; body edit allowed', async () => {
  await c.registerAgent('C', 'claude', wb);
  const sigEdit = { file: 'django/utils/text.py', edits: [{ old: 'def phone2numeric(phone):', new: 'def phone2numeric(phone, *, strict):' }] };
  expect(await c.preEdit('A', wa, sigEdit)).toEqual({ allow: true });
  writeFileSync(join(wa, 'django/utils/text.py'), TEXT.replace('(phone):', '(phone, *, strict):'));
  await c.onEdit('A', wa, 'django/utils/text.py');
  const cSig = { file: 'django/utils/text.py', edits: [{ old: 'def phone2numeric(phone):', new: 'def phone2numeric(phone, region):' }] };
  const d = await c.preEdit('C', wb, cSig);
  expect(d.allow).toBe(false);
  expect(d.allow === false && d.reason).toContain('leased by agent A (contract');
  expect(d.allow === false && d.reason).toContain('def phone2numeric(phone, *, strict)');
  const cBody = { file: 'django/utils/text.py', edits: [{ old: '    return phone.upper()', new: '    return phone.upper().strip()' }] };
  expect(await c.preEdit('C', wb, cBody)).toEqual({ allow: true });
  expect(await c.preEdit('C', wb, { file: 'README.md', content: 'x' })).toEqual({ allow: true });
  expect(await c.preEdit('C', wb, { file: 'django/utils/text.py', edits: [{ old: 'absent', new: 'x' }] })).toEqual({ allow: true });
});
