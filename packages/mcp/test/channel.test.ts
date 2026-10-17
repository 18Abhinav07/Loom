// B3 §3.3: the built loom-mcp is a Claude Code channel: it registers its push port with the daemon, pushes dashboard messages
// into the session as notifications/claude/channel, and forwards permission requests.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { wantsChannel } from '../src/loom-mcp.js';

const BIN = resolve(__dirname, '../dist/loom-mcp.cjs');
const TOKEN = 'a'.repeat(32);
const seen: { path: string; headers: any; body: any }[] = [];
let daemon: Server; let child: ChildProcess; let out = '';

const until = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); return f(); };
const rpc = (m: object) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

beforeAll(async () => {
  daemon = createServer((req, res) => {   // the test's stand-in for the daemon
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      seen.push({ path: req.url!, headers: req.headers, body: b ? JSON.parse(b) : null });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', () => r()));
  const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'token'), TOKEN);
  child = spawn(process.execPath, [BIN], { env: { ...process.env, LOOM_URL: `http://127.0.0.1:${(daemon.address() as any).port}`, LOOM_HOME: home, LOOM_AGENT: '', LOOM_RUN: '', LOOM_LEAD: '1' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => { out += d; });
  rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  await until(() => out.includes('"id":1'));
  rpc({ method: 'notifications/initialized' });
});
afterAll(() => { child?.kill(); daemon?.close(); });

test('declares the channel capabilities and tells Claude how dashboard messages arrive', () => {
  const init = JSON.parse(out.split('\n').find((l) => l.includes('"id":1'))!);
  expect(init.result.capabilities.experimental).toEqual({ 'claude/channel': {}, 'claude/channel/permission': {} });
  expect(init.result.instructions).toContain('<channel source="loom" from="dashboard">');
});

test('registers {pid, port, secret, cwd} with the token; the push port checks the secret and pushes a channel notification', async () => {
  expect(await until(() => seen.some((s) => s.path === '/channels'))).toBe(true);
  const reg = seen.find((s) => s.path === '/channels')!;
  expect(reg.headers['x-loom-token']).toBe(TOKEN);
  expect(reg.body).toMatchObject({ pid: process.pid, cwd: process.cwd() });
  expect(reg.body.secret).toMatch(/^[0-9a-f]{32}$/);
  const push = (path: string, b: object) => fetch(`http://127.0.0.1:${reg.body.port}${path}`, { method: 'POST', body: JSON.stringify(b) });

  expect((await push('/push', { secret: 'wrong', content: 'x', meta: {} })).status).toBe(403);
  expect(out).not.toContain('"x"');
  expect((await push('/push', { secret: reg.body.secret, content: 'hello lead', meta: { from: 'dashboard' } })).status).toBe(200);
  expect(await until(() => out.includes('notifications/claude/channel"'))).toBe(true);
  const n = JSON.parse(out.split('\n').find((l) => l.includes('notifications/claude/channel"'))!);
  expect(n.params).toEqual({ content: 'hello lead', meta: { from: 'dashboard' } });

  expect((await push('/permission', { secret: reg.body.secret, request_id: 'abcde', behavior: 'allow' })).status).toBe(200);
  expect(await until(() => out.includes('notifications/claude/channel/permission"'))).toBe(true);
  expect(JSON.parse(out.split('\n').find((l) => l.includes('notifications/claude/channel/permission"'))!).params).toEqual({ request_id: 'abcde', behavior: 'allow' });
});

test('a permission request from Claude is forwarded to the daemon with the pid', async () => {
  rpc({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'qwert', tool_name: 'Bash', description: 'list', input_preview: 'ls' } });
  expect(await until(() => seen.some((s) => s.path === '/channels/permission'))).toBe(true);
  expect(seen.find((s) => s.path === '/channels/permission')!.body).toEqual({ pid: process.pid, request_id: 'qwert', tool_name: 'Bash', description: 'list', input_preview: 'ls' });
});

// Final review I2: a plain `claude` (no channel flag) also starts loom-mcp; it must not register a channel the session cannot read.
test('only the lead (LOOM_LEAD=1, set by loom lead) opens a channel; plain terminals and headless agents do not', () => {
  expect(wantsChannel({ LOOM_LEAD: '1' })).toBe(true);
  expect(wantsChannel({})).toBe(false);
  expect(wantsChannel({ LOOM_LEAD: '1', LOOM_AGENT: 'a1' })).toBe(false);
  expect(wantsChannel({ LOOM_LEAD: '1', LOOM_CHANNEL: '0' })).toBe(false);
});
