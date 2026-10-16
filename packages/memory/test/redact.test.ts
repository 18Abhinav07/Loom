import { expect, test } from 'vitest';
import { collisionId } from '../src/events.js';
import { redact, turnEvent } from '../src/redact.js';

test('redact replaces common key patterns and env values with [redacted]', () => {
  expect(redact('key sk-ant-api03-abcdefghijklmnop end')).toBe('key [redacted] end');
  expect(redact('openai sk-abcdefghijklmnopqrstuvwx')).toBe('openai [redacted]');
  expect(redact('gh ghp_abcdefghijklmnopqrstuvwxyz0123 and gho_ABCDEFGHIJKLMNOPQRSTU')).toBe('gh [redacted] and [redacted]');
  expect(redact('aws AKIAABCDEFGHIJKLMNOP.')).toBe('aws [redacted].');
  expect(redact('slack xoxb-1234567890-abc')).toBe('slack [redacted]');
  expect(redact('pem -----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY----- after')).toBe('pem [redacted] after');
  expect(redact('db pass is hunter2hunter2 ok', ['hunter2hunter2', 'short'])).toBe('db pass is [redacted] ok');
  expect(redact('a short value stays', ['short'])).toBe('a short value stays');   // env values under 8 chars are not secrets worth matching
  expect(redact('plain text, no secrets')).toBe('plain text, no secrets');
});

test('turnEvent redacts first, then caps text at 4000 with cut:true', () => {
  const t = turnEvent('user', 'x'.repeat(5000));
  expect(t).toMatchObject({ type: 'turn', from: 'user', cut: true });
  expect(t.text.length).toBe(4000);
  const s = turnEvent('claude', 'here sk-ant-api03-abcdefghijklmnop', { Bash: 2 });
  expect(s).toEqual({ type: 'turn', from: 'claude', text: 'here [redacted]', tools: { Bash: 2 } });
  // a secret straddling the cap is redacted before the cut, so no half-key is ever written
  const edge = turnEvent('user', 'y'.repeat(3990) + ' sk-ant-api03-abcdefghijklmnop');
  expect(edge.text).not.toMatch(/sk-ant/);
});

test('collision ids are deterministic over kind, sorted parties, region and version', () => {
  const p1 = { person: 'a@t', session: 'S1', agent: 'x' }, p2 = { person: 'b@t', session: 'S2', agent: 'y' };
  const a = collisionId('divergence', [p1, p2], ['a.py::f'], 'V1');
  expect(collisionId('divergence', [p2, p1], ['a.py::f'], 'V1')).toBe(a);
  expect(collisionId('divergence', [p1, p2], ['a.py::f'], 'V2')).not.toBe(a);
  expect(collisionId('lock_wait', [p1, p2], ['a.py::f'], 'V1')).not.toBe(a);
  expect(a).toMatch(/^col_[0-9a-f]{24}$/);
});

test('envValues reads .env* values of 8+ chars, quotes stripped', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'loom-env-'));
  writeFileSync(join(d, '.env'), 'API_KEY="abcdefgh1234"\nPORT=3000\n# comment\nexport TOKEN=zzzzzzzzzz\n');
  writeFileSync(join(d, '.env.local'), "DB='postgres://u:p@h/db'\n");
  writeFileSync(join(d, 'notenv'), 'X=shouldnotbeseen\n');
  const { envValues } = await import('../src/redact.js');
  expect(envValues(d).sort()).toEqual(['abcdefgh1234', 'postgres://u:p@h/db', 'zzzzzzzzzz']);
});
