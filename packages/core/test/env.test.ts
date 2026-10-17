// Final review I11: every claude (and test) spawn runs on the subscription login: one function strips every paid route.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { subscriptionEnv } from '../src/index.js';

test('subscriptionEnv strips every ANTHROPIC_* and the Bedrock / Vertex switches, keeps the rest', () => {
  const env = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', PATH: '/bin', HOME: '/h' };
  expect(subscriptionEnv(env)).toEqual({ PATH: '/bin', HOME: '/h' });
  expect(env.ANTHROPIC_API_KEY).toBe('k');   // a copy, the caller's env untouched
});

test('no package builds a spawn env by hand: the only ANTHROPIC_ in sources is subscriptionEnv', () => {
  const pk = join(__dirname, '..', '..');
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);
  const hits = readdirSync(pk).flatMap((p) => { try { return walk(join(pk, p, 'src')); } catch { return []; } })
    .filter((f) => /\.tsx?$/.test(f) && /ANTHROPIC_|CLAUDE_CODE_USE_/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(pk.length + 1));
  expect(hits).toEqual(['core/src/env.ts']);
});
