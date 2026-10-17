// P3 Task 6: Claude hooks and MCP calls reach `Live`. Interactive sessions by the repo their cwd is in (I1: never by request input);
// v2 run agents by the x-loom-run header. Each graph has one Live, so one serial lock orders every agent on it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LoomDb, LoomGraph } from '@loom/core';
import { DEFAULT_EXCLUDES, gitTry, indexRepo } from '@loom/memory';
import { contextJson, denyJson, parsePostToolUse, parsePreToolUse, stopBlockJson, type ClaudeHookInput } from '../claude.js';
import { holders } from '../lease.js';
import { resolveRepo } from '../repo.js';
import { Live } from './live.js';
import { landOne, MergeQueue, type LandResult } from './queue.js';
import { upstreamOf } from './stale.js';
import type { CollisionIn } from '../team/collide.js';

export interface V2Run { id: string; g: LoomGraph; live: Live; repo: string; landed: string; test: string | null; compile: string | null; queue: MergeQueue;
  agents: Map<string, { worktree: string; task: string; title: string }> }
interface Target { live: Live; g: LoomGraph; agent: string; root: string }

const SWEEP_MS = 30_000;

export class LiveRoutes {
  private readonly lives = new Map<string, Live>();
  readonly runs = new Map<string, V2Run>();
  private readonly timer: NodeJS.Timeout;
  onCollision?: (run: string, c: CollisionIn) => void;

  constructor(private readonly db: LoomDb) {
    this.timer = setInterval(() => { for (const l of this.lives.values()) void l.sweep().catch(() => {}); }, SWEEP_MS);
    this.timer.unref();
  }
  close() { clearInterval(this.timer); }

  private liveOf(g: LoomGraph): Live {
    let l = this.lives.get(g.name);
    if (!l) { l = new Live(g); this.lives.set(g.name, l); }
    return l;
  }

  /** The Live an incoming call belongs to, registering an interactive session on first sight; null = not Live's. */
  async target(hdr: Record<string, unknown>, cwd: string | undefined, sid: string | undefined): Promise<Target | null> {
    const run = this.runs.get(String(hdr['x-loom-run'] ?? ''));
    if (run) {
      const agent = String(hdr['x-loom-agent'] ?? '');
      const a = run.agents.get(agent);
      return a ? { live: run.live, g: run.g, agent, root: a.worktree } : null;
    }
    if (hdr['x-loom-run']) return null;   // a v1 run
    const repo = await resolveRepo(this.db, cwd ?? '', hdr['x-loom-home'] as string | undefined);
    if (!repo) return null;
    const live = this.liveOf(repo.graph);
    const agent = String(hdr['x-loom-agent'] ?? '') || (sid ? `claude-${sid.slice(0, 8)}` : '');
    const [k] = agent ? await repo.graph.query<{ n: number }>('MATCH (a:Agent {id: $agent}) RETURN count(a) AS n', { agent }) : [{ n: 1 }];
    if (!k?.n) {
      await live.register({ id: agent, person: gitTry(repo.top, 'config', 'user.email') ?? 'unknown', worktree: repo.top, top: repo.top,
        upstream: upstreamOf(repo.top), run: null, task: null, scope: [] });
    }
    return { live, g: repo.graph, agent, root: repo.top };
  }

  /** One hook event for an agent Live owns: deny JSON, context JSON, or ''. */
  async hook(event: string, t: Target, input: ClaudeHookInput): Promise<string> {
    const { live, agent, root } = t;
    if (!agent) return '';
    void live.sweep().catch(() => {});
    if (event === 'SessionEnd') { await live.release(agent); return ''; }
    if (event === 'PreToolUse') {
      if (input.tool_name === 'Bash') { await live.unseen(agent); return ''; }   // baseline: what a script writes next is unleased
      const it = parsePreToolUse(input, root);
      if (!it) return '';
      const d = await live.preEdit(agent, it);
      if (!d.allow) return denyJson(d.reason);
      return d.context ? contextJson('PreToolUse', d.context) : '';
    }
    if (event === 'PostToolUse') {
      const it = parsePostToolUse(input, root);
      if (it.kind === 'edit') await live.postEdit(agent, it.file);
      if (it.kind === 'bash') await live.unseen(agent);
    } else if (event !== 'SessionStart' && event !== 'UserPromptSubmit' && event !== 'Stop') return '';
    await live.syncIfPending(agent);
    const ns = await live.takeNotices(agent);
    if (!ns.length) return '';
    const text = ns.map((n) => n.text).join('\n\n');
    // a notice that arrived after the agent's last tool call has no later hook to ride on: block that Stop once with it
    return event === 'Stop' ? stopBlockJson(text) : contextJson(event, text);
  }

