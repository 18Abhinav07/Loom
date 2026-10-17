// loom init | lead | up | down | status | why | verify | lesson — attach a repo to Loom, start the lead, and run the daemon for plain `claude` sessions.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LoomDb, type LoomGraph } from '@loom/core';
import { loadPlan } from '@loom/planner';
import { regionsCmd } from './regions.js';
import { exitCode, runPlan } from './run.js';
import { teamCmd } from './team.js';
import { resolveAttach, resolveRepo } from '@loom/daemon';
import { addLesson, DEFAULT_EXCLUDES, ensureLoomDir, finishSession, gitTry, graphName, importSessions, indexRepo, installGitHooks, lessonsFor,
  postCommit, preCommit, readActive, readConfig, reconcile, repoId, sync, type LoomConfig } from '@loom/memory';
import { detectCompile, detectLangs, sourceDirs } from './detect.js';
import { startLead } from './lead.js';

const DAEMON = process.env.LOOM_URL ?? 'http://127.0.0.1:4318';
const UI = process.env.LOOM_UI ?? 'http://127.0.0.1:4317';
const HOME = join(homedir(), '.loom');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
/** fetch threw: the daemon is down only when the connection was refused; a long verify can also hit the 300 s client timeout. */
function failed(e: unknown): number {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  console.error(code === 'ECONNREFUSED' ? 'daemon not running (run loom up)' : `daemon request failed: ${code ?? (e as Error).message} (the daemon may still be working; see loom status)`);
  return 1;
}
const loomRoot = () => resolve(__dirname, '..', '..', '..');                    // packages/cli/dist -> repo root (cjs bundle only)

export { exclude, mergeHooks, pyDirs } from '@loom/daemon';
import { exclude, mergeHooks, pyDirs } from '@loom/daemon';

