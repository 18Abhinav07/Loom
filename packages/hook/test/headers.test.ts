import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { expect, test } from 'vitest';

test('hook sends x-loom-lead from LOOM_LEAD and its ppid chain in x-loom-ppids', async () => {
  let got: IncomingHttpHeaders = {};
  const s = createServer((req, res) => { got = req.headers; req.resume(); req.on('end', () => res.end('')); }).listen(0);
  const port = (s.address() as any).port;
  const child = spawn('npx', ['tsx', 'packages/hook/src/loom-hook.ts', 'claude', 'SessionStart'], { env: { ...process.env, LOOM_URL: `http://127.0.0.1:${port}`, LOOM_LEAD: '1' } });
  child.stdin.end('{}');
  await new Promise((ok) => child.on('exit', ok)); s.close();
  expect(got['x-loom-lead']).toBe('1');
  const chain = String(got['x-loom-ppids'] ?? '').split(',').filter(Boolean).map(Number);
  expect(chain.length).toBeGreaterThanOrEqual(2);
  expect(chain).toContain(process.pid);   // the test process is an ancestor of the hook (npx → tsx → node)
}, 15000);
