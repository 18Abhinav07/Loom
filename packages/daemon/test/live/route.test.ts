// P3 Task 6: real Claude hook payloads over HTTP reach `Live` — interactive sessions by repo, v2 run agents by header.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { ensureLoomDir, graphName, indexRepo, repoId } from '@loom/memory';
import { startServer } from '../../src/server.js';
import { git, gitTree, tmpRecord } from '../helpers.js';

const A_PY = 'def f(x):\n    return x\n\n\ndef g():\n    return f(1)\n\n\ndef k():\n    return 0\n';
const T_PY = 'from a import f\n\n\ndef test_f():\n    assert f(1) == 1\n';
const F = 'a.py::f::definition#0';

let db: LoomDb; let srv: Awaited<ReturnType<typeof startServer>>; let url: string;
const drop: LoomGraph[] = [];
beforeAll(async () => { db = await LoomDb.connect(); srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord() }); url = `http://127.0.0.1:${srv.port}`; });
afterAll(async () => { await srv.close(); await db.close(); });
afterEach(async () => { for (const g of drop.splice(0)) await g.drop().catch(() => {}); });

/** One tenant per test: fixture repos made in the same second share a root commit, so the same repoId. */
const home = (tenant: string) => { const h = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(h, 'config.json'), JSON.stringify({ tenant })); return h; };
const read = (wt: string, f = 'a.py') => readFileSync(join(wt, f), 'utf8');

type Hdr = Record<string, string>;
async function hook(ev: string, cwd: string, hdr: Hdr, extra: object = {}) {
  const t0 = Date.now();
  const r = await fetch(`${url}/hook/claude/${ev}`, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify({ hook_event_name: ev, cwd, ...extra }) });
  const text = await r.text();
  return { status: r.status, ms: Date.now() - t0, json: text ? JSON.parse(text) : null };
}
const edit = (wt: string, old: string, nu: string, f = 'a.py') => ({ tool_name: 'Edit', tool_input: { file_path: join(wt, f), old_string: old, new_string: nu } });
const deny = (j: any) => j?.hookSpecificOutput?.permissionDecision === 'deny' ? String(j.hookSpecificOutput.permissionDecisionReason) : null;
const ctx = (j: any) => j?.hookSpecificOutput?.additionalContext as string | undefined;
/** Apply an Edit the way Claude would after an allow. */
const apply = (wt: string, old: string, nu: string, f = 'a.py') => writeFileSync(join(wt, f), read(wt, f).replace(old, nu));

/** One loom repo (repoId set, indexed) and two worktrees of it: two interactive sessions A and B. */
async function interactive() {
  const r = gitTree({ 'a.py': A_PY, 'tests/test_a.py': T_PY });
  const cfg = ensureLoomDir(r, { repoId: repoId(r), dirs: ['.'], excludes: [], testCmd: null, share: true });
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'loom init');
  const tenant = `rt${Math.random().toString(36).slice(2, 8)}`;
  const h = home(tenant);
  const g = db.graph(graphName(tenant, cfg.repoId)); drop.push(g);
  await indexRepo(g, r, { baseline: true });
  const wb = mkdtempSync(join(tmpdir(), 'loom-wb-')); git(r, 'worktree', 'add', '-q', '--detach', wb);
  const A = { cwd: r, hdr: { 'x-loom-home': h }, sid: 'aaaaaaaa-1111' };
  const B = { cwd: wb, hdr: { 'x-loom-home': h }, sid: 'bbbbbbbb-2222' };
  for (const s of [A, B]) await hook('SessionStart', s.cwd, s.hdr, { session_id: s.sid });
  return { r, g, A, B };
}
const on = (s: { cwd: string; hdr: Hdr; sid: string }, ev: string, extra: object = {}) => hook(ev, s.cwd, s.hdr, { session_id: s.sid, ...extra });

