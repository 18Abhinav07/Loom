// P3 Task 1: typed events over SSE, snapshot, and the API-call recording (plan 03 Task 1).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { startServer } from '../src/server.js';
import { gitTree, tmpRecord } from './helpers.js';

const F = 'django/utils/text.py';
const TEXT = 'def phone2numeric(phone):\n    return phone.upper()\n';
const DIAL = (call: string) => `${TEXT}\n\ndef dial(n):\n    return ${call}\n`;
let db: LoomDb; let srv: Awaited<ReturnType<typeof startServer>>; let url: string; let ui: string;
const run = `test:events:${Date.now()}`;
const recordDir = mkdtempSync(join(tmpdir(), 'loom-rec-'));
const wt: Record<string, string> = {};
// P6 bench launcher: a fake runner records each spawn; the test ends each process by hand
const benchRoot = mkdtempSync(join(tmpdir(), 'loom-bench-'));
const spawned: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; exit: (code: number) => void }[] = [];
const benchRunner = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
  let exit!: (code: number) => void; const done = new Promise<number>((r) => { exit = r; });
  spawned.push({ cmd, args, env: o.env, exit }); return { done };
};
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-used';
  db = await LoomDb.connect(); srv = await startServer({ port: 0, db, uiPort: 0, recordDir, benchRoot, benchRunner });
  url = `http://127.0.0.1:${srv.port}`; ui = `http://127.0.0.1:${srv.uiPort}`;
  await post('/admin/runs', { run, root: gitTree({ [F]: TEXT }), dirs: ['django'], baseKey: run });
  for (const a of ['A', 'B', 'C']) wt[a] = gitTree({ [F]: TEXT });
});
afterAll(async () => { await db.graph(run).drop(); await srv.close(); await db.graph(`trace:${run}`).drop().catch(() => {}); await db.close(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const hook = (agent: string, event: string, extra: Record<string, unknown> = {}) =>
  post(`/hook/claude/${event}`, { hook_event_name: event, cwd: wt[agent], session_id: `s-${agent}`, ...extra },
    { 'x-loom-agent': agent, 'x-loom-run': run }).then((r) => r.text());
const tool = (agent: string, event: 'PreToolUse' | 'PostToolUse', name: string, input: Record<string, unknown>) =>
  hook(agent, event, { tool_name: name, tool_input: input, ...(event === 'PostToolUse' ? { tool_response: {} } : {}) });
const write = (agent: string, text: string) => writeFileSync(join(wt[agent], F), text);

/** Read SSE `data:` lines until `until` matches or the stream ends. */
async function collect(ac: AbortController, until: (types: string[]) => boolean) {
  const r = await fetch(`${ui}/events?run=${encodeURIComponent(run)}`, { signal: ac.signal });
  const out: any[] = []; let buf = '';
  const dec = new TextDecoder();
  const reader = r.body!.getReader();
  return { headers: r.headers, done: (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) out.push(JSON.parse(line.slice(6)));
      }
      if (until(out.map((e) => e.type))) break;
    }
    return out;
  })() };
}

