import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { LoomDb, type FileIndex, type LoomGraph } from '@loom/core';
import { contextJson, denyJson, parsePostToolUse, parsePreToolUse, stopBlockJson, type ClaudeHookInput } from './claude.js';
import { resolveAttach } from './attach.js';
import { Coordinator } from './coordinator.js';
import { Lessons } from './lessons.js';
import { mergeCheck, UnknownSide } from './mergecheck.js';
import { cfgFor } from './verify.js';
import { EventBus, Recorder } from './events.js';
import { TraceWriter } from './trace.js';
import { leadPage, passThrough } from './leadpage.js';
import { localOnly } from './guard.js';
import { Reply, startUi } from './ui.js';
import { BenchRun, type BenchRunner } from './benchrun.js';
import { checkTeamPlan, listPlans, parseTeamPlan, partition, scope, validatePlan, type PlanTask } from '@loom/planner';
import { renderWhy, why } from './why.js';
import { filePatch, replay, type ReplayProgress } from './replay.js';
import { resolveRepo } from './repo.js';
import { LiveRoutes } from './live/routes.js';
import { activeSession, finishSession, gitTry, lessonsFor, sessionBriefing, startSession } from '@loom/memory';
import { Bus } from './bus.js';
import { TeamRoutes, TEAM_TOOLS } from './team/routes.js';
import { benchCompare, brief, collab, collisions, growth, people, region, searchRegions, sessionDetail, sessions as sessionRows } from './views.js';
import { Mirror } from './mirror.js';
import { Channels } from './channels.js';
import { authorized, machineToken } from './token.js';

const PY_PATH = /[\w./-]+\.py\b/g;

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

function changedPy(cwd: string): string[] {
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' })
      .split('\n').map((l) => l.slice(3).trim()).filter((f) => f.endsWith('.py'));
  } catch { return []; }
}

const DIST = resolve(import.meta.dirname ?? '.', '../../../apps/dashboard/dist');
const BENCH = resolve(import.meta.dirname ?? '.', '../../../bench/results');
const DEMO = resolve(import.meta.dirname ?? '.', '../../../demo');

