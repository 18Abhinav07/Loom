// loom init | up | down | status | why | verify | lesson — attach a repo to Loom and run the daemon for plain `claude` sessions.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LoomDb } from '@loom/core';
import { loadPlan } from '@loom/planner';
import { exitCode, runPlan } from './run.js';
import { resolveAttach } from '@loom/daemon';

const DAEMON = process.env.LOOM_URL ?? 'http://127.0.0.1:4318';
const UI = process.env.LOOM_UI ?? 'http://127.0.0.1:4317';
const HOME = join(homedir(), '.loom');
const SKIP = new Set(['node_modules', 'venv', '.venv']);
const EVENTS: [string, string | undefined][] = [
  ['SessionStart', undefined], ['UserPromptSubmit', undefined], ['PreToolUse', 'Edit|Write|MultiEdit'], ['PostToolUse', '*'], ['Stop', undefined]];

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
/** fetch threw: the daemon is down only when the connection was refused; a long verify can also hit the 300 s client timeout. */
function failed(e: unknown): number {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  console.error(code === 'ECONNREFUSED' ? 'daemon not running (run loom up)' : `daemon request failed: ${code ?? (e as Error).message} (the daemon may still be working; see loom status)`);
  return 1;
}
const loomRoot = () => resolve(__dirname, '..', '..', '..');                    // packages/cli/dist -> repo root (cjs bundle only)

function hasPy(d: string): boolean {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    if (e.isFile() && e.name.endsWith('.py')) return true;
    if (e.isDirectory() && hasPy(join(d, e.name))) return true;
  }
  return false;
}

/** Top-level dirs that hold Python: the base a run indexes. */
export function pyDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name) && hasPy(join(root, e.name))).map((e) => e.name).sort();
}

/** Append lines to the repo's .git/info/exclude once each. */
export function exclude(mainRoot: string, lines: string[]) {
  const ex = join(mainRoot, '.git', 'info', 'exclude');
  mkdirSync(dirname(ex), { recursive: true });
  const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
  for (const line of lines)
    if (!cur.split('\n').includes(line)) appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/** The five Claude hooks, merged into a settings file next to whatever hooks it already has. */
export function mergeHooks(sp: string, hookCmd: string) {
  const s = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')) : {};
  s.hooks ??= {};
  for (const [ev, matcher] of EVENTS) {
    const list: { matcher?: string; hooks: { command?: string }[] }[] = (s.hooks[ev] ??= []);
    if (list.some((h) => h.hooks?.some((x) => x.command?.includes('loom-hook')))) continue;
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `${hookCmd} claude ${ev}`, timeout: 30 } as never] });
  }
  mkdirSync(dirname(sp), { recursive: true });
  writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
}

export function initRepo(cwd: string, o: { hookCmd: string; mcpPath?: string }) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (git(common, 'rev-parse', '--is-bare-repository') === 'true')
    throw new Error(`${common} is a bare repository: loom needs a normal clone (its checkout is the base it indexes)`);
  const mainRoot = dirname(common);
  const cfg = join(mainRoot, '.loom', 'config.json');
  if (!existsSync(cfg)) {
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ run: `coord:local:${basename(mainRoot)}`, dirs: pyDirs(mainRoot), daemon: DAEMON }, null, 2) + '\n');
  }
  exclude(mainRoot, ['.loom/', '.claude/settings.local.json', '.mcp.json']);
  const sp = join(top, '.claude', 'settings.local.json');
  mergeHooks(sp, o.hookCmd);
  if (o.mcpPath) {   // the loom MCP tools, merged next to whatever servers the repo already has
    const mp = join(top, '.mcp.json');
    const m = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : {};
    (m.mcpServers ??= {}).loom = { command: 'node', args: [o.mcpPath] };
    writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  }
  return { mainRoot, config: cfg, settings: sp };
}