test('two interactive sessions: B\'s PreToolUse on A\'s leased region → deny JSON naming A, within 2 s', async () => {
  const { A, B } = await interactive();
  expect(deny((await on(A, 'PreToolUse', edit(A.cwd, 'return x', 'return x + 1'))).json)).toBeNull();
  const d = await on(B, 'PreToolUse', edit(B.cwd, 'return x', 'return x * 2'));
  expect(d.status).toBe(200);
  expect(d.ms).toBeLessThan(2000);
  expect(deny(d.json)).toContain('agent claude-aaaaaaaa');
});

test('PostToolUse on A (contract change of f) → B, holding g, gets the notice as additionalContext on its next hook', async () => {
  const { A, B } = await interactive();
  expect(deny((await on(B, 'PreToolUse', edit(B.cwd, 'return f(1)', 'return f(2)'))).json)).toBeNull();
  apply(B.cwd, 'return f(1)', 'return f(2)');
  await on(B, 'PostToolUse', edit(B.cwd, 'return f(1)', 'return f(2)'));
  expect(deny((await on(A, 'PreToolUse', edit(A.cwd, 'def f(x):', 'def f(x, y=0):'))).json)).toBeNull();
  apply(A.cwd, 'def f(x):', 'def f(x, y=0):');
  const pa = await on(A, 'PostToolUse', edit(A.cwd, 'def f(x):', 'def f(x, y=0):'));
  expect(ctx(pa.json) ?? '').not.toContain('agent claude-aaaaaaaa changed');   // RC6: never to the author
  const pb = await on(B, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: join(B.cwd, 'a.py') } });
  expect(ctx(pb.json)).toContain('agent claude-aaaaaaaa changed f');
  expect(ctx(pb.json)).toContain('after:  f(x, y=0)');
});

test('Bash PostToolUse after a script write → unleased_write notice to the other session', async () => {
  const { A, B } = await interactive();
  expect(deny((await on(B, 'PreToolUse', edit(B.cwd, 'return f(1)', 'return f(2)'))).json)).toBeNull();
  await on(A, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sed -i s/x/x/ a.py' } });
  apply(A.cwd, 'def f(x):', 'def f(x, z=1):');
  await on(A, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'sed -i s/x/x/ a.py' } });
  const pb = await on(B, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: join(B.cwd, 'a.py') } });
  expect(ctx(pb.json)).toContain('without a lease');
});

test('SessionEnd releases A\'s leases; B\'s retry is allowed', async () => {
  const { A, B } = await interactive();
  await on(A, 'PreToolUse', edit(A.cwd, 'return x', 'return x + 1'));
  expect(deny((await on(B, 'PreToolUse', edit(B.cwd, 'return x', 'return x * 2'))).json)).not.toBeNull();
  expect((await on(A, 'SessionEnd')).status).toBe(200);
  expect(deny((await on(B, 'PreToolUse', edit(B.cwd, 'return x', 'return x * 2'))).json)).toBeNull();
});

test('MCP who_is_touching names the session holding the region', async () => {
  const { A } = await interactive();
  await on(A, 'PreToolUse', edit(A.cwd, 'return x', 'return x + 1'));
  const r = await (await fetch(`${url}/mcp/who_is_touching`, { method: 'POST', headers: { 'content-type': 'application/json', ...A.hdr },
    body: JSON.stringify({ cwd: A.cwd, args: { path_or_symbol: 'a.py' } }) })).json();
  expect(r.ok).toBe(true);
  expect(JSON.stringify(r.result)).toContain('claude-aaaaaaaa');
});

/** A v2 run on a repo with no repoId: the daemon indexes the run's own graph; agents x and y in their own worktrees. */
async function v2run() {
  const r = gitTree({ 'a.py': A_PY, 'tests/test_a.py': T_PY });
  const run = `rt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const landed = `loom/${run.slice(-8)}/landed`;
  git(r, 'branch', landed);
  drop.push(db.graph(run));
  const reg = await fetch(`${url}/admin/v2/runs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run, repo: r, landed, dirs: ['.'], test: null }) });
  expect(reg.status).toBe(200);
  const wts: Record<string, string> = {};
  for (const id of ['x', 'y']) {
    wts[id] = mkdtempSync(join(tmpdir(), `loom-${id}-`));
    git(r, 'worktree', 'add', '-q', '-b', `loom/${run.slice(-8)}/${id}`, wts[id]);
    const a = await fetch(`${url}/admin/v2/agents`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run, agent: id, worktree: wts[id], task: id, title: `task ${id}`, scope: [] }) });
    expect(a.status).toBe(200);
  }
  const as = (id: string) => ({ cwd: wts[id], hdr: { 'x-loom-run': run, 'x-loom-agent': id }, sid: `${id}0000000` });
  return { r, run, landed, wts, as };
}

