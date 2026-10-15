import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { expect, test } from 'vitest';

test('hook fails open within the 2 s budget when the daemon hangs', async () => {
  const s = createServer(() => {}).listen(0); const port = (s.address() as any).port;     // accepts, never answers
  const t = Date.now();
  const r = spawnSync('npx', ['tsx', 'packages/hook/src/loom-hook.ts', 'claude', 'PreToolUse'], { input: '{}', env: { ...process.env, LOOM_URL: `http://127.0.0.1:${port}` }, encoding: 'utf8' });
  s.close();
  expect(r.status).toBe(0); expect(r.stdout).toBe('');
  expect(Date.now() - t).toBeLessThan(2000 + 3000);                                       // 2 s budget + tsx start-up
}, 15000);