  async mcp(tool: string, t: Target, a: any): Promise<{ handled: boolean; result?: unknown }> {
    const { live, g, agent } = t;
    switch (tool) {
      case 'notices': return { handled: true, result: await live.takeNotices(agent) };
      case 'ack_notice': await live.ack(agent, String(a.id)); return { handled: true, result: { ok: true } };
      case 'release': await live.release(agent); return { handled: true, result: { ok: true } };
      case 'who_is_touching': {
        const k = String(a.path_or_symbol ?? '');
        const rows = await g.query<{ region: string; qname: string; agent: string; mode: string; task: string | null; since: number }>(
          `MATCH (o:Agent)-[l:LEASED]->(r:Region) WHERE l.expires > $now AND (r.path = $k OR r.qname = $k OR r.id = $k OR r.id STARTS WITH $k + '::')
           RETURN r.id AS region, r.qname AS qname, o.id AS agent, l.mode AS mode, l.task AS task, l.since AS since ORDER BY region`, { k, now: Date.now() });
        return { handled: true, result: rows };
      }
      case 'lease': {
        const ids = (a.symbols ?? []).map(String);
        const hs = await holders(g, agent, ids, a.mode === 'contract' ? 'contract' : 'write');
        return { handled: true, result: { granted: !hs.length, holders: hs } };
      }
      default: return { handled: false };
    }
  }

  /** R6.2: a v2 run gets its own graph, indexed from the repo at the landed branch's checkout (main worktree). */
  async addRun(b: { run: string; repo: string; landed: string; dirs?: string[]; test?: string | null; compile?: string | null }) {
    const g = this.db.graph(b.run);
    const dirs = [...(b.dirs?.length ? b.dirs : ['.'])];
    if (!dirs.includes('.') && existsSync(join(b.repo, 'tests')) && !dirs.includes('tests')) dirs.push('tests');
    const t0 = Date.now();
    const stats = await indexRepo(g, b.repo, { baseline: true, writeLock: false, cfg: { repoId: b.run, dirs, excludes: DEFAULT_EXCLUDES, testCmd: b.test ?? null, share: false } });
    const live = this.liveOf(g);
    live.onCollision = (c) => this.onCollision?.(b.run, c);
    this.runs.set(b.run, { id: b.run, g, live, repo: b.repo, landed: b.landed, test: b.test ?? null, compile: b.compile ?? null, queue: new MergeQueue(), agents: new Map() });
    return { ok: true, ms: Date.now() - t0, stats };
  }

  /** Scope entries are region ids, qname prefixes (`path::name`), or paths. */
  async addAgent(b: { run: string; agent: string; worktree: string; task: string; title?: string; scope?: string[] }) {
    const r = this.runs.get(b.run);
    if (!r) return null;
    const ss = (b.scope ?? []).map(String);
    const scope = ss.length ? (await r.g.query<{ id: string }>(`MATCH (x:Region) WHERE any(s IN $ss WHERE x.id = s OR x.id STARTS WITH s + '::' OR x.path = s)
      RETURN x.id AS id`, { ss })).map((x) => x.id) : [];
    await r.g.query('MERGE (t:Task {id: $task}) SET t.title = $title, t.startedAt = coalesce(t.startedAt, $now)', { task: b.task, title: b.title ?? '', now: Date.now() });
    await r.live.register({ id: b.agent, person: `run:${b.run}`, worktree: b.worktree, top: b.worktree, upstream: r.landed, run: b.run, task: b.task, scope });
    r.agents.set(b.agent, { worktree: b.worktree, task: b.task, title: b.title ?? b.task });
    return { ok: true, scope: scope.length };
  }