/** The test command a run verifies with, guessed from the repo's own manifests; null when there is none. */
export function detectTestCmd(root: string): string | null {
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.cfg'))) return 'python -m pytest -q';
  const pj = join(root, 'package.json');
  try { if (existsSync(pj) && JSON.parse(readFileSync(pj, 'utf8')).scripts?.test) return 'npm test'; } catch { /* not JSON */ }
  if (existsSync(join(root, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(root, 'Cargo.toml'))) return 'cargo test -q';
  return null;
}

/** §6.1: repoId, .loom/, regions + lock + baseline, git hooks, Claude hooks, then whatever sessions the clone already carries. */
export interface InitSummary { files: number; regions: Record<string, number>; degraded: number; sessions: number; people: number;
  last: number | null; compile: string | null; test: string | null }
const IDENT = (root: string) => (gitTry(root, 'config', 'user.email') ? [] : ['-c', 'user.name=Loom', '-c', 'user.email=loom@localhost']);
/** The Loom files a teammate needs: config, lock, merge attributes and the session records. Run scratch never goes in. */
function loomPaths(root: string): string[] {
  const paths = ['.loom/config.json', '.loom/.gitattributes', '.loom/regions.lock'].filter((p) => existsSync(join(root, p)));
  const sd = join(root, '.loom', 'sessions');
  if (existsSync(sd)) paths.push(...readdirSync(sd).filter((f) => f.endsWith('.jsonl')).map((f) => `.loom/sessions/${f}`));
  return paths;
}
/** True when some Loom file is untracked or differs from HEAD. */
function loomPending(root: string): boolean {
  const paths = loomPaths(root);
  return paths.length > 0 && git(root, 'status', '--porcelain', '--', ...paths) !== '';
}
function commitLoom(root: string): boolean {
  const paths = loomPaths(root);
  if (!paths.length) return false;
  git(root, 'add', '--', ...paths);
  if (spawnSync('git', ['diff', '--cached', '--quiet', '--', ...paths], { cwd: root }).status === 0) return false;
  execFileSync('git', [...IDENT(root), 'commit', '-q', '-m', 'loom: init', '--', ...paths], { cwd: root, stdio: 'ignore' });
  return true;
}

/** A [Y/n] question on the terminal; Enter means yes. */
export async function askYes(q: string): Promise<boolean> {
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  try { return !/^n/i.test((await rl.question(q)).trim()); } finally { rl.close(); }
}
const STATE = { A: 'no commits yet: made a first commit, then set Loom up', B: 'set Loom up for the first time', C: 'Loom was already set up here: caught up and checked it' };
export function printSummary(r: { state: 'A' | 'B' | 'C'; committed: boolean; pending: boolean; summary: InitSummary; config: string; settings: string }): string {
  const s = r.summary;
  const regions = Object.entries(s.regions).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ') || 'none';
  return [`state ${r.state}: ${STATE[r.state]}`, `config  ${r.config}`, `hooks   ${r.settings}`,
    `files ${s.files} · regions ${regions} · degraded ${s.degraded}`,
    `sessions ${s.sessions} · people ${s.people} · last activity ${s.last ? new Date(s.last).toISOString() : 'none'}`,
    `test ${s.test ?? 'none found'} · compile ${s.compile ?? 'none'}`, r.committed ? 'committed .loom/' : r.pending ? '.loom/ not committed' : '.loom/ up to date in git'].join('\n');
}

/** Files the state-A first commit never takes: env files (not their .example/.sample/.template), keys, OS litter. */
const SECRET_FILE = /(^|\/)(\.env(?!\.(example|sample|template)$)(\..+)?|[^/]+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|\.DS_Store)$/;

export async function initRepo(cwd: string, o: { hookCmd: string; mcpPath?: string; loomCmd: string; tenant?: string; testCmd?: string; db?: LoomDb;
  /** Commit .loom/ when init is done. Undefined means no. */ commit?: boolean }) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (git(common, 'rev-parse', '--is-bare-repository') === 'true')
    throw new Error(`${common} is a bare repository: loom needs a normal clone (its checkout is the base it indexes)`);
  const mainRoot = dirname(common);
  const hasHead = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: mainRoot }).status === 0;
  const state: 'A' | 'B' | 'C' = !hasHead ? 'A' : existsSync(join(mainRoot, '.loom', 'config.json')) ? 'C' : 'B';
  let withheld: string[] = [];
  if (state === 'A') {   // no commits yet: the repo id is its first commit, so make one from what is here, never with secrets in it
    const gi = join(mainRoot, '.gitignore');
    if (!existsSync(gi)) writeFileSync(gi, 'node_modules/\n.venv/\n__pycache__/\n.env\n.env.*\n!.env.example\n*.pem\n*.key\n.DS_Store\n');
    git(mainRoot, 'add', '-A');
    withheld = git(mainRoot, 'diff', '--cached', '--name-only').split('\n').filter((f) => SECRET_FILE.test(f));
    if (withheld.length) git(mainRoot, 'rm', '-q', '--cached', '--', ...withheld);
    execFileSync('git', [...IDENT(mainRoot), 'commit', '-q', '--allow-empty', '-m', 'loom: initial commit'], { cwd: mainRoot, stdio: 'ignore' });
  }
  const id = repoId(mainRoot);                                                    // throws on a repo with no commits
  const cfgPath = join(mainRoot, '.loom', 'config.json');
  const hadLock = existsSync(join(mainRoot, '.loom', 'regions.lock'));
  const tracked = git(mainRoot, 'ls-files').split('\n').filter(Boolean);
  const langs = detectLangs(tracked);
  const fresh = { v: 2, repoId: id, dirs: sourceDirs(mainRoot, tracked), excludes: DEFAULT_EXCLUDES, testCmd: o.testCmd ?? detectTestCmd(mainRoot),
    compile: detectCompile(mainRoot, langs), langs, share: true, run: `coord:local:${basename(mainRoot)}`, daemon: DAEMON };
  const old = readConfig(mainRoot) as (LoomConfig & Record<string, unknown>) | null;
  if (old && old.v !== 2)   // upgrade an older config in place: its keys win, the new ones are added
    writeFileSync(cfgPath, JSON.stringify({ ...fresh, ...old, repoId: old.repoId ?? id, v: 2, langs, compile: old.compile ?? fresh.compile }, null, 2) + '\n');
  const cfg = ensureLoomDir(mainRoot, fresh as LoomConfig);
  exclude(mainRoot, ['.claude/settings.local.json', '.mcp.json']);              // .loom/ is not excluded: its records travel through git
  const db = o.db ?? await LoomDb.connect();
  try {
    const g = db.graph(o.tenant ? graphName(o.tenant, cfg.repoId) : (await resolveRepo(db, mainRoot))!.graph.name);
    const s = await indexRepo(g, mainRoot, { baseline: !hadLock });
    installGitHooks(mainRoot, o.loomCmd);
    const sp = join(top, '.claude', 'settings.local.json');
    mergeHooks(sp, o.hookCmd);
    if (o.mcpPath) {   // the loom MCP tools, merged next to whatever servers the repo already has
      const mp = join(top, '.mcp.json');
      const m = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : {};
      (m.mcpServers ??= {}).loom = { command: 'node', args: [o.mcpPath] };
      writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
      // pre-approve it: claude's own prompt defaults to "continue without", and then the lead has no channel
      const st = JSON.parse(readFileSync(sp, 'utf8'));
      st.enabledMcpjsonServers = [...new Set([...(st.enabledMcpjsonServers ?? []), 'loom'])];
      writeFileSync(sp, JSON.stringify(st, null, 2) + '\n');
    }
    await importSessions(g, mainRoot, null);
    if (hadLock) await reconcile(g, mainRoot, null, 'HEAD', 200);                // a clone of a Loom repo: catch up on what landed without us
    const [{ n: sessions }] = await g.query<{ n: number }>('MATCH (s:Session) RETURN count(s) AS n');
    const [{ n: people }] = await g.query<{ n: number }>('MATCH (p:Person) RETURN count(p) AS n');
    const text = `files: ${s.files} · regions: ${s.regions} · degraded: ${s.degraded.length} · unresolved calls: ${s.unresolved} · sessions: ${sessions} · people: ${people} · reparsed: ${s.reparsed}`;
    const byPath = await g.query<{ p: string; n: number }>('MATCH (r:Region) WHERE coalesce(r.tombstoned, false) = false RETURN r.path AS p, count(r) AS n');
    const regions: Record<string, number> = {};
    for (const { p, n } of byPath) if (p) for (const l of Object.keys(detectLangs([p]))) regions[l] = (regions[l] ?? 0) + n;
    const [{ last }] = await g.query<{ last: number | null }>('MATCH (s:Session) RETURN max(s.started) AS last');
    const summary: InitSummary = { files: s.files, regions, degraded: s.degraded.length, sessions, people, last: last ?? null,
      compile: (cfg as LoomConfig).compile ?? null, test: cfg.testCmd ?? null };
    const committed = o.commit === true && commitLoom(mainRoot);
    return { mainRoot, config: cfgPath, settings: sp, state, committed, pending: loomPending(mainRoot), summary, text, withheld };
  } finally { if (!o.db) await db.close(); }
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

