// E4 hook slice (plan 02 Task 6 Step 3): wall-clock latency of the real hook process per event, plus the same POST
// over fetch (daemon only) to separate node startup. Needs the daemon up (`loom up`). Gate: every event p95 < 150 ms total.
import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK = join(ROOT, 'packages/hook/dist/loom-hook.cjs');
const SRC = join(ROOT, 'bench/cache/django-src');
const URL = process.env.LOOM_URL ?? 'http://127.0.0.1:4318';
const N = Number(process.env.E4_N ?? 100);
const run = `coord:e4:${Date.now()}`, agent = 'E4';
const F = 'django/utils/text.py';

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.text();
};

const wt = mkdtempSync(join(tmpdir(), 'loom-e4-'));
mkdirSync(join(wt, 'django/utils'), { recursive: true });
copyFileSync(join(SRC, F), join(wt, F));
const g = (...a: string[]) => execFileSync('git', a, { cwd: wt, stdio: 'ignore' });
g('init', '-q'); g('add', '.'); g('-c', 'user.email=e4@loom', '-c', 'user.name=e4', 'commit', '-qm', 'base');
const BASE = readFileSync(join(wt, F), 'utf8');
const BODIES = ['    return x[0].upper() + x[1:]', '    return x[:1].upper() + x[1:]'];

console.error('indexing base…');
await post('/admin/runs', { run, root: SRC, dirs: ['django'], baseKey: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SRC, encoding: 'utf8' }).trim() });
await post('/admin/agents', { run, agent, harness: 'claude', worktree: wt });

const common = { cwd: wt, session_id: 'e4-session' };
const fixtures: Record<string, (i: number) => { event: string; input: Record<string, unknown> }> = {
  'PreToolUse Edit': (i) => (writeFileSync(join(wt, F), BASE.replace(BODIES[0], BODIES[i % 2])), { event: 'PreToolUse', input: { hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: join(wt, F), old_string: BODIES[i % 2], new_string: BODIES[(i + 1) % 2] } } }),
  'PostToolUse Read': () => ({ event: 'PostToolUse', input: { hook_event_name: 'PostToolUse', tool_name: 'Read',
    tool_input: { file_path: join(wt, F) }, tool_response: {} } }),
  'PostToolUse Edit': (i) => {
    writeFileSync(join(wt, F), BASE.replace(BODIES[0], BODIES[(i + 1) % 2]));
    return { event: 'PostToolUse', input: { hook_event_name: 'PostToolUse', tool_name: 'Edit',
      tool_input: { file_path: join(wt, F) }, tool_response: {} } };
  },
  UserPromptSubmit: () => ({ event: 'UserPromptSubmit', input: { hook_event_name: 'UserPromptSubmit', prompt: 'go on' } }),
  Stop: () => ({ event: 'Stop', input: { hook_event_name: 'Stop', stop_hook_active: false } }),
};

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const stats = (xs: number[]) => ({ p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: +Math.max(...xs).toFixed(1) });
const env = { ...process.env, LOOM_URL: URL, LOOM_RUN: run, LOOM_AGENT: agent };

await post('/hook/claude/SessionStart', { hook_event_name: 'SessionStart', ...common }, { 'x-loom-agent': agent, 'x-loom-run': run });
const out: Record<string, { total: ReturnType<typeof stats>; daemon: ReturnType<typeof stats> }> = {};
for (const [name, fx] of Object.entries(fixtures)) {
  const total: number[] = [], daemon: number[] = [];
  for (let i = 0; i < N; i++) {
    const { event, input } = fx(i);
    const t0 = performance.now();
    const r = spawnSync('node', [HOOK, 'claude', event], { input: JSON.stringify({ ...common, ...input }), env, encoding: 'utf8' });
    total.push(performance.now() - t0);
    if (r.status !== 0 || r.stderr.includes('unreachable')) throw new Error(`${name}: ${r.stderr}`);
    const { event: e2, input: in2 } = fx(i + 1);
    const t1 = performance.now();
    await post(`/hook/claude/${e2}`, { ...common, ...in2 }, { 'x-loom-agent': agent, 'x-loom-run': run });
    daemon.push(performance.now() - t1);
  }
  out[name] = { total: stats(total), daemon: stats(daemon) };
  console.error(name, JSON.stringify(out[name]));
}
await post('/release', { run, agent });

const pass = Object.values(out).every((v) => v.total.p95 < 150);
mkdirSync(join(ROOT, 'bench/results'), { recursive: true });
writeFileSync(join(ROOT, 'bench/results/e4-hooks.json'), JSON.stringify({ n: N, run, pass, events: out }, null, 2) + '\n');
console.log(JSON.stringify({ pass, events: out }));