  /** R6.1: one landing at a time per run; on success the regions get Versions and waiters are woken. */
  async land(run: string, agent: string): Promise<LandResult | null> {
    const r = this.runs.get(run);
    const a = r?.agents.get(agent);
    if (!r || !a) return null;
    return r.queue.enqueue(async () => {
      const res = await landOne({ repo: r.repo, wt: a.worktree, landed: r.landed, agent, title: a.title, testCmd: r.test, compileCmd: r.compile, g: r.g });
      if (res.status === 'landed') {
        await r.live.land(agent, res.regions, { sha: res.sha!, task: a.task });
        await r.g.query('MATCH (t:Task {id: $task}) SET t.doneAt = $now', { task: a.task, now: Date.now() });
      }
      if (res.status === 'contract_break' || res.status === 'tests_failed' || res.status === 'compile_failed' || res.status === 'conflict') {
        const me = { person: '', session: agent, agent };
        this.onCollision?.(run, { kind: res.status === 'conflict' ? 'merge_conflict' : 'landing_rejected', region: res.regions ?? [], parties: [me],
          outcome: 'rejected', version: res.status === 'conflict' ? null : r.landed + ':' + (a.task ?? agent), detail: `${agent}: ${res.status}${res.tail ? ' — ' + String(res.tail).split('\n')[0].slice(0, 160) : ''}` });
      }
      return res;
    });
  }

  async take(run: string, agent: string) {
    const r = this.runs.get(run);
    if (!r) return null;
    const ns = await r.live.takeNotices(agent);
    return { text: ns.map((n) => n.text).join('\n\n'), notices: ns };
  }

  /** What the dashboard draws for a team's run: the agents, their leases and notices, and the code around the leased functions. */
  async snapshot(run: string) {
    const r = this.runs.get(run);
    if (!r) return null;
    const now = Date.now();
    const leases = await r.g.query<{ agent: string; symbol: string; mode: string; expires: number }>(
      `MATCH (a:Agent)-[l:LEASED]->(x:Region) WHERE l.expires > $now RETURN a.id AS agent, x.id AS symbol, l.mode AS mode, l.expires AS expires`, { now });
    const waits = await r.g.query<{ agent: string }>('MATCH (a:Agent)-[:WAITS_ON]->(:Region) RETURN DISTINCT a.id AS agent');
    const ids = [...new Set(leases.map((l) => l.symbol))];
    const nodes = ids.length ? await r.g.query<{ id: string; qname: string; file: string; kind: string }>(
      `MATCH (s:Region) WHERE s.id IN $ids OPTIONAL MATCH (s)-[:CALLS]-(n:Region)
       WITH collect(DISTINCT s) + collect(DISTINCT n) AS ss UNWIND ss AS x WITH DISTINCT x LIMIT 300
       RETURN x.id AS id, x.qname AS qname, x.path AS file, x.kind AS kind`, { ids }) : [];
    const nid = nodes.map((n) => n.id);
    const edges = nid.length ? await r.g.query<{ from: string; to: string }>(
      'MATCH (a:Region)-[:CALLS]->(b:Region) WHERE a.id IN $ids AND b.id IN $ids RETURN a.id AS from, b.id AS to', { ids: nid }) : [];
    const waiting = new Set(waits.map((w) => w.agent));
    return {
      nodes, edges,
      agents: [...r.agents].map(([id, a]) => ({ id, state: waiting.has(id) ? 'waiting' : 'active', heartbeatAt: now, task: a.task, taskTitle: a.title })),
      leases: leases.map((l) => ({ ...l, contract: l.mode === 'contract' })),
      notices: await this.notices(run) ?? [],
    };
  }

  async notices(run: string) {
    const r = this.runs.get(run);
    return r ? r.g.query(`MATCH (n:Notice) RETURN n.id AS id, n.agent AS agent, n.author AS author, n.kind AS kind, n.status AS status,
      n.region AS region, n.text AS text, n.at AS at, n.deliveredAt AS deliveredAt ORDER BY n.at`) : null;
  }
}