/** Runs f on this repo's graph (resolved the same way the daemon does). */
async function withRepo(f: (g: LoomGraph, top: string) => Promise<number>): Promise<number> {
  let db: LoomDb;
  try { db = await LoomDb.connect(); } catch (e) { return failed(e); }
  try {
    const repo = await resolveRepo(db, process.cwd());
    if (!repo) { console.error('not a loom v2 repo (run loom init)'); return 1; }
    return await f(repo.graph, repo.top);
  } finally { await db.close(); }
}

/** `loom hook git <name>`: never blocks git. FalkorDB gets 1.5 s; without it pre-commit still versions into the session file
 * (the next import picks it up) and the other hooks skip. Errors go to stderr; the hook always exits 0. */
async function gitHook(name: string | undefined): Promise<number> {
  const cwd = process.cwd(); const top = gitTry(cwd, 'rev-parse', '--show-toplevel') ?? cwd;
  const db = await Promise.race([LoomDb.connect(), new Promise<null>((r) => setTimeout(() => r(null), 1500))]).catch(() => null);
  try {
    if (!db && name !== 'pre-commit') { console.error(`[loom] ${name}: FalkorDB unreachable; continuing`); return 0; }
    const repo = db ? await resolveRepo(db, cwd) : null;
    if (name === 'pre-commit') await preCommit(top, repo?.graph ?? null);
    else if (!repo) return 0;
    else if (name === 'post-commit') await postCommit(repo.top, repo.graph);
    else if (name === 'post-merge' || name === 'post-checkout' || name === 'post-rewrite')
      await sync(repo.graph, repo.top, { me: gitTry(repo.top, 'config', 'user.email') ?? 'unknown', fetch: false, quiet: true });
  } catch (e) { console.error(`[loom] ${name}: ${(e as Error).message}; continuing`); }
  finally { await db?.close().catch(() => {}); }
  return 0;
}