async function healthy(): Promise<boolean> {
  try { return (await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

async function pingDb(): Promise<boolean> {
  try {
    const db = await Promise.race([LoomDb.connect(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 3000))]);
    await db.close(); return true;
  } catch { return false; }
}

const flag = (a: string[], name: string) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const age = (ms: number) => `${Math.round(ms / 1000)}s`;
function table(title: string, head: string[], rows: string[][]) {
  console.log(`\n${title}`);
  if (!rows.length) return console.log('  (none)');
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const r of [head, ...rows]) console.log('  ' + r.map((c, i) => c.padEnd(w[i])).join('  '));
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'init') {
    let r: ReturnType<typeof initRepo>;
    try {
      r = initRepo(process.cwd(), { hookCmd: `node ${join(loomRoot(), 'packages', 'hook', 'dist', 'loom-hook.cjs')}`,
        mcpPath: join(loomRoot(), 'packages', 'mcp', 'dist', 'loom-mcp.cjs') });
    } catch (e) { console.error(`loom init: ${(e as Error).message}`); return 1; }
    console.log(`wrote ${r.config}\nhooks in ${r.settings}`);
    if (!(await pingDb())) {
      console.log('FalkorDB not reachable; starting it with docker compose');
      execFileSync('docker', ['compose', '-f', join(loomRoot(), 'docker-compose.yml'), 'up', '-d', 'falkordb'], { stdio: 'inherit' });
      let ok = false;
      for (let i = 0; i < 30 && !(ok = await pingDb()); i++) await sleep(1000);
      if (!ok) { console.error('FalkorDB did not come up in 30s'); return 1; }
    }
    console.log('next: `loom up`, then run `claude` in this directory (or any of its worktrees)');
    return 0;
  }
  if (cmd === 'up') {
    if (await healthy()) { console.log('already running'); return 0; }
    mkdirSync(HOME, { recursive: true });
    const log = openSync(join(HOME, 'daemon.log'), 'a');
    const p = spawn(process.execPath, [join(loomRoot(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(loomRoot(), 'packages', 'daemon', 'src', 'server.ts')],
      { detached: true, stdio: ['ignore', log, log], cwd: loomRoot() });
    p.unref();
    writeFileSync(join(HOME, 'daemon.pid'), String(p.pid));
    for (let i = 0; i < 20; i++) { if (await healthy()) { console.log(`loom daemon up on ${DAEMON} (pid ${p.pid})`); return 0; } await sleep(500); }
    console.error(`daemon did not answer in 10s; see ${join(HOME, 'daemon.log')}`); return 1;
  }
  if (cmd === 'down') {
    const pf = join(HOME, 'daemon.pid');
    if (!existsSync(pf)) { console.log('not running'); return 0; }
    try { process.kill(Number(readFileSync(pf, 'utf8'))); } catch { /* already gone */ }
    rmSync(pf); console.log('stopped'); return 0;
  }
  if (cmd === 'status') {
    const at = resolveAttach(process.cwd());
    if (!at) { console.error('not a loom repo (run loom init)'); return 1; }
    const i = rest.indexOf('--release');
    if (i >= 0) {
      const r = await fetch(`${DAEMON}/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run: at.run, agent: rest[i + 1] }) });
      console.log(r.ok ? `released ${JSON.stringify((await r.json()).released)}` : `release failed: ${r.status}`); return r.ok ? 0 : 1;
    }
    let r: Response;
    try { r = await fetch(`${DAEMON}/status?run=${encodeURIComponent(at.run)}`); } catch (e) { return failed(e); }
    if (!r.ok) { console.log(`run ${at.run}: no session has attached yet`); return 0; }
    const s = await r.json(); const now = Date.now();
    console.log(`run ${at.run}`);
    table('agents', ['id', 'state', 'heartbeat', 'task'], s.agents.map((a: any) => [a.id, a.state, a.heartbeatAt ? age(now - a.heartbeatAt) : '-', a.taskTitle ?? '']));
    table('leases', ['agent', 'symbol', 'mode', 'expires in'], s.leases.map((l: any) => [l.agent, l.symbol, l.contract ? `${l.mode}+contract` : l.mode, age(l.expires - now)]));
    table('notices', ['agent', 'status', 'n'], s.notices.map((n: any) => [n.agent, n.status, String(n.n)]));
    table('events', ['at', 'agent', 'type'], s.events.slice(-10).map((e: any) => [new Date(e.at).toISOString().slice(11, 19), e.agent, e.type]));
    return 0;
  }
  if (cmd === 'why') {
    const target = rest.find((x, i) => !x.startsWith('--') && rest[i - 1] !== '--run');
    const run = flag(rest, '--run') ?? resolveAttach(process.cwd())?.run;
    if (!target || !run) { console.error('usage: loom why <symbol | file:line | name> [--run R]'); return 1; }
    let r: Response;
    try { r = await fetch(`${DAEMON}/why?run=${encodeURIComponent(run)}&target=${encodeURIComponent(target)}`); } catch (e) { return failed(e); }
    if (!r.ok) { console.error(`run ${run}: ${(await r.json()).error}`); return 1; }
    const w = await r.json();
    console.log(w.text);
    if (w.steps?.length) table('recent steps', ['seq', 'agent', 'tool', 'intent'], w.steps.map((s: any) => [String(s.seq), s.agent, s.tool, s.intent]));
    return w.chains.length ? 0 : 1;
  }
  if (cmd === 'lesson') {
    const [sub, ...args] = rest;
    const pos = args.filter((x, i) => !x.startsWith('--') && !['--symbol', '--run'].includes(args[i - 1]));
    const j = (r: Response) => r.json() as Promise<any>;
    try {
      if (sub === 'add') {
        const sym = flag(args, '--symbol');
        if (!sym || !pos.length) { console.error('usage: loom lesson add --symbol <file::qname> "<text>"'); return 1; }
        const l = await j(await fetch(`${DAEMON}/lessons`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ symbols: [sym], text: pos.join(' '), run: flag(args, '--run') ?? resolveAttach(process.cwd())?.run ?? '' }) }));
        console.log(`${l.id} (hits ${l.hits})`); return 0;
      }
      if (sub === 'rm') {
        if (!pos[0]) { console.error('usage: loom lesson rm <id>'); return 1; }
        const r = await j(await fetch(`${DAEMON}/lessons?id=${encodeURIComponent(pos[0])}`, { method: 'DELETE' }));
        console.log(r.removed ? 'removed' : 'no such lesson'); return r.removed ? 0 : 1;
      }
      if (sub === 'list' || !sub) {
        const sym = flag(args, '--symbol');
        const { lessons } = await j(await fetch(`${DAEMON}/lessons${sym ? `?symbol=${encodeURIComponent(sym)}` : ''}`));
        table('lessons', ['id', 'hits', 'text'], lessons.map((l: any) => [l.id, String(l.hits), l.text])); return 0;
      }
    } catch (e) { return failed(e); }
    console.error('usage: loom lesson add --symbol S "<text>" | list [--symbol S] | rm <id>'); return 1;
  }
  if (cmd === 'merge-check') {
    const [a, b] = rest.filter((x, i) => !x.startsWith('--') && rest[i - 1] !== '--run');
    const at = resolveAttach(process.cwd());
    const run = flag(rest, '--run') ?? at?.run;
    if (!a || !b || !run) { console.error('usage: loom merge-check <agentA> <agentB> [--run R]'); return 1; }
    let r: Response;
    try { r = await fetch(`${DAEMON}/merge-check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run, a, b, cwd: process.cwd(), repo: at?.mainRoot }) }); }
    catch (e) { return failed(e); }
    if (!r.ok) { console.error(`run ${run}: ${(await r.json()).error}`); return 1; }
    const m = await r.json();
    if (m.nothing) { console.log(`nothing to check: ${m.nothing}`); return 0; }
    if (m.textual) { console.log(`textual conflict: ${m.textual}`); return 1; }
    table('predicted', ['caller', 'callee', 'by', 'why'], m.predicted.map((p: any) => [p.caller, p.callee, p.by, p.reason]));
    table('at risk', ['caller', 'callee', 'why'], m.atRisk.map((p: any) => [p.caller, p.callee, p.reason]));
    table('failing tests', ['label'], m.failing.map((l: string) => [l]));
    console.log(`predicted ${m.predicted.length} · confirmed ${m.confirmed} · false positives ${m.falsePositives} · misses ${m.misses}`);
    return m.failing.length ? 1 : 0;
  }
  if (cmd === 'replay') {
    const dir = rest.find((x, i) => !x.startsWith('--') && rest[i - 1] !== '--speed');
    if (!dir) { console.error('usage: loom replay <dir> [--speed N]   (N=0: no waits)'); return 1; }
    const speed = flag(rest, '--speed');
    let r: Response;
    try { r = await fetch(`${DAEMON}/replay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: resolve(dir), rel: dir, speed: speed === undefined ? undefined : Number(speed) }) }); }
    catch (e) { return failed(e); }
    if (!r.ok) { console.error(`loom replay: ${(await r.json()).error}`); return 1; }
    const { run } = await r.json();
    console.log(`replaying into ${run}\nwatch: ${UI}/?run=${encodeURIComponent(run)}`);
    for (;;) {
      await sleep(1000);
      const p = await (await fetch(`${DAEMON}/replay?run=${encodeURIComponent(run)}`)).json();
      process.stdout.write(`\r${p.sent}/${p.total} events`);
      if (p.done) { console.log(p.failed.length ? `\n${p.failed.length} failed:\n${p.failed.join('\n')}` : '\ndone'); return p.failed.length ? 1 : 0; }
    }
  }
  if (cmd === 'verify') {
    const task = rest.find((x, i) => !x.startsWith('--') && rest[i - 1] !== '--run');
    const run = flag(rest, '--run') ?? resolveAttach(process.cwd())?.run;
    if (!run) { console.error('usage: loom verify [task] [--run R] [--no-mutate]'); return 1; }
    let r: Response;
    try { r = await fetch(`${DAEMON}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run, task, mutate: !rest.includes('--no-mutate') }) }); }
    catch (e) { return failed(e); }
    if (!r.ok) { console.error(`run ${run}: ${(await r.json()).error}`); return 1; }
    const { claims } = await r.json();
    table('claims', ['task', 'agent', 'state', 'strength', 'gap'], claims.map((c: any) => [c.task, c.agent, c.state,
      c.strength == null ? '-' : c.strength.toFixed(2), c.blindSpots?.length ? `blind: ${c.blindSpots.join(', ')}` : c.missing ?? '']));
    return claims.every((c: any) => c.state === 'VERIFIED' && !c.blindSpots?.length) ? 0 : 1;
  }
  if (cmd === 'plan') {
    const file = flag(rest, '--plan');
    const goal = rest.find((x, i) => !x.startsWith('--') && !['--plan', '--run'].includes(rest[i - 1]));
    if (!file && !goal) { console.error('usage: loom plan (--plan <file> | "<goal>") [--run R]'); return 1; }
    const req = { run: flag(rest, '--run') ?? '', cwd: process.cwd(), ...(file ? { plan: loadPlan(file) } : { goal }) };
    let r: Response;
    try { r = await fetch(`${DAEMON}/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }); }
    catch (e) { return failed(e); }
    const p = await r.json();
    if (!r.ok) { console.error(`plan failed: ${p.error}`); return 1; }
    const owns = (t: string) => Object.entries(p.hubOwner).filter(([, o]) => o === t).map(([h]) => h.split('::')[1]).join(', ');
    table('plan', ['id', 'title', 'scope', 'component', 'hub pre-grant'],
      p.tasks.map((t: any) => [t.id, t.title.slice(0, 60), String(t.scope.length), String(t.component), owns(t.id)]));
    for (const t of p.tasks) console.log(`\n${t.id}: ${t.scope.join(', ') || '(no symbols matched)'}`);
    return 0;
  }
  if (cmd === 'run') {
    const file = flag(rest, '--plan');
    if (!file) { console.error('usage: loom run --plan <file> [--model sonnet] [--claude <bin>] [--max N] [--blind] [--report out.json]'); return 1; }
    const blind = rest.includes('--blind');   // the no-Loom baseline (bench E5)
    if (!blind && !(await healthy())) { console.error('daemon not running (run loom up)'); return 1; }
    const plan = loadPlan(file);
    const rep = await runPlan({ repo: plan.repo ? resolve(dirname(file), plan.repo.replace(/^~(?=\/|$)/, homedir())) : git(process.cwd(), 'rev-parse', '--show-toplevel'), plan,
      model: flag(rest, '--model'), claudeBin: flag(rest, '--claude'), maxParallel: flag(rest, '--max') ? Number(flag(rest, '--max')) : undefined,
      url: DAEMON, blind, hookCmd: `node ${join(loomRoot(), 'packages', 'hook', 'dist', 'loom-hook.cjs')}`,
      mcpPath: join(loomRoot(), 'packages', 'mcp', 'dist', 'loom-mcp.cjs') });
    table(`run ${rep.run}`, ['agent', 'exit', 'resumed', 'commit', 'session'],
      rep.workers.map((w) => [w.agent, String(w.exit), String(w.resumed), w.commit?.slice(0, 7) ?? '-', w.sessionId ?? '-']));
    console.log(`\nmerge ${rep.merge.branch}: ${rep.merge.conflict ? `CONFLICT ${rep.merge.conflict}` : 'clean'}`
      + `; tests ${rep.merge.testsPassed === null ? 'not run' : rep.merge.testsPassed ? 'passed' : 'FAILED'}`);
    if (rep.merge.testsPassed === false) console.log(rep.merge.testOutputTail);
    const out = flag(rest, '--report');
    if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, JSON.stringify(rep, null, 2)); }
    return exitCode(rep);
  }
  if (cmd === 'ui') {
    const run = flag(rest, '--run') ?? resolveAttach(process.cwd())?.run;
    const url = `${process.env.LOOM_UI ?? 'http://127.0.0.1:4317'}/${run ? `?run=${encodeURIComponent(run)}` : ''}`;
    console.log(url);
    if (!rest.includes('--no-open')) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    return 0;
  }
  console.log('usage: loom init | up | down | status [--release <agent>] | why <target> [--run R] | verify [task] [--run R] | lesson add|list|rm | merge-check <a> <b> [--run R] | plan (--plan F | "goal") | run --plan F | ui [--run R]');
  return cmd ? 1 : 0;
}

if (process.argv[1]?.endsWith('loom.cjs')) main(process.argv.slice(2)).then((c) => process.exit(c));