test('1.1 SSE carries typed events in order; every hook call is recorded', async () => {
  const ac = new AbortController();
  const s = await collect(ac, (ts) => ts.includes('lease.denied'));
  expect(s.headers.get('content-type')).toContain('text/event-stream');
  for (const a of ['A', 'B', 'C']) await hook(a, 'SessionStart');
  await tool('B', 'PostToolUse', 'Read', { file_path: join(wt.B, F) });
  write('B', DIAL('phone2numeric(n)'));
  await tool('B', 'PostToolUse', 'Edit', { file_path: join(wt.B, F) });
  await tool('A', 'PreToolUse', 'Edit', { file_path: join(wt.A, F), old_string: '(phone):', new_string: '(phone, *, strict):' });
  write('A', TEXT.replace('(phone):', '(phone, *, strict):'));
  await tool('A', 'PostToolUse', 'Edit', { file_path: join(wt.A, F) });
  await tool('B', 'PostToolUse', 'Read', { file_path: join(wt.B, 'README') });
  await tool('C', 'PreToolUse', 'Edit', { file_path: join(wt.C, F), old_string: '(phone):', new_string: '(phone, region=None):' });
  const ev = await s.done; ac.abort();

  const want = ['lease.granted', 'change.recorded', 'notice.created', 'notice.delivered', 'lease.denied'];
  const seq = ev.filter((e) => want.includes(e.type) && !(e.type === 'change.recorded' && e.data.kind !== 'contract'));
  const firsts = want.map((w) => seq.findIndex((e) => e.type === w));
  expect(firsts.every((x) => x >= 0)).toBe(true);
  expect([...firsts].sort((a, b) => a - b)).toEqual(firsts);
  expect(seq[firsts[0]].agent).toBe('A');
  expect(seq[firsts[3]].agent).toBe('B');
  expect(seq[firsts[4]]).toMatchObject({ agent: 'C', data: { holder: 'A' } });

  const lines = readFileSync(join(recordDir, run.replace(/[^\w.-]+/g, '_'), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const hooks = lines.filter((l) => l.route.startsWith('/hook/claude/'));
  expect(hooks.length).toBeGreaterThanOrEqual(9);
  expect(hooks.map((h) => h.route)).toContain('/hook/claude/PreToolUse');
  expect(lines.map((l) => l.t)).toEqual([...lines.map((l) => l.t)].sort((a, b) => a - b));
});

test('1.2 a client that disconnects is unsubscribed; the next emit does not throw', async () => {
  const ac = new AbortController();
  const s = await collect(ac, () => true);   // stop after the first chunk
  await s.done; ac.abort();
  await new Promise((r) => setTimeout(r, 100));
  expect(srv.bus.listenerCount(run)).toBe(0);
  expect(await hook('A', 'UserPromptSubmit', { prompt: 'go on' })).toBeDefined();
  const h = await fetch(`${url}/health`); expect(h.status).toBe(200);
});

test('1.3 snapshot holds the leased symbol, the lease, and all agents', async () => {
  const snap = await (await fetch(`${ui}/snapshot?run=${encodeURIComponent(run)}`)).json();
  expect(snap.nodes.map((n: any) => n.id)).toContain(`${F}::phone2numeric`);
  expect(snap.leases).toContainEqual(expect.objectContaining({ agent: 'A', symbol: `${F}::phone2numeric`, contract: true }));
  expect(snap.agents.map((a: any) => a.id)).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  // a restarted daemon has no runs in memory, but why reads the run's graph
  const fresh = await startServer({ port: 0, db, uiPort: null, recordDir });
  const w = await (await fetch(`http://127.0.0.1:${fresh.port}/why?run=${encodeURIComponent(run)}&target=${encodeURIComponent(`${F}::phone2numeric`)}`)).json();
  await fresh.close();
  expect(w.chains[0]).toMatchObject({ agent: 'A', change: { kind: 'contract' } });

  // P4 dashboard routes: timeline, why, claims, bench
  const get = (p: string) => fetch(`${ui}${p}`).then((r) => r.json());
  const q = `run=${encodeURIComponent(run)}`;
  await post('/mcp/claim_done', { args: { task: 'tA' } }, { 'x-loom-agent': 'A', 'x-loom-run': run });
  const tl = await get(`/timeline?${q}`);
  expect(tl.rows.map((r: any) => r.kind)).toEqual(expect.arrayContaining(['step', 'notice']));
  expect(tl.rows.map((r: any) => r.at)).toEqual([...tl.rows.map((r: any) => r.at)].sort((a, b) => a - b));
  expect(tl.agents).toEqual(expect.arrayContaining(['A', 'B']));
  expect((await get(`/why?${q}&target=${encodeURIComponent(`${F}::phone2numeric`)}`)).chains[0]).toMatchObject({ agent: 'A' });
  expect((await get(`/claims?${q}`)).claims).toContainEqual(expect.objectContaining({ agent: 'A', task: 'tA', state: 'UNKNOWN' }));
  expect(Object.keys(await get('/bench'))).toEqual(expect.arrayContaining(['e2', 'e4-hooks']));

  // P6 bench launcher: one run at a time, Full needs a typed confirm, the subscription only (no ANTHROPIC_* in the env)
  const bpost = (b: unknown) => fetch(`${ui}/bench/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  expect(await get('/bench/run')).toMatchObject({ state: 'idle', readOnly: false });
  expect((await bpost({ set: 'full' })).status).toBe(400);
  expect((await bpost({ set: 'nope' })).status).toBe(400);
  expect((await bpost({ set: 'core' })).status).toBe(200);
  expect((await bpost({ set: 'core' })).status).toBe(409);
  const [b0] = spawned;
  expect(b0.args.join(' ')).toMatch(/^-m e1\.run --set core --conds blind,live --model sonnet --skip-done \S+/);
  expect(Object.keys(b0.env).filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
  const out = b0.args[b0.args.length - 1];
  writeFileSync(join(out, 'records.jsonl'), [{ cond: 'blind', merged_pass: false, b_ok: true }, { cond: 'live', merged_pass: true, b_ok: true }]
    .map((r) => JSON.stringify(r)).join('\n') + '\n');
  expect(await get('/bench/run')).toMatchObject({ state: 'running', set: 'core', done: 2, total: 24, blindBroke: 1, liveBroke: 0 });
  b0.exit(0);
  await expect.poll(() => spawned.length).toBe(2);   // the report runs over the new records so Story shows them
  expect(spawned[1].args.join(' ')).toBe(`-m e1.report --records ${out}`);
  spawned[1].exit(0);
  await expect.poll(async () => (await get('/bench/run')).state).toBe('done');
});

test('1.4 replay re-sends the recording into a fresh graph through the same handlers; read-only mode allows only the replay driver', async () => {
  const dir = join(recordDir, run.replace(/[^\w.-]+/g, '_'));
  const ro = await startServer({ port: 0, db, uiPort: 0, recordDir: tmpRecord(), readOnly: true, tenant: 'public', replayRoots: [recordDir], demoRun: dir });
  const rurl = `http://127.0.0.1:${ro.port}`;
  try {
    expect((await fetch(`${rurl}/admin/runs`, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await fetch(`${rurl}/replay`, { method: 'POST', body: JSON.stringify({ dir: tmpRecord() }) })).status).toBe(403);
    const rui = `http://127.0.0.1:${ro.uiPort}`;
    expect((await fetch(`${rui}/bench/run`, { method: 'POST', body: '{"set":"core"}' })).status).toBe(403);
    expect(await (await fetch(`${rui}/bench/run`)).json()).toMatchObject({ readOnly: true });
    const demo = await (await fetch(`${rui}/demo/replay`, { method: 'POST', body: '{}' })).json();   // Story's "Watch 3 real agents"
    expect(demo.run).toMatch(/^public:replay:/);
    const r = await (await fetch(`${rurl}/replay`, { method: 'POST', body: JSON.stringify({ dir, speed: 0, wait: true }) })).json();
    expect(r.run).toMatch(/^public:replay:/);
    expect(r.failed).toEqual([]);
    const key = (ns: any[]) => ns.map((n) => `${n.author}>${n.agent}:${n.kind}:${n.id.split(":").slice(-3).join(":")}`).sort();
    const orig = await (await fetch(`${url}/runs/${encodeURIComponent(run)}/notices`)).json();
    const again = await (await fetch(`${rurl}/runs/${encodeURIComponent(r.run)}/notices`)).json();
    expect(again.length).toBeGreaterThan(0);
    expect(key(again)).toEqual(key(orig));
    const w = await (await fetch(`${rurl}/why?run=${encodeURIComponent(r.run)}&target=${encodeURIComponent(`${F}::phone2numeric`)}`)).json();
    expect(w.chains[0]).toMatchObject({ agent: 'A', change: { kind: 'contract' } });
    const nosuch = `nosuch:${Date.now()}`;                            // anonymous reads of runs it does not serve: 404, and no graph created
    const uurl = `http://127.0.0.1:${ro.uiPort}`;
    for (const u of [`${rurl}/why?run=${nosuch}&target=x`, `${uurl}/why?run=${nosuch}&target=x`, `${uurl}/timeline?run=${nosuch}`, `${uurl}/events?run=${nosuch}`])
      expect((await fetch(u)).status, u).toBe(404);
    expect((await db.list()).filter((g) => g.includes(nosuch))).toEqual([]);
    expect((await fetch(`${uurl}/timeline?run=${encodeURIComponent(r.run)}`)).status).toBe(200);
    await db.graph(r.run).drop(); await db.graph(`trace:${r.run}`).drop().catch(() => {});
  } finally { await ro.close(); }
});
