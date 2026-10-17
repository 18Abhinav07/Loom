// P3 Task 3: the 12 spec tools over MCP, proxied to a real daemon (plan 03 Task 3).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { startServer } from '../../daemon/src/server.js';
import { createLoomMcp } from '../src/loom-mcp.js';

const F = 'django/utils/text.py';
const SID = `${F}::phone2numeric`;
const TEXT = 'def phone2numeric(phone):\n    return phone.upper()\n';
const run = `test:mcp:${Date.now()}`;
let db: LoomDb; let srv: Awaited<ReturnType<typeof startServer>>; let url: string;

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-mcp-'));
  mkdirSync(join(d, dirname(F)), { recursive: true }); writeFileSync(join(d, F), TEXT);
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'base');
  return d;
}

async function client(agent: string, runId = run) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createLoomMcp({ url, agent, run: runId, cwd: tree() });
  await server.connect(a);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(b);
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), text: r.content[0].text as string };
};

beforeAll(async () => {
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: null, recordDir: mkdtempSync(join(tmpdir(), 'loom-rec-')) });
  url = `http://127.0.0.1:${srv.port}`;
  await fetch(`${url}/admin/runs`, { method: 'POST', body: JSON.stringify({ run, root: tree(), dirs: ['django'], baseKey: run }) });
});
afterAll(async () => { await srv.close(); await db.graph(run).drop(); await db.graph(`trace:${run}`).drop().catch(() => {}); await db.close(); });

test('3.1 twelve tools; decision, contract lease grant/deny, who_is_touching', async () => {
  const A = await client('A'); const C = await client('C');
  const names = (await A.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(['ack_notice', 'check_plan', 'claim_done', 'claim_task', 'impact', 'lease', 'lessons', 'notices', 'record_decision',
    'register', 'release', 'who_is_touching', 'why']);
  expect(JSON.parse((await call(A, 'register')).text)).toMatchObject({ ok: true });
  const d = await call(A, 'record_decision', { text: 'kw-only strict', symbols: [SID] });
  expect(JSON.parse(d.text).id).toMatch(/^D/);
  // the shapes real Sonnet workers sent (E5 pilot): `decision` for `text`, no symbols, a sentence for `how`
  const loose = await call(A, 'record_decision', { decision: 'reuse slugify' });
  expect(loose.isError).toBe(false);
  expect(JSON.parse(loose.text).id).toMatch(/^D/);
  for (const how of ['Updated slugify_filename to call slugify(name, strict=False)', 'No change needed: strict=False never raises', undefined]) {
    expect((await call(A, 'ack_notice', { id: 'n1', ...(how ? { how } : {}) })).isError).toBe(false);
  }
  expect(JSON.parse((await call(A, 'lease', { symbols: [SID], mode: 'contract' })).text)).toMatchObject({ granted: true });
  const denied = JSON.parse((await call(C, 'lease', { symbols: [SID], mode: 'contract' })).text);
  expect(denied.granted).toBe(false);
  expect(denied.holders[0].holder).toBe('A');
  expect((await call(C, 'who_is_touching', { path_or_symbol: F })).text).toContain('"A"');
  expect((await call(A, 'why', { symbol: SID })).text).toContain(SID);
  await fetch(`${url}/lessons`, { method: 'POST', body: JSON.stringify({ symbols: [SID], text: 'strict is keyword-only', run }) });
  expect(JSON.parse((await call(A, 'lessons', { scope: SID })).text)).toMatchObject([{ id: `manual:${SID}`, text: 'strict is keyword-only' }]);
});

test('B3 check_plan: the plan text is checked against the caller\'s repo; outside a Loom repo it is a tool error', async () => {
  const A = await client('A');
  const r = await call(A, 'check_plan', { text: '---\ngoal: g\ntasks: []\n---\n' });
  expect(r.isError).toBe(true);   // tree() is a plain git repo, not loom init'd
  expect(r.text).toContain('not a Loom repo');
});

test('3.2 an unknown run is a tool error, and the session keeps working', async () => {
  const X = await client('X', 'no-such-run');
  const r = await call(X, 'notices');
  expect(r.isError).toBe(true);
  expect(r.text).toContain('run not loaded');
  expect((await call(X, 'lessons')).isError).toBe(true);
  expect((await X.listTools()).tools).toHaveLength(13);
});
