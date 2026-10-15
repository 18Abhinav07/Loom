import { expect, test } from 'vitest';
import { indexPython, diffFile } from '@loom/indexer';
import { renderNotice, score, THRESHOLD } from '../src/notice.js';

test('scores: direct read of a contract change delivers; 2-hop read of a behavior change does not', () => {
  expect(score('READ', 0, 'contract')).toBeCloseTo(0.72);
  expect(score('EDITED', 1, 'behavior')).toBeGreaterThanOrEqual(THRESHOLD);
  expect(score('READ', 2, 'behavior')).toBeLessThan(THRESHOLD);
});

test('contract notice names agent, before/after and dependency path, under ~130 tokens', async () => {
  const a = await indexPython('django/utils/text.py', 'def phone2numeric(phone):\n    return phone\n');
  const b = await indexPython('django/utils/text.py', 'def phone2numeric(phone, *, strict):\n    return phone\n');
  const [ch] = diffFile(a, b);
  const text = renderNotice('A', ch, { rel: 'EDITED', hops: 1, path: ['phone2numeric_clean', 'phone2numeric'] });
  expect(text).toContain('agent A');
  expect(text).toContain('before: def phone2numeric(phone)');
  expect(text).toContain('after:  def phone2numeric(phone, *, strict)');
  expect(text).toContain('phone2numeric_clean → phone2numeric');
  expect(text.split(/\s+/).length).toBeLessThan(110);
});

test('rettype: same signature text, new return wrapper → notice shows the body change and the new class (G1b live failures)', async () => {
  const doc = '    """\n    Return the given string converted to a string that can be used for a clean\n    filename. Remove leading and trailing spaces; convert other spaces to\n    underscores; and remove anything that is not an alphanumeric, dash,\n    underscore, or dot.\n    """\n';
  const before = '@keep_lazy_text\ndef get_valid_filename(name):\n' + doc + '    s = str(name).strip()\n    return s\n';
  const after = 'class _CoordT:\n    __slots__ = ("text",)\n\n    def __init__(self, text):\n        self.text = text\n\n\n'
    + '@keep_lazy_text\ndef _get_valid_filename_impl(name):\n' + doc + '    s = str(name).strip()\n    return s\n\n\n'
    + 'def get_valid_filename(name):\n    return _CoordT(_get_valid_filename_impl(name))\n';
  const f = 'django/utils/text.py';
  const [ch] = diffFile(await indexPython(f, before), await indexPython(f, after)).filter((c) => c.symbol.qname === 'get_valid_filename');
  expect(ch.kind === 'contract' || ch.kind === 'behavior').toBe(true);
  const t = renderNotice('A', ch, { rel: 'READ', hops: 0, path: [] });
  expect(ch.kind).toBe('contract');                                        // decorator moved: sigHash differs, sig text does not
  expect(t).toContain('+     return _CoordT(_get_valid_filename_impl(name))');
  expect(t).toContain('class _CoordT:');
  expect(t).not.toContain('alphanumeric');                                  // docstrings are noise in a notice
});