async function ensureDb(): Promise<number> {
  if (await pingDb()) return 0;
  console.log('FalkorDB not reachable; starting it with docker compose');
  try { execFileSync('docker', ['compose', '-f', join(loomRoot(), 'docker-compose.yml'), 'up', '-d', 'falkordb'], { stdio: 'inherit' }); }
  catch { console.error('could not start FalkorDB: install Docker Desktop (or run any FalkorDB on :6379) and retry'); return 1; }
  for (let i = 0; i < 30; i++) { if (await pingDb()) return 0; await sleep(1000); }
  console.error('FalkorDB did not come up in 30s'); return 1;
}

async function ensureDaemon(): Promise<number> {
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

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'regions') return regionsCmd(rest);
  if (cmd === 'init') {
    if (await ensureDb() !== 0) return 1;
    if (spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).status !== 0) {   // a brand-new folder: make it a repo so teams can branch from it
      execFileSync('git', ['init', '-q'], { cwd: process.cwd() }); console.log('not a git repo yet: ran git init here');
    }
    let r: Awaited<ReturnType<typeof initRepo>>;
    const tty = process.stdin.isTTY && process.stdout.isTTY;
    const commit = rest.includes('--commit');   // never blocks on a question: the dashboard and the Lead come first
    try {
      r = await initRepo(process.cwd(), { hookCmd: `node ${join(loomRoot(), 'packages', 'hook', 'dist', 'loom-hook.cjs')}`, commit,
        mcpPath: join(loomRoot(), 'packages', 'mcp', 'dist', 'loom-mcp.cjs'), loomCmd: `node ${join(loomRoot(), 'packages', 'cli', 'dist', 'loom.cjs')}` });
    } catch (e) { console.error(`loom init: ${(e as Error).message}`); if (process.env.LOOM_DEBUG) console.error((e as Error).stack); return 1; }
    console.log(printSummary(r));
    const dp = join(loomRoot(), 'demo', 'plans', 'django-stalebench.md'), dst = join(process.cwd(), '.loom', 'plans', 'django-stalebench.md');
    if (existsSync(join(process.cwd(), 'django', 'utils', 'text.py')) && existsSync(dp) && !existsSync(dst)) {   // the hackathon repo: ship the StaleBench task as a ready plan
      mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, readFileSync(dp)); console.log('plan   .loom/plans/django-stalebench.md (the StaleBench task; or ask the Lead for your own)');
    }
    if (r.withheld.length) console.log(`not in the first commit (secrets stay untracked): ${r.withheld.join(', ')}`);
    if (r.pending) console.log('next: commit .loom/ (it carries the regions lock and session records to teammates)');
    if (await ensureDaemon() === 0) await main(['ui', ...(tty && !rest.includes('--no-lead') ? [] : ['--no-open'])]);
    if (!tty || rest.includes('--no-lead')) { console.log('start the lead with `loom lead`'); return 0; }
    return startLead(process.cwd(), {});
  }
  if (cmd === 'lead') {
    try { return startLead(process.cwd(), { extra: rest }); } catch (e) { console.error(`loom lead: ${(e as Error).message}`); return 1; }
  }
  if (cmd === 'hook' && rest[0] === 'git') return gitHook(rest[1]);
  if (cmd === 'sync' || cmd === 'brief' || cmd === 'finish') {
    const json = rest.includes('--json');
    return withRepo(async (g, top) => {
      if (cmd === 'sync') {
        const r = await sync(g, top, { me: gitTry(top, 'config', 'user.email') ?? 'unknown', fetch: !rest.includes('--no-fetch'), quiet: json || rest.includes('--quiet') });
        if (json) console.log(JSON.stringify(r)); return 0;   // otherwise sync printed the briefing itself (unless --quiet)
      }
      if (cmd === 'brief') {
        const [m] = await g.query<{ text: string; at: number }>(`MATCH (m:Message {kind: 'briefing'}) RETURN m.text AS text, m.at AS at ORDER BY m.at DESC LIMIT 1`);
        console.log(json ? JSON.stringify(m ?? null) : m?.text ?? 'no briefing yet: run `loom sync`'); return 0;
      }
      const r = await finishSession(g, top, { commit: rest.includes('--commit') });
      console.log(json ? JSON.stringify(r ?? null) : 'session finished'); return 0;
    });
  }
  if (cmd === 'up') return (await ensureDb()) || ensureDaemon();
  if (cmd === 'down') {
    // Kill whatever answers on the port (it reports its pid), not only the pid file: a lost or stale pid file left orphans running.
    const pf = join(HOME, 'daemon.pid');
    const live = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json() as Promise<{ pid?: number }>).catch(() => null);
    const pids = [live?.pid, existsSync(pf) ? Number(readFileSync(pf, 'utf8')) : undefined].filter((p): p is number => Boolean(p));
    rmSync(pf, { force: true });
    if (!pids.length) { console.log('not running'); return 0; }
    for (const p of pids) { try { process.kill(p); } catch { /* already gone */ } }
    for (let i = 0; i < 20 && await healthy(); i++) await sleep(250);
    if (await healthy()) { console.error(`daemon on ${DAEMON} did not stop`); return 1; }
    console.log('stopped'); return 0;
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
    // v2: a repo with a repoId keeps lessons on its region graph; --symbol/--run (or a v1 config) keep the v1 daemon path
    const v2 = !args.includes('--symbol') && !args.includes('--run') && readConfig(dirname(gitTry(process.cwd(), 'rev-parse', '--path-format=absolute', '--git-common-dir') ?? '.'))?.repoId;
    if (v2 && (sub === 'add' || sub === 'list' || !sub)) return withRepo(async (g, top) => {
      const pos = args.filter((x) => !x.startsWith('--'));
      if (sub === 'add') {
        if (pos.length < 2) { console.error('usage: loom lesson add <region> "<text>"'); return 1; }
        const l = await addLesson(g, top, readActive(top), pos[0], pos.slice(1).join(' '), 'manual');
        console.log(args.includes('--json') ? JSON.stringify(l) : `added to ${pos[0]}`); return 0;
      }
      const ls = pos[0] ? await lessonsFor(g, [pos[0]], 50)
        : await g.query<{ id: string; text: string; region: string }>('MATCH (l:Lesson)-[:ON]->(r:Region) RETURN l.id AS id, l.text AS text, r.id AS region ORDER BY l.at');
      if (args.includes('--json')) console.log(JSON.stringify(ls));
      else table('lessons', ['region', 'text'], (ls as any[]).map((l) => [String(l.region ?? pos[0] ?? ''), String(l.text)]));
      return 0;
    });
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
        const r = await j(await fetch(`${DAEMON}/lessons?id=${encodeURIComponent(pos[0])}&run=${encodeURIComponent(flag(args, '--run') ?? resolveAttach(process.cwd())?.run ?? '')}`, { method: 'DELETE' }));
        console.log(r.removed ? 'removed' : 'no such lesson'); return r.removed ? 0 : 1;
      }
      if (sub === 'list' || !sub) {
        const sym = flag(args, '--symbol');
        const { lessons } = await j(await fetch(`${DAEMON}/lessons?run=${encodeURIComponent(flag(args, '--run') ?? resolveAttach(process.cwd())?.run ?? '')}${sym ? `&symbol=${encodeURIComponent(sym)}` : ''}`));
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
  if (cmd === 'plan' && ['ls', 'show', 'check'].includes(rest[0])) {   // §3.3: team plans in .loom/plans/ and the checker
    const [sub, arg] = rest;
    if (sub !== 'ls' && !arg) { console.error(`usage: loom plan ${sub} <slug${sub === 'check' ? ' | file' : ''}>`); return 1; }
    const cwd = process.cwd();
    let r: Response;
    try {
      r = sub === 'ls' ? await fetch(`${DAEMON}/plans?cwd=${encodeURIComponent(cwd)}`)
        : sub === 'show' ? await fetch(`${DAEMON}/plans/${encodeURIComponent(arg)}?cwd=${encodeURIComponent(cwd)}`)
        : await fetch(`${DAEMON}/plans/check`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd, ...(existsSync(resolve(cwd, arg)) ? { file: arg } : { slug: arg }) }) });
    } catch (e) { return failed(e); }
    const j = await r.json();
    if (!r.ok) { console.error(j.error); return 1; }
    if (sub === 'ls') { table('plans (.loom/plans/)', ['slug', 'tasks', 'goal'], j.map((p: any) => [p.slug, String(p.tasks), p.goal.slice(0, 70)])); return 0; }
    if (sub === 'show') { console.log(j.text); return 0; }
    for (const p of j.problems) console.log(`problem: ${p}`);
    for (const w of j.warnings) console.log(`warning: ${w}`);
    console.log(j.ok ? `ok: ${j.plan.tasks.length} task(s); a team can start from this plan` : `not ok: ${j.problems.length} problem(s); fix them before a team starts`);
    return j.ok ? 0 : 1;
  }
  if (cmd === 'plan') {   // the bench's symbol partition of a v1 plan file
    const file = flag(rest, '--plan');
    if (!file) { console.error('usage: loom plan ls | show <slug> | check <slug | file>   (bench: loom plan --plan <file> [--run R])'); return 1; }
    const req = { run: flag(rest, '--run') ?? '', cwd: process.cwd(), plan: loadPlan(file) };
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
  if (cmd === 'team') return teamCmd(rest, DAEMON);
  if (cmd === 'run') {
    const file = flag(rest, '--plan');
    if (!file) { console.error('usage: loom run --plan <file> [--model sonnet] [--blind] [--report out.json]   (--v1: the old merge-at-end flow with a v1 plan file)'); return 1; }
    if (rest.includes('--v1')) {   // the merge-at-end flow: a v1 plan file, no daemon
      const plan = loadPlan(file);
      const rep = await runPlan({ repo: plan.repo ? resolve(dirname(file), plan.repo.replace(/^~(?=\/|$)/, homedir())) : git(process.cwd(), 'rev-parse', '--show-toplevel'), plan,
        model: flag(rest, '--model'), claudeBin: flag(rest, '--claude'), maxParallel: flag(rest, '--max') ? Number(flag(rest, '--max')) : undefined,
        url: DAEMON, blind: rest.includes('--blind'), hookCmd: `node ${join(loomRoot(), 'packages', 'hook', 'dist', 'loom-hook.cjs')}`,
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
    if (!(await healthy())) { console.error('daemon not running (run loom up)'); return 1; }
    // the daemon owns the team: `loom run` is `loom team start --wait` on the plan file, in this repo
    const pass = ['--model', '--report'].flatMap((f) => (flag(rest, f) ? [f, flag(rest, f)!] : []));
    return teamCmd(['start', file, '--wait', ...(rest.includes('--blind') ? ['--blind'] : []), ...pass], DAEMON);
  }
  if (cmd === 'ui') {
    if (!(await healthy())) await ensureDaemon();
    const run = flag(rest, '--run') ?? resolveAttach(process.cwd())?.run;
    const q = new URLSearchParams({ cwd: process.cwd(), ...(run ? { run } : {}) });
    const url = `${process.env.LOOM_UI ?? 'http://127.0.0.1:4317'}/?${q}`;
    console.log(url);
    if (!rest.includes('--no-open')) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    return 0;
  }
  console.log('usage: loom init | up | down | status [--release <agent>] | why <target> [--run R] | verify [task] [--run R] | lesson add|list|rm | merge-check <a> <b> [--run R] | plan (--plan F | "goal") | team start|status|stop|merge|msg | run --plan F | ui [--run R]');
  return cmd ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