export async function startServer(opts: { port: number; db: LoomDb; uiPort?: number | null; recordDir?: string; distDir?: string; benchDir?: string;
  /** Spec §4.4 deployed mode: every write route refuses except /replay of a recording under `replayRoots`. */
  readOnly?: boolean; tenant?: string; replayRoots?: string[]; host?: string;
  /** Story's launcher and showcase: the bench dir it runs E1 in, how it spawns, the recording "Watch 3 real agents" replays. */
  benchRoot?: string; benchRunner?: BenchRunner; demoRun?: string; cwd?: string;
  /** The Loom home holding `token` (B3); tests pass a tmp dir. Default LOOM_HOME, else ~/.loom. */
  home?: string;
  /** Teams' agent binary and poll interval (tests pass the fake claude). */
  teamBin?: string; teamPoll?: number }) {
  /** C1 fixed: a run's lessons live in that run's own graph; no graph is shared between runs or tenants. P3 moves runs into the repo graph. */
  const lessonsOf = (run: string) => new Lessons(opts.db.graph(run));
  const runs = new Map<string, Coordinator>();
  const traces = new Map<string, TraceWriter>();
  const timers: NodeJS.Timeout[] = [];
  /** One place a run goes live: coordinator, TTL sweep, trace ledger. */
  const addRun = (id: string, c: Coordinator) => {
    runs.set(id, c);
    if (!traces.has(id)) traces.set(id, new TraceWriter(opts.db.graph(`trace:${id}`), id));
    const t = setInterval(() => void c.sweep().catch(() => {}), 30_000); t.unref(); timers.push(t);
  };
  const bus = new EventBus();
  const live = new LiveRoutes(opts.db);
  let teams!: TeamRoutes;   // built once the port is known
  const loomHome = opts.home ?? process.env.LOOM_HOME ?? join(homedir(), '.loom');
  const token = machineToken(loomHome);
  const leadBus = new Bus();
  const mirror = new Mirror(leadBus, async (cwd, claude) => {   // a session that started before this daemon did
    const repo = await resolveRepo(opts.db, cwd, opts.home);
    const a = repo ? activeSession(repo.top, claude) : null;
    return repo && a ? { claude, sid: a.sid, writer: a.writer, person: gitTry(repo.top, 'config', 'user.email') ?? 'unknown', repo: repo.top } : null;
  });
  const channels = new Channels(leadBus, mirror, join(loomHome, 'held'));
  /** A channel registering after a daemon restart: find the session whose SessionStart recorded this claude pid, and bind it now. */
  const rebind = async (cwd: string, pid: number) => {
    const repo = cwd ? await resolveRepo(opts.db, cwd, opts.home) : null;
    const a = repo ? activeSession(repo.top, null, [pid]) : null;
    if (!a?.claude || !a.pids?.includes(pid)) return;
    if (await mirror.get(cwd, a.claude)) channels.bind(a.claude, [pid]);
  };
  const ppidsOf = (h: IncomingMessage['headers']) => String(h['x-loom-ppids'] ?? '').split(',').map(Number).filter((n) => n > 1);
  const recorder = new Recorder(opts.recordDir ?? join(homedir(), '.loom', 'runs'));
  const record = (run: string, route: string, b: unknown) => {
    try { recorder.record(run, route, b); } catch (e) { console.error(`[loom] record failed: ${String(e)}`); }
  };
  const baseCache = new Map<string, Map<string, FileIndex>>();
  const replayToken = randomBytes(16).toString('hex');   // the replay driver's own calls pass the read-only guard
  const replays = new Map<string, ReplayProgress>();

  /** Notices, plus (SessionStart / PostToolUse, once per agent) lessons from earlier runs about what it is working on. */
  async function deliver(c: Coordinator, agent: string, event: string): Promise<string> {
    const texts = (await c.takeNotices(agent)).map((n) => n.text);
    if (event === 'SessionStart' || event === 'PostToolUse') {
      const l = await c.pendingLessons(agent).catch(() => null);
      if (l) texts.push(l);
    }
    return texts.length ? contextJson(event, texts.join('\n\n')) : '';
  }

  const loading = new Map<string, Promise<Coordinator>>();

  /** Header run (bench), else the repo's .loom config (attach mode); an attach run is created on its first hook. */
  async function runFor(header: string, cwd: string | undefined): Promise<{ c: Coordinator; root: string } | null> {
    const at = !header && cwd ? resolveAttach(cwd) : null;
    const id = header || at?.run;
    if (!id) return null;
    if (runs.has(id)) return { c: runs.get(id)!, root: at?.root ?? cwd ?? '' };
    if (!at) return null;
    if (!loading.has(id)) loading.set(id, (async () => {
      const c = await Coordinator.create(opts.db.graph(id), id, bus, lessonsOf(id));
      await c.indexBase(at.mainRoot, at.dirs);
      addRun(id, c);
      return c;
    })().finally(() => loading.delete(id)));
    return { c: await loading.get(id)!, root: at.root };
  }

  async function onHook(event: string, agent: string, c: Coordinator, input: ClaudeHookInput, root: string): Promise<string> {
    await c.touch(agent, root, input);
    if (event === 'SessionStart') { await c.checkCommit(agent, root); return deliver(c, agent, event); }
    if (event === 'UserPromptSubmit') return deliver(c, agent, event);
    if (event === 'Stop') {
      const d = await c.stopGate(agent, Boolean(input.stop_hook_active));
      return d.block ? stopBlockJson(d.reason) : '';
    }
    if (event === 'PreToolUse') {
      const it = parsePreToolUse(input, root);
      if (!it) return '';
      const d = await c.preEdit(agent, root, it);
      return d.allow ? '' : denyJson(d.reason);
    }
    if (event === 'PostToolUse') {
      const it = parsePostToolUse(input, root);
      if (it.kind === 'read' && c.knownFile(it.file)) await c.onRead(agent, it.file, it.start, it.end);
      if (it.kind === 'edit' && it.file.endsWith('.py')) await c.onEdit(agent, root, it.file);
      if (it.kind === 'bash') {
        for (const f of new Set(it.command.match(PY_PATH) ?? [])) if (c.knownFile(f)) await c.onRead(agent, f);
        for (const f of changedPy(root)) if (c.contentChanged(agent, root, f)) await c.onEdit(agent, root, f);
        await c.checkCommit(agent, root);
      }
      const tr = traces.get(c.run);
      if (tr) {
        const file = 'file' in it ? it.file : undefined;
        const symbols = file ? c.symbolsAt(agent, file, 'start' in it ? it.start : undefined, 'end' in it ? it.end : undefined) : [];
        const seq = tr.step(agent, { tool: String(input.tool_name ?? ''), intent: it.kind, symbols, file });
        c.emit('step.recorded', agent, { seq, tool: input.tool_name, intent: it.kind, file, symbols: symbols.slice(0, 20) });
      }
      return deliver(c, agent, event);
    }
    return '';
  }

  async function mcpTool(c: Coordinator, tool: string, agent: string, a: any, root: string): Promise<unknown> {
    switch (tool) {
      case 'register': await c.registerAgent(agent, a.harness ?? 'claude', root); return { ok: true, agent, run: c.run };
      case 'claim_task': await c.claimTask(agent, { id: String(a.id), title: String(a.title ?? ''), prompt: a.prompt }); return { ok: true };
      case 'lease': return c.lease(agent, a.symbols ?? [], a.mode === 'contract' ? 'contract' : 'write');
      case 'release': return { released: await c.release(agent, a.symbols) };
      case 'impact': return c.impact(String(a.symbol));
      case 'who_is_touching': return c.whoIsTouching(String(a.path_or_symbol));
      case 'notices': return c.agentNotices(agent);
      case 'ack_notice': return c.ackNotice(agent, String(a.id), /no[\s_-]*(impact|change)/i.test(String(a.how ?? '')) ? 'no-impact' : 'adapted');
      case 'record_decision': return { id: await c.recordDecision(agent, String(a.text ?? a.decision ?? ''), a.symbols ?? []) };
      case 'why': { const r = await why(opts.db.graph(c.run), String(a.symbol)); return { ...r, text: renderWhy(r) }; }
      case 'lessons': return !c.lessons ? [] : a.scope ? c.lessons.list(String(a.scope)) : c.lessons.about(await c.lessonScope(agent), 10);
      case 'claim_done': return c.claimDone(agent, String(a.task), a.evidence ?? '');
      default: throw new Error(`unknown tool ${tool}`);
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, payload: unknown) => {
      res.writeHead(code, { 'content-type': typeof payload === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    try {
      const refused = opts.readOnly ? null : localOnly(req);   // the deployed read-only daemon answers its public name
      if (refused) return send(403, { error: refused });
      const u = new URL(req.url ?? '/', 'http://x');
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET' && u.pathname === '/health') return send(200, { ok: true, runs: runs.size, readOnly: Boolean(opts.readOnly), pid: process.pid });
      const view = await viewRoute(u, parts, req);
      if (view) return send(view.status, view.body);
      if (parts[0] === 'events' || parts[0] === 'sessions' || parts[0] === 'channels') {   // B3: the lead/session surface; machine token required
        if (!authorized(req, token)) return send(401, { error: 'token required: x-loom-token or ?token= (see ~/.loom/token)' });
        if (req.method === 'GET' && parts[0] === 'events' && parts.length === 1) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          const out = (e: unknown) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(e)}\n\n`); };
          const since = u.searchParams.has('since') ? Number(u.searchParams.get('since')) : leadBus.last;
          for (const e of leadBus.since(since)) out(e);
          res.write(': ok\n\n');
          const off = leadBus.subscribe(out);
          const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000); ping.unref();
          req.on('close', () => { off(); clearInterval(ping); });
          return;
        }
        if (parts[0] === 'channels') {   // loom-mcp's push port registers here; its pid is the claude pid
          if (req.method === 'GET' && parts.length === 2) return channels.known(Number(parts[1])) ? send(200, { ok: true }) : send(404, { error: 'unknown channel' });
          const b = await body(req);
          if (req.method === 'POST' && parts.length === 1) {
            if (!(Number(b.pid) > 1 && Number(b.port) > 0 && /^[0-9a-f]{32}$/.test(String(b.secret)))) return send(400, { error: 'need {pid, port, secret, cwd}' });
            channels.register({ pid: Number(b.pid), port: Number(b.port), secret: String(b.secret), cwd: String(b.cwd ?? '') });
            await rebind(String(b.cwd ?? ''), Number(b.pid)).catch((e) => console.error(`[loom] channel rebind: ${String(e)}`));
            return send(200, { ok: true });
          }
          if (req.method === 'POST' && parts[1] === 'permission') {
            const l = channels.permission(Number(b.pid), b);
            return l ? send(200, { ok: true, sid: l.sid }) : send(404, { error: 'no session bound to that channel' });
          }
        }
        if (req.method === 'POST' && parts[0] === 'sessions' && parts.length >= 3) {
          const l = mirror.bySid(parts[1]);
          if (!l) return send(404, { error: 'no live session with that id' });
          const b = await body(req);
          if (parts[2] === 'messages' && parts.length === 3) {
            const text = typeof b.text === 'string' ? b.text.trim() : '';
            if (!text) return send(400, { error: 'need {text}' });
            const status = await channels.send(l, text);
            return status === 'no-channel' ? send(409, { error: 'read-only: restart the lead with loom lead to chat here' }) : send(200, { status });
          }
          if (parts[2] === 'permissions' && parts.length === 4) {
            if (b.behavior !== 'allow' && b.behavior !== 'deny') return send(400, { error: 'behavior is allow or deny' });
            return (await channels.answer(l, parts[3], b.behavior)) ? send(200, { ok: true }) : send(409, { error: 'unknown or already answered request' });
          }
        }
        if (req.method === 'GET' && parts[0] === 'sessions' && parts.length === 1) return send(200, [...mirror.live.values()].map((l) => mirror.row(l)));
        if (req.method === 'GET' && parts[0] === 'sessions' && parts.length === 2) {
          const l = mirror.bySid(parts[1]);
          return l ? send(200, { ...mirror.detail(l), pending: channels.pending(l), queued: channels.queue(l) }) : send(404, { error: 'no live session with that id' });
        }
      }
      if (opts.readOnly && req.method !== 'GET' && u.pathname !== '/replay' && req.headers['x-loom-replay'] !== replayToken)
        return send(403, { error: 'read-only: only /replay is open' });
      if (u.pathname === '/replay') {   // loom replay <dir>: drive a recording into a fresh <tenant>:replay:<id> graph
        if (req.method === 'GET') { const p = replays.get(u.searchParams.get('run') ?? ''); return p ? send(200, p) : send(404, { error: 'no such replay' }); }
        const b = await body(req);
        let dir = resolve(String(b.dir ?? ''));   // a daemon in docker cannot see the host path: fall back to the repo-relative one
        if (!existsSync(dir) && b.rel) dir = resolve(DEMO, '..', String(b.rel));
        const allowed = opts.replayRoots ?? [DEMO];
        if (opts.readOnly && !allowed.some((r) => dir.startsWith(resolve(r) + sep))) return send(403, { error: 'read-only: replay only recordings under demo/' });
        if (!existsSync(join(dir, 'events.jsonl'))) return send(400, { error: `no events.jsonl in ${dir}` });
        const run = `${opts.tenant ?? 'coord'}:replay:${Date.now().toString(36)}`;
        const p: ReplayProgress = { run, total: 0, sent: 0, failed: [], done: false };
        replays.set(run, p);
        const self = async (route: string, payload: unknown, headers: Record<string, string> = {}) => {
          const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', body: JSON.stringify(payload),
            headers: { 'content-type': 'application/json', 'x-loom-replay': replayToken, ...headers } });
          const out = await r.text();
          if (!r.ok) throw new Error(`${r.status} ${out.slice(0, 200)}`);
          if (route.startsWith('/mcp/') && JSON.parse(out).ok === false) throw new Error(JSON.parse(out).error);
        };
        const job = replay(dir, run, self, { speed: b.speed === undefined ? undefined : Number(b.speed), progress: p })
          .catch((e) => { p.failed.push(String((e as Error).message ?? e)); p.done = true; return p; });
        return send(200, b.wait ? await job : p);
      }
      if (req.method === 'POST' && parts[0] === 'hook' && parts[1] === 'claude') {
        try {   // spec §6: hooks fail open, never a 500
          const input: ClaudeHookInput = await body(req);
          if ((parts[2] === 'SessionStart' || parts[2] === 'SessionEnd') && !req.headers['x-loom-run']) {   // P2: an interactive session in a loom repo
            const repo = await resolveRepo(opts.db, input.cwd ?? '', req.headers['x-loom-home'] as string | undefined);
            if (repo) {
              const t = await live.target(req.headers, input.cwd, input.session_id);
              if (t) await live.hook(parts[2], t, input);   // registers on start, releases leases on end
              if (parts[2] === 'SessionStart') {
                const person = gitTry(repo.top, 'config', 'user.email') ?? 'unknown';
                const writer = req.headers['x-loom-lead'] === '1' ? 'lead' : 'main';
                // compact / clear / resume fire SessionStart again under the same Claude id: the Loom session continues
                const prior = input.session_id && (input as any).source && (input as any).source !== 'startup' ? activeSession(repo.top, input.session_id) : null;
                const { sid, briefing } = prior ? { sid: prior.sid, briefing: await sessionBriefing(repo.graph, repo.top, person, prior.writer) }
                  : await startSession(repo.graph, repo.top, { person, kind: 'interactive', claudeSid: input.session_id ?? null, pids: ppidsOf(req.headers), writer, surface: 'terminal' });
                if (prior && input.session_id && mirror.live.get(input.session_id)?.sid === sid) {
                  channels.bind(input.session_id, ppidsOf(req.headers));
                  return send(200, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: briefing } });
                }
                if (input.session_id) { mirror.start({ claude: input.session_id, sid, writer: prior?.writer ?? writer, person, repo: repo.top }); channels.bind(input.session_id, ppidsOf(req.headers)); }
                return send(200, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: briefing } });
              }
              await finishSession(repo.graph, repo.top, { transcriptPath: (input as any).transcript_path, claudeSid: input.session_id ?? null });
              if (input.session_id) { mirror.end(input.session_id); channels.drop(input.session_id); }
              return send(200, {});
            }
          }
          if (!req.headers['x-loom-run'] && !req.headers['x-loom-agent'])   // §3.2: mirror interactive turns; never blocks the hook
            await mirror.hook(parts[2], input).then((l) => {
              if (!l) return;
              channels.bind(l.claude, ppidsOf(req.headers));   // after a daemon restart the session re-binds on its next hook
              if (parts[2] === 'Stop') void channels.onStop(l);
            }).catch((e) => console.error(`[loom] mirror: ${String(e)}`));
          const t = await live.target(req.headers, input.cwd, input.session_id);
          if (t) return send(200, await live.hook(parts[2], t, input));
          const r = await runFor(String(req.headers['x-loom-run'] ?? ''), input.cwd);
          const agent = String(req.headers['x-loom-agent'] ?? '') || (input.session_id ? `claude-${input.session_id.slice(0, 8)}` : '');
          if (r) {   // edits also carry their diff, so a replay can redo Bash edits that left no edit strings
            const it = parts[2] === 'PostToolUse' ? parsePostToolUse(input, r.root) : null;
            const files = it?.kind === 'edit' ? [it.file] : it?.kind === 'bash' ? changedPy(r.root) : [];
            record(r.c.run, u.pathname, files.length ? { agent, input, patchFiles: files, patch: filePatch(r.root, files) } : { agent, input });
          }
          return send(200, r && agent ? await onHook(parts[2], agent, r.c, input, r.root) : '');
        } catch (e) {
          console.error(`[loom] hook ${parts[2]} failed: ${String(e)}`);
          return send(200, '');
        }
      }
      if (req.method === 'POST' && parts[0] === 'mcp' && parts[1]) {
        // tool errors travel as {ok:false} with 200, so the MCP session survives daemon-side failures
        try {
          const b = await body(req);
          if ((TEAM_TOOLS as readonly string[]).includes(parts[1])) {   // the lead's tools: an agent may not start or stop teams
            if (req.headers['x-loom-agent'] || b.agent) return send(200, { ok: false, error: `${parts[1]} is for the lead session, not a team agent` });
            return send(200, { ok: true, result: await teams.mcp(parts[1] as (typeof TEAM_TOOLS)[number], String(b.cwd ?? ''), b.args ?? {}) });
          }
          const t = await live.target({ ...req.headers, ...(b.run ? { 'x-loom-run': b.run } : {}), ...(b.agent ? { 'x-loom-agent': b.agent } : {}) }, b.cwd, undefined);
          if (t) {
            const m = await live.mcp(parts[1], t, b.args ?? {});
            if (m.handled) return send(200, { ok: true, result: m.result });
          }
          const r = await runFor(String(req.headers['x-loom-run'] ?? b.run ?? ''), b.cwd);
          if (!r) return send(200, { ok: false, error: 'run not loaded' });
          // attach mode: the MCP process has no session id, so it is the agent last heard from in this worktree
          const agent = String(req.headers['x-loom-agent'] ?? b.agent ?? '') || (await r.c.agentAt(r.root)) || '';
          if (!agent) return send(200, { ok: false, error: 'no agent: set LOOM_AGENT' });
          record(r.c.run, u.pathname, { agent, args: b.args });
          return send(200, { ok: true, result: await mcpTool(r.c, parts[1], agent, b.args ?? {}, r.root) });
        } catch (e) { return send(200, { ok: false, error: String((e as Error).message ?? e) }); }
      }
      if (req.method === 'GET' && u.pathname === '/status') {
        const c = runs.get(u.searchParams.get('run') ?? '');
        return c ? send(200, await c.status()) : send(404, { error: 'run not loaded' });
      }
      if (req.method === 'GET' && u.pathname === '/why') {
        const run = u.searchParams.get('run') ?? '';   // the graph outlives the daemon: no loaded run needed
        if (!run || !serves(run)) return send(404, { error: 'run not loaded' });
        const r = await why(opts.db.graph(run), u.searchParams.get('target') ?? '');
        const steps = r.chains.length ? await opts.db.graph(`trace:${run}`).query(
          `MATCH (s:Step) WHERE $sid IN s.symbols RETURN s.seq AS seq, s.agent AS agent, s.tool AS tool, s.intent AS intent
           ORDER BY s.seq DESC LIMIT 5`, { sid: r.symbol }).catch(() => []) : [];
        return send(200, { ...r, text: renderWhy(r), steps });
      }
      if (req.method === 'POST' && u.pathname === '/plan') {
        const b = await body(req);
        const r = await runFor(String(b.run ?? ''), b.cwd);
        if (!r) return send(404, { error: 'run not loaded' });
        const g = opts.db.graph(r.c.run);
        if (!b.plan) return send(400, { error: 'need {plan}: write a team plan (.loom/plans/<slug>.md) and check it with loom plan check' });
        const tasks: PlanTask[] = validatePlan(b.plan).tasks;
        const scopes = new Map<string, string[]>();
        for (const t of tasks) scopes.set(t.id, await scope(g, t));
        const p = await partition(g, scopes);
        const comp = new Map(p.components.flatMap((ts, i) => ts.map((t) => [t, i] as const)));
        r.c.plan = { tasks: tasks.map((t) => ({ ...t, scope: scopes.get(t.id)!, component: comp.get(t.id) ?? -1 })), hubs: p.hubs, hubOwner: p.hubOwner };
        return send(200, r.c.plan);
      }
      if (parts[0] === 'teams') {   // B4: running teams. The repo comes from the caller's cwd, like /plans.
        const b = req.method === 'POST' ? await body(req) : {};
        const cwd = String(b.cwd ?? u.searchParams.get('cwd') ?? req.headers['x-loom-cwd'] ?? '');
        const repo = await resolveRepo(opts.db, cwd, req.headers['x-loom-home'] as string | undefined);
        if (!repo) return send(404, { error: 'not a Loom repo (run loom init)' });
        if (req.method === 'GET' && parts.length === 1) return send(200, teams.list(repo.top));
        if (req.method === 'POST' && parts.length === 1) {
          const r = await teams.start({ cwd, plan: String(b.plan ?? ''), leadSid: b.leadSid, model: b.model, blind: b.blind === true });
          return send(r.ok ? 200 : 400, r);
        }
        const id = parts[1];
        if (req.method === 'GET' && parts.length === 2) { const v = teams.get(id); return v ? send(200, v) : send(404, { error: `no team ${id}` }); }
        if (req.method === 'POST' && parts.length === 3) {
          const r = parts[2] === 'stop' ? await teams.stop(id) : parts[2] === 'merge' ? await teams.merge(id, b.into)
            : parts[2] === 'message' ? teams.message(id, String(b.agent ?? ''), String(b.text ?? ''))
            : parts[2] === 'stop-agent' ? teams.stopAgent(id, String(b.agent ?? ''))
            : parts[2] === 'restart-agent' ? await teams.restartAgent(id, String(b.agent ?? ''), b.note) : null;
          if (r) return send((r as { ok?: boolean }).ok === false ? 400 : 200, r);
        }
      }
      if (parts[0] === 'plans') {   // §3.3: team plans in .loom/plans/ and the checker; the repo comes from the caller's cwd
        const b = req.method === 'POST' ? await body(req) : {};
        const repo = await resolveRepo(opts.db, String(b.cwd ?? u.searchParams.get('cwd') ?? req.headers['x-loom-cwd'] ?? ''), req.headers['x-loom-home'] as string | undefined);
        if (!repo) return send(404, { error: 'not a Loom repo (run loom init)' });
        if (req.method === 'GET' && parts.length === 1) return send(200, listPlans(repo.top));
        if (req.method === 'GET' && parts.length === 2) {
          const f = join(repo.top, '.loom', 'plans', `${parts[1]}.md`);
          if (!/^[\w.-]+$/.test(parts[1]) || !existsSync(f)) return send(404, { error: `no plan ${parts[1]} in .loom/plans/` });
          const text = readFileSync(f, 'utf8');
          return send(200, { slug: parts[1], text, ...parseTeamPlan(text) });
        }
        if (req.method === 'POST' && parts[1] === 'check') return send(200, await checkPlanAt(repo, b));
      }
      if (req.method === 'GET' && u.pathname === '/plan') {
        const c = runs.get(u.searchParams.get('run') ?? '');
        return c ? send(200, c.plan ?? { tasks: [], hubs: [], hubOwner: {} }) : send(404, { error: 'run not loaded' });
      }
      if (req.method === 'GET' && u.pathname === '/repo/lessons') {   // I1: the graph comes from the caller's cwd + tenant, never from the request
        const repo = await resolveRepo(opts.db, String(req.headers['x-loom-cwd'] ?? ''), req.headers['x-loom-home'] as string | undefined);
        return send(200, repo ? await lessonsFor(repo.graph, [String(u.searchParams.get('region') ?? '')], 10) : []);
      }
      if (u.pathname === '/lessons') {                                 // loom lesson add | list | rm; a run's lessons live in that run's graph
        const b = req.method === 'POST' ? await body(req) : {};
        const run = String(b.run ?? u.searchParams.get('run') ?? '');
        if (!run) return send(400, { error: 'run required' });
        const lessons = lessonsOf(run);
        if (req.method === 'GET') return send(200, { lessons: await lessons.list(u.searchParams.get('symbol') ?? undefined) });
        if (req.method === 'POST') {
          if (!Array.isArray(b.symbols) || !b.symbols.length || !b.text) return send(400, { error: 'symbols[] and text required' });
          return send(200, await lessons.record('manual', b.symbols.map(String), String(b.text), run));
        }
        if (req.method === 'DELETE') return send(200, { removed: await lessons.rm(u.searchParams.get('id') ?? '') });
      }
      if (req.method === 'POST' && u.pathname === '/merge-check') {  // loom merge-check a b: fork the run graph, predict, merge, score
        const b = await body(req);
        const repo = b.repo ?? resolveAttach(b.cwd ?? '')?.mainRoot;
        if (!b.run || !b.a || !b.b || !repo) return send(400, { error: 'run, a, b and repo (or an attached cwd) required' });
        try { return send(200, await mergeCheck(opts.db, b.run, b.a, b.b, { repo, cfg: cfgFor(repo), lessons: lessonsOf(b.run) })); }
        catch (e) { if (e instanceof UnknownSide) return send(400, { error: e.message }); throw e; }
      }
      if (req.method === 'POST' && u.pathname === '/verify') {       // loom verify: re-run every claim's evidence (or one task's)
        const b = await body(req);
        const c = runs.get(b.run);
        if (!c) return send(404, { error: 'run not loaded' });
        const out = [];
        for (const cl of (await c.claims()).filter((x) => !b.task || x.task === b.task)) out.push({ agent: cl.agent, ...(await c.claimDone(cl.agent, cl.task, '', b.mutate !== false)) });
        return send(200, { claims: out });
      }
      if (req.method === 'GET' && u.pathname === '/claims') {
        const c = runs.get(u.searchParams.get('run') ?? '');
        return c ? send(200, { claims: await c.claims() }) : send(404, { error: 'run not loaded' });
      }
      if (req.method === 'POST' && u.pathname === '/release') {
        const b = await body(req);
        const c = runs.get(b.run);
        return c ? send(200, { released: await c.forceRelease(b.agent) }) : send(404, { error: 'run not loaded' });
      }
      if (req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'v2') {   // R6.1–R6.4: the v2 `loom run`
        const b = await body(req);
        const r = parts[2] === 'runs' ? await live.addRun(b)
          : parts[2] === 'agents' ? await live.addAgent(b)
          : parts[2] === 'land' ? await live.land(String(b.run), String(b.agent))
          : parts[2] === 'take' ? await live.take(String(b.run), String(b.agent)) : undefined;
        return r === undefined ? send(404, { error: 'not found' }) : r === null ? send(404, { error: 'run or agent not loaded' }) : send(200, r);
      }
      if (req.method === 'POST' && u.pathname === '/admin/runs') {
        const b = await body(req);
        record(b.run, u.pathname, b);
        // bench and replay runs pass lessons:false: they measure notices alone and must not depend on what earlier runs left
        const c = await Coordinator.create(opts.db.graph(b.run), b.run, bus, b.lessons === false ? undefined : lessonsOf(b.run));
        if (!baseCache.has(b.baseKey)) baseCache.set(b.baseKey, new Map());
        const stats = await c.indexBase(b.root, b.dirs, baseCache.get(b.baseKey));
        addRun(b.run, c);
        return send(200, stats);
      }
      if (req.method === 'POST' && u.pathname === '/admin/agents') {
        const b = await body(req);
        record(b.run, u.pathname, b);
        await runs.get(b.run)!.registerAgent(b.agent, b.harness, b.worktree);
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && u.pathname === '/admin/landed') {   // loom run committed a worker's work for it
        const b = await body(req);
        record(b.run, u.pathname, b);
        const c = runs.get(b.run);
        return c ? send(200, { released: await c.landed(b.agent, b.files ?? [], b.sha, b.message ?? '') }) : send(404, { error: 'run not loaded' });
      }
      if (req.method === 'POST' && u.pathname === '/admin/exit') {     // loom run saw a worker process exit
        const b = await body(req);
        record(b.run, u.pathname, b);
        const c = runs.get(b.run);
        return c ? send(200, { released: await c.exited(b.agent, Number(b.code)) }) : send(404, { error: 'run not loaded' });
      }
      if (req.method === 'POST' && u.pathname === '/admin/ingest') {
        const b = await body(req);
        record(b.run, u.pathname, b);
        const c = runs.get(b.run)!;
        let notices = 0;
        for (const f of b.files as string[]) if (f.endsWith('.py')) notices += (await c.onEdit(b.agent, b.worktree, f)).notices;
        return send(200, { notices });
      }
      if (req.method === 'GET' && parts[0] === 'runs' && parts[2] === 'touched') {
        const c = runs.get(parts[1]);
        const kind = u.searchParams.get('kind') === 'edit' ? 'edit' : 'read';
        return send(200, { touched: c ? await c.touched(u.searchParams.get('agent')!, kind, u.searchParams.get('file') ?? undefined) : false });
      }
      if (req.method === 'GET' && parts[0] === 'runs' && parts[2] === 'notices') {
        const c = runs.get(parts[1]);
        return send(200, c ? await c.allNotices() : (await live.notices(parts[1])) ?? []);
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: String(e) });
    }
  });

  /** Dashboard Timeline: steps, notices, commits and test runs of one run, one list sorted by time. */
  async function timeline(run: string) {
    await traces.get(run)?.flush();
    const g = opts.db.graph(run);
    const q = <T>(gr: typeof g, cy: string) => gr.query<T>(cy).catch(() => [] as T[]);
    const rows = [
      ...await q<any>(opts.db.graph(`trace:${run}`), `MATCH (s:Step) RETURN 'step' AS kind, s.agent AS agent, s.at AS at,
        s.tool + ' ' + s.intent + CASE WHEN s.file = '' THEN '' ELSE ' ' + s.file END AS text ORDER BY s.at DESC LIMIT 400`),
      ...await q<any>(g, `MATCH (n:Notice) RETURN 'notice' AS kind, n.agent AS agent, n.at AS at, n.status + ': ' + n.text AS text`),
      ...await q<any>(g, `MATCH (m:Commit) RETURN 'commit' AS kind, m.agent AS agent, m.at AS at, substring(m.sha, 0, 8) + ' ' + coalesce(m.message, '') AS text`),
      ...await q<any>(g, `MATCH (r:TestRun) RETURN 'test' AS kind, r.agent AS agent, r.at AS at, r.result + ' ' + coalesce(reduce(s = '', l IN r.labels | s + l + ' '), '') AS text`),
    ].filter((r) => typeof r.at === 'number').sort((a, b) => a.at - b.at).slice(-500);
    return { rows, agents: [...new Set(rows.map((r) => r.agent).filter(Boolean))].sort() };
  }
  /** Dashboard Bench: every bench/results/*.json by name; the view renders only what is on disk. */
  function bench() {
    const dir = opts.benchDir ?? BENCH;
    if (!existsSync(dir)) return {};
    return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
      try { return [[f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))]]; } catch { return []; }
    }));
  }

  /** B5/B6 data views (GET, ?cwd=). `sessions` answers from the graph only when asked about a repo; without one it is the lead's live list. */
  async function viewRoute(u: URL, parts: string[], req: IncomingMessage): Promise<{ status: number; body: unknown } | undefined> {
    if (req.method !== 'GET') return undefined;
    const ok = (body: unknown) => ({ status: 200, body });
    if (parts[0] === 'bench' && parts[1] === 'compare' && parts.length === 2) return ok(benchCompare(opts.benchDir ?? BENCH));
    const cwd = String(u.searchParams.get('cwd') ?? req.headers['x-loom-cwd'] ?? '');
    const names = ['people', 'collab', 'collisions', 'regions', 'growth', 'brief'];
    if (!(names.includes(parts[0]) || (parts[0] === 'sessions' && cwd))) return undefined;
    const repo = await resolveRepo(opts.db, cwd, req.headers['x-loom-home'] as string | undefined);
    if (!repo) return { status: 404, body: { error: 'not a Loom repo (run loom init)' } };
    const g = repo.graph; const q = (k: string) => u.searchParams.get(k);
    switch (parts[0]) {
      case 'people': return ok(await people(g));
      case 'collab': return ok(await collab(g));
      case 'collisions': return ok(await collisions(g, { kind: q('kind'), person: q('person') }));
      case 'growth': return ok(await growth(g));
      case 'brief': return ok(await brief(g, repo.root, q('person')));
      case 'regions': { if (!parts[1]) return ok(await searchRegions(g, q('q') ?? '', Math.min(Number(q('limit')) || 30, 5000))); const r = parts[1] ? await region(g, parts[1]) : null; return r ? ok(r) : { status: 404, body: { error: 'no such region' } }; }
      default: {
        if (parts.length === 1) return ok(await sessionRows(g, { person: q('person'), limit: q('limit') ? Number(q('limit')) : undefined }));
        const d = await sessionDetail(g, parts[1]);
        return d ? ok(d) : { status: 404, body: { error: `no session ${parts[1]}` } };
      }
    }
  }

  const benchRun = new BenchRun(opts.benchRoot ?? resolve(BENCH, '..'), opts.benchRunner);

  /** Read-only (public) mode answers only for the runs this daemon serves: a query on any other name would read, or create, that graph. */
  /** POST /plans/check: {text} | {slug} | {file} (relative to the caller's cwd). A malformed plan is ok:false, never a 500. */
  async function checkPlanAt(repo: { top: string; graph: LoomGraph }, b: any) {
    const f = b.slug ? join(repo.top, '.loom', 'plans', `${String(b.slug)}.md`) : b.file ? resolve(String(b.cwd ?? repo.top), String(b.file)) : null;
    if (f && !existsSync(f)) return { ok: false, problems: [`no plan file at ${f}`], warnings: [] };
    const { plan, problems } = parseTeamPlan(f ? readFileSync(f, 'utf8') : String(b.text ?? ''));
    if (!plan) return { ok: false, problems, warnings: [] };
    const regionPaths = (await repo.graph.query<{ path: string }>('MATCH (r:Region) RETURN r.path AS path').catch(() => [])).map((r) => r.path);
    const files = (ref: string) => { const out = gitTry(repo.top, 'ls-tree', '-r', '--name-only', ref); if (out === null) throw new Error(`unknown ref ${ref}`); return out.split('\n').filter(Boolean); };
    return { ...checkTeamPlan(plan, { files, regions: regionPaths.length, regionPaths }), plan };
  }
  function serves(run: string) { return !opts.readOnly || runs.has(run); }

  await new Promise<void>((r) => server.listen(opts.port, opts.host ?? '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  teams = new TeamRoutes({ routes: live, channels, mirror, bus: leadBus, url: `http://127.0.0.1:${port}`, bin: opts.teamBin, pollMs: opts.teamPoll,
    async check(cwd, b) {
      const repo = await resolveRepo(opts.db, cwd, opts.home);
      if (!repo) return { ok: false, problems: [], top: null };
      const r = await checkPlanAt(repo, { ...b, cwd });
      return { ok: r.ok, problems: r.problems, top: repo.top };
    } });
  const ui = opts.uiPort === null ? null
    : await startUi({ port: opts.uiPort ?? 4317, host: opts.host, bus, runs, distDir: opts.distDir ?? DIST, serves, raw: async (u, req, res) => {
      if (u.pathname !== '/lead' && !u.pathname.startsWith('/lead/api/')) return false;
      if (opts.readOnly) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"read-only: the lead page is local only"}'); }   // never hand out the token
      else if (u.pathname === '/lead') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "frame-ancestors 'self'" }); res.end(leadPage(token)); }
      else {
        const path = u.pathname.slice('/lead/api'.length);
        if (path === '/events' || path === '/sessions' || path.startsWith('/sessions/')) await passThrough(req, res, port, path, u.search);
        else { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"the lead page reaches only /events and /sessions"}'); }
      }
      return true;
    }, guard: opts.readOnly ? undefined : localOnly, extra: async (u, req) => {
      const run = u.searchParams.get('run') ?? '';
      if (u.pathname === '/bench/run') {
        if (req.method === 'GET') return { readOnly: Boolean(opts.readOnly), ...benchRun.status() };
        if (opts.readOnly) return new Reply(403, { error: 'read-only: run the bench on your own machine' });
        const b = await body(req);
        const no = benchRun.start(b.set, b.confirm);
        return no ? new Reply(no[0], { error: no[1] }) : { readOnly: false, ...benchRun.status() };
      }
      if (u.pathname === '/demo/replay' && req.method === 'POST') {   // the API port's /replay, fixed to the shipped recording
        const r = await fetch(`http://127.0.0.1:${port}/replay`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...(await body(req)), dir: opts.demoRun ?? join(DEMO, 'run-1'), rel: 'demo/run-1' }) });
        return new Reply(r.status, await r.json());
      }
      if (u.pathname === '/ctx') return { cwd: opts.cwd ?? process.cwd() };   // the repo the dashboard opens on when the page names none
      if (!opts.readOnly && (u.pathname === '/teams' || u.pathname.startsWith('/teams/') || u.pathname === '/plans' || u.pathname.startsWith('/plans/'))) {
        const init: RequestInit = { method: req.method, headers: { 'content-type': 'application/json', ...(req.headers['x-loom-home'] ? { 'x-loom-home': String(req.headers['x-loom-home']) } : {}) } };
        if (req.method === 'POST') init.body = JSON.stringify(await body(req));
        const r = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);   // the dashboard is a client of the API port, never a second implementation
        return new Reply(r.status, await r.json());
      }
      if (u.pathname === '/timeline') return timeline(run);
      if (u.pathname === '/why') { const r = await why(opts.db.graph(run), u.searchParams.get('target') ?? ''); return { ...r, text: renderWhy(r) }; }
      if (u.pathname === '/claims') return { claims: await (runs.get(run)?.claims() ?? []) };
      if (u.pathname === '/lessons') return { lessons: run ? await lessonsOf(run).list(u.searchParams.get('symbol') ?? undefined) : [] };
      if (u.pathname === '/bench') return bench();
      { const v = await viewRoute(u, u.pathname.split('/').filter(Boolean).map(decodeURIComponent), req); if (v) return new Reply(v.status, v.body); }
      if (u.pathname !== '/plan') return undefined;
      const c = runs.get(run);
      const plan = c?.plan ?? { tasks: [], hubs: [], hubOwner: {} };
      const ids = [...new Set(plan.tasks.flatMap((t) => t.scope))];
      if (!c || !ids.length) return { ...plan, nodes: [], edges: [] };
      const g = opts.db.graph(c.run);   // Plan view: the scoped symbols and the CALLS among them
      const nodes = await g.query(`MATCH (s:Symbol) WHERE s.id IN $ids RETURN s.id AS id, s.qname AS qname, s.file AS file, s.kind AS kind`, { ids });
      const edges = await g.query(`MATCH (a:Symbol)-[:CALLS]->(b:Symbol) WHERE a.id IN $ids AND b.id IN $ids RETURN a.id AS from, b.id AS to`, { ids });
      return { ...plan, nodes, edges };
    } });
  return {
    port, uiPort: ui?.port, bus, runs,
    close: async () => {
      timers.forEach(clearInterval); await teams.closeAll(); live.close();
      for (const t of traces.values()) await t.close();
      await ui?.close(); await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await LoomDb.connect();
  const env = process.env;
  const srv = await startServer({ port: Number(env.LOOM_PORT ?? 4318), uiPort: Number(env.PORT ?? env.LOOM_UI_PORT ?? 4317), db,
    readOnly: env.LOOM_READONLY === '1', tenant: env.LOOM_TENANT, host: env.LOOM_HOST });
  console.log(`loom daemon on http://127.0.0.1:${srv.port}${env.LOOM_READONLY === '1' ? ' (read-only)' : ''}`);
  if (env.LOOM_AUTOREPLAY) {   // deployed demo: replay the pinned recording once on boot so the dashboard has a run to show
    const r = await fetch(`http://127.0.0.1:${srv.port}/replay`, { method: 'POST', body: JSON.stringify({ dir: resolve(env.LOOM_AUTOREPLAY) }) });
    console.log(`[loom] autoreplay ${env.LOOM_AUTOREPLAY}: ${await r.text()}`);
  }
}
