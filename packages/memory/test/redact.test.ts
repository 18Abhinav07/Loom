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

// Final review I3: secrets that still reached committed .loom/sessions.
test('redact also covers AWS secrets and session ids, GitHub fine-grained PATs, Stripe live keys and Google API keys', () => {
  expect(redact('id ASIAABCDEFGHIJKLMNOP x')).toBe('id [redacted] x');
  expect(redact('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok')).toBe('[redacted] ok');
  expect(redact('AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"')).not.toMatch(/wJalr/);
  expect(redact('pat github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz end')).toBe('pat [redacted] end');
  expect(redact('stripe sk_live_abcdefghijklmnop1234 and rk_live_abcdefghijklmnop1234')).toBe('stripe [redacted] and [redacted]');
  expect(redact('g AIzaSyA-abcdefghijklmnopqrstuvwxyz01234 .')).toBe('g [redacted] .');
  expect(redact('a commit 3f2a9c1e0b7d4a5c6e8f9a0b1c2d3e4f5a6b7c8d stays')).toBe('a commit 3f2a9c1e0b7d4a5c6e8f9a0b1c2d3e4f5a6b7c8d stays');
});

test('envValues reads nested .env files (apps/api/.env) but not node_modules or .git', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'loom-env-'));
  mkdirSync(join(d, 'apps/api'), { recursive: true }); writeFileSync(join(d, 'apps/api/.env'), 'SECRET=nestedsecret99\n');
  mkdirSync(join(d, 'node_modules/x'), { recursive: true }); writeFileSync(join(d, 'node_modules/x/.env'), 'X=fromdependency1\n');
  const { envValues } = await import('../src/redact.js');
  expect(envValues(d)).toEqual(['nestedsecret99']);
});

test('every string an event carries is redacted on its way to .loom/sessions, with .env read fresh after it changes', async () => {
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { appendEvent, sessionFile } = await import('../src/events.js');
  const d = mkdtempSync(join(tmpdir(), 'loom-ev-'));
  appendEvent(d, 'S1', 'lead', { type: 'handoff', summary: 'I put sk-ant-api03-abcdefghijklmnop in config', open_tasks: [], open_leases: [] });
  appendEvent(d, 'S1', 'lead', { type: 'tool', name: 'Grep', target: 'ghp_abcdefghijklmnopqrstuvwxyz0123', ok: true, ms: 1 });
  writeFileSync(join(d, '.env'), 'DB_PASS=createdlater123\n');   // a .env created after the first write
  appendEvent(d, 'S1', 'lead', { type: 'turn', from: 'user', text: 'the pass is createdlater123' });
  const out = readFileSync(join(d, sessionFile(d, 'S1', 'lead')), 'utf8');
  for (const s of ['sk-ant-api03', 'ghp_abc', 'createdlater123']) expect(out).not.toContain(s);
  expect(out.match(/\[redacted\]/g)?.length).toBe(3);
});