test('v2 run: handover runs only at the agent\'s own hook — x lands f; y\'s worktree is unchanged until y\'s next hook, then denied once with the re-read text', async () => {
  const { r, run, landed, wts, as } = await v2run();
  const [x, y] = [as('x'), as('y')];
  expect(deny((await on(x, 'PreToolUse', edit(wts.x, 'return x', 'return x + 1'))).json)).toBeNull();
  apply(wts.x, 'return x', 'return x + 1');
  await on(x, 'PostToolUse', edit(wts.x, 'return x', 'return x + 1'));
  const l = await (await fetch(`${url}/admin/v2/land`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run, agent: 'x' }) })).json();
  expect(l).toMatchObject({ status: 'landed', regions: [F] });
  expect(git(r, 'rev-parse', landed).trim()).toBe(l.sha);
  expect(read(wts.y)).toBe(A_PY);                                     // nobody ran git in y's worktree
  const d = await on(y, 'PreToolUse', edit(wts.y, 'return x', 'return x * 2'));
  expect(deny(d.json)).toContain('re-read f');
  expect(read(wts.y)).toContain('return x + 1');                      // landed work is now in y's checkout
  expect(deny((await on(y, 'PreToolUse', edit(wts.y, 'return x + 1', 'return (x + 1) * 2'))).json)).toBeNull();
});

test('v2 run: /runs/<run>/notices lists the run\'s notices (wake for a waiter) for the CLI\'s resume loop', async () => {
  const { run, wts, as } = await v2run();
  const [x, y] = [as('x'), as('y')];
  await on(x, 'PreToolUse', edit(wts.x, 'return x', 'return x + 1'));
  apply(wts.x, 'return x', 'return x + 1');
  expect(deny((await on(y, 'PreToolUse', edit(wts.y, 'return x', 'return x * 2'))).json)).not.toBeNull();
  await fetch(`${url}/admin/v2/land`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run, agent: 'x' }) });
  const ns = await (await fetch(`${url}/runs/${encodeURIComponent(run)}/notices`)).json();
  expect(ns).toEqual(expect.arrayContaining([expect.objectContaining({ agent: 'y', kind: 'wake', status: 'pending' })]));
  const t = await (await fetch(`${url}/admin/v2/take`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run, agent: 'y' }) })).json();
  expect(t.text).toContain('x');
});

test('v2 run: a notice that arrives after y\'s last tool call is delivered at y\'s Stop (block once), and the next Stop passes', async () => {
  const { wts, as } = await v2run();
  const [x, y] = [as('x'), as('y')];
  expect(deny((await on(y, 'PreToolUse', edit(wts.y, 'return f(1)', 'return f(2)'))).json)).toBeNull();
  apply(wts.y, 'return f(1)', 'return f(2)');
  await on(y, 'PostToolUse', edit(wts.y, 'return f(1)', 'return f(2)'));          // y's last tool call
  expect(deny((await on(x, 'PreToolUse', edit(wts.x, 'def f(x):', 'def f(x, y=0):'))).json)).toBeNull();
  apply(wts.x, 'def f(x):', 'def f(x, y=0):');
  await on(x, 'PostToolUse', edit(wts.x, 'def f(x):', 'def f(x, y=0):'));
  const s1 = await on(y, 'Stop', { stop_hook_active: false });
  expect(s1.json?.decision).toBe('block');
  expect(String(s1.json?.reason)).toContain('changed f');
  const s2 = await on(y, 'Stop', { stop_hook_active: true });
  expect(s2.json?.decision).toBeUndefined();
});
