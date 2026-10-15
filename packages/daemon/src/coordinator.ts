import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSchema, type ChangeRec, type FileIndex, type LoomGraph, type NoticeOut, type SymbolRec } from '@loom/core';
import { callSatisfies, diffFile, indexPython } from '@loom/indexer';
import type { ClaudeHookInput } from './claude.js';
import { EventBus, type EventType } from './events.js';
import { acquire, expired, holders, release, renew, type LeaseMode } from './lease.js';
import { MAX_PER_DELIVERY, renderBarrier, renderNotice, renderWake, score, THRESHOLD } from './notice.js';
import { applyEdits, predictLease, type EditIntent } from './predict.js';
import { cfgFor, claimGap, verifyClaim, type ClaimResult } from './verify.js';
import type { Lessons } from './lessons.js';

const BATCH = 1000;
type Rule = 'notices' | 'claim' | 'barrier';
const now = () => Date.now();
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

function walkPy(root: string, dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(root, rel)).isDirectory()) walkPy(root, rel, out);
    else if (e.endsWith('.py')) out.push(rel);
  }
  return out;
}

const symRow = (s: SymbolRec, owner: string | null) => ({
  id: s.id, file: s.file, name: s.name, qname: s.qname, kind: s.kind, sig: s.sig,
  sigHash: s.sigHash, bodyHash: s.bodyHash, exported: s.exported, startLine: s.startLine, endLine: s.endLine, owner, doc: s.doc ?? '',
});

const UPSERT_SYMBOLS = `UNWIND $rows AS r MERGE (s:Symbol {id: r.id})
  SET s.file = r.file, s.name = r.name, s.qname = r.qname, s.kind = r.kind, s.sig = r.sig, s.sigHash = r.sigHash,
      s.bodyHash = r.bodyHash, s.exported = r.exported, s.startLine = r.startLine, s.endLine = r.endLine, s.owner = r.owner, s.doc = r.doc`;
const UPSERT_CALLS = `UNWIND $rows AS r MATCH (a:Symbol {id: r.from}), (b:Symbol {id: r.to})
  MERGE (a)-[c:CALLS]->(b) SET c.line = r.line, c.argc = r.argc, c.kwargs = r.kwargs`;

export class Coordinator {
  private base = new Map<string, FileIndex>();
  private seen = new Map<string, Map<string, FileIndex>>();
  private contentHash = new Map<string, string>(); // `${agent}|${file}` -> md5 of last indexed content
  private known = new Set<string>();
  private seq = 0;
  private lock: Promise<unknown> = Promise.resolve();
  private heads = new Map<string, string>();        // agent -> last seen HEAD
  private lastBlock = new Map<string, Rule>();
  private blocks = new Map<string, number>();       // `${agent}|${task}` -> Stop blocks so far
  static IDLE_MS = 90_000;
  static MAX_BLOCKS = 3;

  /** The last partition for this run (planner / `loom run`), served to the dashboard's Plan view. */
  plan?: { tasks: { id: string; title: string; prompt: string; scope: string[]; component: number }[]; hubs: string[]; hubOwner: Record<string, string> };
  dirs: string[] = [];

  private firstFile = new Map<string, string>();     // agent -> first file it read or edited (lesson scope without a plan)
  private told = new Set<string>();                  // agents already given their lessons

  private constructor(private readonly g: LoomGraph, readonly run: string, readonly bus: EventBus, readonly lessons?: Lessons) {}

  static async create(g: LoomGraph, run: string, bus = new EventBus(), lessons?: Lessons): Promise<Coordinator> {
    await ensureSchema(g);
    return new Coordinator(g, run, bus, lessons);
  }

  /** All graph mutations for a run go through one queue: per-agent views must not interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => undefined);
    return p;
  }

  private async batch(cypher: string, rows: unknown[]) {
    for (let i = 0; i < rows.length; i += BATCH) await this.g.query(cypher, { rows: rows.slice(i, i + BATCH) });
  }

  private callRows(idx: FileIndex, from?: Set<string>) {
    return idx.calls
      .filter((c) => !from || from.has(c.from))
      .flatMap((c) => c.to.filter((t) => this.known.has(t)).slice(0, 1)
        .map((to) => ({ from: c.from, to, line: c.line, argc: c.argc, kwargs: c.kwargs })));
  }

  async indexBase(root: string, dirs: string[], cache?: Map<string, FileIndex>) {
    this.dirs = dirs;
    if (cache?.size) this.base = cache;
    else for (const d of dirs) for (const f of walkPy(root, d)) {
      this.base.set(f, await indexPython(f, readFileSync(join(root, f), 'utf8')));
    }
    if (cache && !cache.size) for (const [k, v] of this.base) cache.set(k, v);
    const syms = [...this.base.values()].flatMap((i) => i.symbols);
    syms.forEach((s) => this.known.add(s.id));
    await this.batch(UPSERT_SYMBOLS, syms.map((s) => symRow(s, null)));
    const calls = [...this.base.values()].flatMap((i) => this.callRows(i));
    await this.batch(UPSERT_CALLS, calls);
    return { files: this.base.size, symbols: syms.length, calls: calls.length };
  }

  knownFile(file: string) { return this.base.has(file); }

  /** One call site from the author's current code, e.g. `phone2numeric(n, strict=False)`. */
  private callExample(author: string, ch: ChangeRec): string | undefined {
    if (ch.kind === 'removed' || ch.kind === 'added') return undefined;
    for (const idx of this.seen.get(author)?.values() ?? []) {
      for (const c of idx.calls) {
        if (!c.to.includes(ch.symbol.id)) continue;
        const line = idx.source.split('\n')[c.line - 1] ?? '';
        const at = line.indexOf(`${c.callee}(`);
        if (at < 0) continue;
        let depth = 0;
        for (let i = at + c.callee.length; i < line.length; i++) {
          if (line[i] === '(') depth++;
          else if (line[i] === ')' && --depth === 0) return line.slice(at, i + 1).slice(0, 120);
        }
      }
    }
    return undefined;
  }

  private view(agent: string, file: string) { return this.seen.get(agent)?.get(file) ?? this.base.get(file); }

  contentChanged(agent: string, worktree: string, file: string): boolean {
    const p = join(worktree, file);
    const h = existsSync(p) ? md5(readFileSync(p, 'utf8')) : 'deleted';
    return h !== (this.contentHash.get(`${agent}|${file}`) ?? md5(this.base.get(file)?.source ?? ''));
  }

  async registerAgent(id: string, harness: string, worktree: string) {
    await this.g.query(`MERGE (a:Agent {id: $id}) SET a.harness = $h, a.worktree = $w, a.state = 'active', a.heartbeatAt = $t`,
      { id, h: harness, w: worktree, t: now() });
    this.emit('agent.registered', id, { harness, worktree });
  }

  /** Every hook: heartbeat, renew leases, implicit task from the first prompt (spec 5.1). */
  async touch(agent: string, root: string, input: ClaudeHookInput) {
    const t = now();
    const [r] = await this.g.query<{ fresh: boolean }>(`MERGE (a:Agent {id: $agent}) ON CREATE SET a.harness = 'claude', a.worktree = $root, a.startedAt = $t, a.fresh = true
      ON MATCH SET a.fresh = false
      SET a.heartbeatAt = $t, a.state = 'active', a.sessionId = coalesce($sid, a.sessionId) RETURN a.fresh AS fresh`, { agent, root, t, sid: input.session_id ?? null });
    if (r?.fresh) this.emit('agent.registered', agent, { harness: 'claude', worktree: root });
    if (input.hook_event_name === 'UserPromptSubmit' && input.prompt) {
      await this.g.query(`MATCH (a:Agent {id: $agent}) WHERE a.task IS NULL SET a.task = $task, a.taskTitle = $title`,
        { agent, task: `implicit:${input.session_id ?? agent}`, title: input.prompt.slice(0, 120) });
    }
    await renew(this.g, agent, t);
  }

  emit(type: EventType, agent: string | undefined, data: Record<string, unknown> = {}) {
    this.bus.emit({ type, at: now(), run: this.run, agent, data });
  }

  /** A changed HEAD since the last look means a commit: what it touched has landed. */
  async checkCommit(agent: string, root: string): Promise<string[]> {
    let head: string;
    try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return []; }
    const prev = this.heads.get(agent); this.heads.set(agent, head);
    if (!prev || prev === head) return [];
    let files: string[]; let message = '';
    try {
      files = execFileSync('git', ['diff', '--name-only', prev, head], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
      message = execFileSync('git', ['log', '-1', '--format=%B', head], { cwd: root, encoding: 'utf8' }).trim();
    } catch { return []; }
    return this.landed(agent, files, head, message);
  }

  /** Spec 5.1 rule 2: a commit releases the agent's leases on those files and lands its Changes; waiters wake. */
  landed(agent: string, files: string[], sha?: string, message = ''): Promise<string[]> {
    return this.serial(async () => {
      if (sha) {
        const [m] = await this.g.query<{ n: number }>(`MERGE (m:Commit {sha: $sha}) SET m.agent = $agent, m.at = $t, m.message = $message
          WITH m MATCH (c:Change {agent: $agent})-[:OF]->(s:Symbol) WHERE s.file IN $files
          OPTIONAL MATCH (c)-[x:IN]->(:Commit) WITH m, c, x WHERE x IS NULL
          MERGE (c)-[:IN]->(m) RETURN count(c) AS n`, { sha, agent, files, message, t: now() });
        this.emit('commit.recorded', agent, { sha, message: message.split('\n')[0], files, changes: m?.n ?? 0 });
      }
      const rows = await this.g.query<{ id: string }>(`MATCH (:Agent {id: $agent})-[l:LEASED]->(s:Symbol) WHERE s.file IN $files
        WITH l, s.id AS id DELETE l RETURN id`, { agent, files });
      await this.g.query(`MATCH (c:Change {agent: $agent})-[:OF]->(s:Symbol) WHERE s.file IN $files SET c.landed = true`, { agent, files });
      const ids = rows.map((r) => r.id);
      this.emit('change.landed', agent, { files, symbols: ids });
      await this.wake(agent, ids, 'landed');
      return ids;
    });
  }

  /** Spec 5.6: agents that stopped waiting on these symbols get one notice with the final signature. */
  private async wake(holder: string, sids: string[], why: 'landed' | 'lapsed'): Promise<void> {
    if (!sids.length) return;
    const ws = await this.g.query<{ b: string; sid: string; qname: string; sig: string }>(
      `MATCH (b:Agent)-[w:WAITS_ON]->(s:Symbol) WHERE s.id IN $sids WITH b, w, s DELETE w RETURN b.id AS b, s.id AS sid, s.qname AS qname, s.sig AS sig`,
      { sids });
    const t = now();
    for (const w of ws) {
      const after = await this.latestAfter(holder, w.sid);
      await this.g.query(`CREATE (n:Notice {id: $id, agent: $b, change: '', author: $holder, score: 1.0, status: 'pending', at: $t, text: $text, kind: 'wake'})`,
        { id: `wake:${holder}:${w.sid}>${w.b}:${t}`, b: w.b, holder, t, text: renderWake(holder, w.qname, after ?? w.sig, why) });
      this.emit('agent.woken', w.b, { holder, symbol: w.sid, why });
    }
  }

  private async latestAfter(agent: string, sid: string): Promise<string | null> {
    const [r] = await this.g.query<{ after: string }>(`MATCH (c:Change {agent: $agent, symbol: $sid}) WHERE c.after <> ''
      RETURN c.after AS after ORDER BY c.at DESC LIMIT 1`, { agent, sid });
    return r?.after ?? null;
  }

  /** Lapsed leases free their symbols and wake whoever waited on them. */
  sweep(at = now()): Promise<void> {
    return this.serial(async () => {
      const byAgent = new Map<string, string[]>();
      for (const x of await expired(this.g, at)) byAgent.set(x.agent, [...(byAgent.get(x.agent) ?? []), x.symbol]);
      for (const [a, sids] of byAgent) { this.emit('lease.released', a, { symbols: sids, why: 'lapsed' }); await this.wake(a, sids, 'lapsed'); }
    });
  }

  /** Spec 5.6: a delivered notice is resolved once the agent's own code fits the AFTER version. */
  private async resolveNotices(agent: string, touched: Set<string>) {
    const open = await this.g.query<{ id: string; payload: string; blocked: boolean }>(`MATCH (n:Notice {agent: $agent})
      WHERE n.status IN ['delivered', 'acknowledged'] MATCH (c:Change) WHERE c.id = n.change
      RETURN n.id AS id, c.payload AS payload, coalesce(n.blockedStop, false) AS blocked`, { agent });
    if (!open.length) return;
    const edited = new Set((await this.g.query<{ id: string }>(`MATCH (:Agent {id: $agent})-[:EDITED]->(s:Symbol) RETURN s.id AS id`, { agent })).map((r) => r.id));
    const calls = [...(this.seen.get(agent)?.values() ?? [])].flatMap((i) => i.calls).filter((k) => edited.has(k.from));
    const done: string[] = [];
    for (const n of open) {
      const ch = JSON.parse(n.payload) as ChangeRec;
      const mine = calls.filter((k) => k.to.includes(ch.symbol.id));
      const ok = ch.kind === 'removed' ? mine.length === 0
        : ch.kind === 'contract' ? mine.every((k) => callSatisfies(k, ch.after?.params) !== false)
        : mine.some((k) => touched.has(k.from));
      if (ok) done.push(n.id);
      if (ok && n.blocked && this.lessons) {                             // spec §5.10 T1: it took a blocked Stop to fix this
        const after = ch.after?.sig ?? (ch.renamedTo ? ch.renamedTo.sig : 'no call (removed)');
        const l = await this.lessons.record('T1', [ch.symbol.id],
          `Callers of ${ch.symbol.qname} must use \`${after}\` (was \`${ch.symbol.sig}\`); ${agent} missed this until blocked.`, this.run);
        this.emit('lesson.recorded', agent, { id: l.id, hits: l.hits });
      }
    }
    if (done.length) {
      await this.g.query(`UNWIND $ids AS id MATCH (n:Notice {id: id}) SET n.status = 'resolved', n.resolvedAt = $t`, { ids: done, t: now() });
      this.emit('notice.resolved', agent, { ids: done });
    }
  }

  /** Spec 5.6 Stop gate: rules 1–4 and the shared cap. */
  stopGate(agent: string, stopHookActive: boolean) {
    return this.serial(async (): Promise<{ block: false } | { block: true; rule: Rule; reason: string }> => {
      if (stopHookActive && this.lastBlock.get(agent) === 'barrier') { this.lastBlock.delete(agent); return { block: false }; }
      const key = `${agent}|${await this.task(agent)}`;
      const blockWith = (rule: Rule, reason: string) => {
        const n = (this.blocks.get(key) ?? 0) + 1;
        if (n > Coordinator.MAX_BLOCKS) { this.emit('gate.escalated', agent, { rule }); return { block: false } as const; }
        this.blocks.set(key, n); this.lastBlock.set(agent, rule);
        this.emit('gate.blocked', agent, { rule, reason });
        return { block: true, rule, reason } as const;
      };
      const markBlocked = (ids: string[]) =>
        this.g.query(`UNWIND $ids AS id MATCH (n:Notice {id: id}) SET n.blockedStop = true`, { ids });

      const pending = await this.takeNoticesUnlocked(agent);
      if (pending.length) { await markBlocked(pending.map((p) => p.id)); return blockWith('notices', pending.map((x) => x.text).join('\n\n')); }

      await this.resolveNotices(agent, new Set());                         // a reader whose code never calls it has nothing to fix
      const open = await this.g.query<{ id: string; text: string; blocked: boolean }>(`MATCH (n:Notice {agent: $agent, status: 'delivered'})
        WHERE n.score >= 0.6 RETURN n.id AS id, n.text AS text, coalesce(n.blockedStop, false) AS blocked`, { agent });
      const seen = open.filter((o) => o.blocked).map((o) => o.id);
      if (seen.length) await this.g.query(`UNWIND $ids AS id MATCH (n:Notice {id: id}) SET n.status = 'acknowledged'`, { ids: seen });
      const fresh = open.filter((o) => !o.blocked);
      if (fresh.length) {
        await markBlocked(fresh.map((f) => f.id));
        return blockWith('notices', `${fresh.map((f) => f.text).join('\n\n')}\n\nThese notices are still unresolved: your code does not yet match the AFTER version.`);
      }

      const claims = await this.g.query<{ task: string; state: string; strength: number | null; blindSpots: string[] | null; missing: string | null }>(
        `MATCH (c:Claim {agent: $agent}) RETURN c.task AS task, c.state AS state, c.strength AS strength, c.blindSpots AS blindSpots, c.missing AS missing`, { agent });
      const gaps = claims.map((c) => [c.task, claimGap(c)] as const).filter(([, gap]) => gap);
      if (gaps.length) {
        return blockWith('claim', `[loom] you claimed done, but the evidence does not hold:\n${gaps.map(([t, gap]) => `  ${t}: ${gap}`).join('\n')}\nFix it, then call claim_done again.`);
      }

      const t = now();
      const bar = await this.g.query<{ holder: string; sid: string; qname: string }>(
        `MATCH (b:Agent {id: $agent})-[:READ|EDITED]->(d:Symbol)
         OPTIONAL MATCH (d)-[:CALLS*1..3]->(e:Symbol)
         WITH b, collect(DISTINCT d) + collect(DISTINCT e) AS deps
         UNWIND deps AS s
         WITH DISTINCT b, s
         MATCH (o:Agent)-[l:LEASED]->(s) WHERE o.id <> $agent AND l.contract = true AND l.expires > $t AND o.heartbeatAt > $t - $idle
         OPTIONAL MATCH (b)-[w:WAITS_ON]->(s)
         WITH o, s, w WHERE w IS NULL
         RETURN DISTINCT o.id AS holder, s.id AS sid, s.qname AS qname`,
        { agent, t, idle: Coordinator.IDLE_MS });
      if (!bar.length) return { block: false };
      await this.g.query(`MATCH (b:Agent {id: $agent}) UNWIND $sids AS sid MATCH (s:Symbol {id: sid}) MERGE (b)-[w:WAITS_ON]->(s) SET w.at = $t`,
        { agent, sids: bar.map((x) => x.sid), t });
      const rows = await Promise.all(bar.map(async (x) => ({ ...x, after: await this.latestAfter(x.holder, x.sid) })));
      return blockWith('barrier', renderBarrier(rows));
    });
  }

  async status(at = now()) {
    const agents = await this.g.query<{ id: string; heartbeatAt: number | null; task: string | null; taskTitle: string | null; worktree: string }>(
      `MATCH (a:Agent) RETURN a.id AS id, a.heartbeatAt AS heartbeatAt, a.task AS task, a.taskTitle AS taskTitle, a.worktree AS worktree ORDER BY a.id`);
    const leases = await this.g.query<{ agent: string; symbol: string; mode: string; contract: boolean; expires: number }>(
      `MATCH (a:Agent)-[l:LEASED]->(s:Symbol) WHERE l.expires > $at RETURN a.id AS agent, s.id AS symbol, l.mode AS mode,
       coalesce(l.contract, false) AS contract, l.expires AS expires ORDER BY agent, symbol`, { at });
    const notices = await this.g.query<{ agent: string; status: string; n: number }>(
      `MATCH (n:Notice) RETURN n.agent AS agent, n.status AS status, count(n) AS n ORDER BY agent, status`);
    return {
      agents: agents.map((a) => ({ ...a, state: at - (a.heartbeatAt ?? 0) > Coordinator.IDLE_MS ? 'idle' : 'active' })),
      leases, notices, events: this.bus.recent(this.run, 50),
    };
  }

  forceRelease(agent: string): Promise<string[]> {
    return this.serial(async () => {
      const ids = await release(this.g, agent);
      this.emit('lease.released', agent, { symbols: ids, forced: true });
      await this.wake(agent, ids, 'lapsed');
      return ids;
    });
  }

  /** Spec §5.1 cause 1: a spawned worker is gone, so its leases go now (TTL would only delay waiters); non-zero fails its task. */
  async exited(agent: string, code: number): Promise<string[]> {
    const ids = await this.forceRelease(agent);
    if (code !== 0) await this.g.query(`MATCH (a:Agent {id: $agent})-[:ON]->(t:Task) WHERE t.id = a.task SET t.state = 'failed'`, { agent });
    this.emit('agent.state', agent, { state: 'exited', code });
    return ids;
  }

  /** Spec §3.3 claim_task: the agent's current task, as a node `why` can reach. */
  async claimTask(agent: string, t: { id: string; title: string; prompt?: string }) {
    await this.g.query(`MERGE (t:Task {id: $id}) SET t.title = $title, t.prompt = $prompt, t.run = $run
      MERGE (a:Agent {id: $agent}) SET a.task = $id, a.taskTitle = $title MERGE (a)-[:ON]->(t)`,
    { id: t.id, title: t.title, prompt: t.prompt ?? '', run: this.run, agent });
    this.emit('task.claimed', agent, { task: t.id, title: t.title });
  }

  /** Spec §5.8: an explicit design decision, tied to the symbols it constrains and the agent's task. */
  async recordDecision(agent: string, text: string, symbols: string[]): Promise<string> {
    const id = `D${(++this.seq).toString(36)}-${now().toString(36)}`;
    const task = await this.task(agent);
    const [r] = await this.g.query<{ n: number }>(`MERGE (a:Agent {id: $agent})
      MERGE (t:Task {id: $task}) ON CREATE SET t.title = coalesce(a.taskTitle, ''), t.run = $run
      MERGE (a)-[:ON]->(t)
      CREATE (d:Decision {id: $id, text: $text, agent: $agent, at: $t})-[:FOR]->(t)
      WITH d UNWIND $symbols AS sid MATCH (s:Symbol {id: sid}) MERGE (d)-[:CONSTRAINS]->(s) RETURN count(s) AS n`,
    { agent, task, run: this.run, id, text, t: now(), symbols: symbols.length ? symbols : ['::none::'] });   // UNWIND [] would drop the Decision; no symbol id has this form
    this.emit('decision.recorded', agent, { id, text, symbols, linked: r?.n ?? 0 });
    return id;
  }

  async agentAt(worktree: string): Promise<string | null> {
    const [r] = await this.g.query<{ id: string }>(`MATCH (a:Agent {worktree: $w}) RETURN a.id AS id ORDER BY a.heartbeatAt DESC LIMIT 1`, { w: worktree });
    return r?.id ?? null;
  }

  /** MCP `lease`: explicit lease through the same CAS; a denial names the holders. */
  async lease(agent: string, sids: string[], mode: LeaseMode) {
    const known = sids.filter((s) => this.known.has(s));
    if (!known.length) return { granted: false, holders: [], reason: 'no such symbols in this run' };
    if (await acquire(this.g, agent, known, mode, await this.task(agent))) {
      this.emit('lease.granted', agent, { symbols: known, mode });
      return { granted: true, symbols: known };
    }
    const hs = await holders(this.g, agent, known, mode);
    this.emit('lease.denied', agent, { symbols: known, mode, holder: hs[0]?.holder, reason: 'mcp' });
    return { granted: false, holders: hs };
  }

  release(agent: string, sids?: string[]): Promise<string[]> {
    return this.serial(async () => {
      const ids = await release(this.g, agent, sids);
      if (ids.length) { this.emit('lease.released', agent, { symbols: ids }); await this.wake(agent, ids, 'lapsed'); }
      return ids;
    });
  }

  /** Spec §5.5 without the agent filter: callers within 3 CALLS hops and who is on them. */
  async impact(target: string) {
    return this.g.query<{ symbol: string; hops: number; agents: string[] }>(
      `MATCH p = (c:Symbol)-[:CALLS*1..3]->(s:Symbol) WHERE s.id = $t OR s.qname = $t
       WITH c, min(length(p)) AS hops
       OPTIONAL MATCH (a:Agent)-[:LEASED|EDITED|READ]->(c)
       RETURN c.id AS symbol, hops, collect(DISTINCT a.id) AS agents ORDER BY hops, symbol LIMIT 100`, { t: target });
  }

  /** Agents with LEASED/EDITED/READ on a symbol, or on any symbol of a file. */
  async whoIsTouching(pathOrSymbol: string) {
    return this.g.query<{ agent: string; rel: string; symbol: string }>(
      `MATCH (a:Agent)-[r:LEASED|EDITED|READ]->(s:Symbol) WHERE s.id = $p OR s.file = $p OR s.qname = $p
       RETURN DISTINCT a.id AS agent, type(r) AS rel, s.id AS symbol ORDER BY agent, symbol`, { p: pathOrSymbol });
  }

  agentNotices(agent: string) {
    return this.g.query(`MATCH (n:Notice {agent: $agent}) RETURN n.id AS id, n.author AS author, n.score AS score,
      n.status AS status, n.how AS how, n.text AS text ORDER BY n.at`, { agent });
  }

  async ackNotice(agent: string, id: string, how: 'no-impact' | 'adapted') {
    const [r] = await this.g.query<{ n: number }>(`MATCH (n:Notice {id: $id, agent: $agent})
      SET n.status = 'resolved', n.how = $how, n.resolvedAt = $t RETURN count(n) AS n`, { id, agent, how, t: now() });
    if (r?.n) this.emit('notice.resolved', agent, { ids: [id], how });
    return { acked: Boolean(r?.n) };
  }

  /** Spec §3.3 claim_done → §5.9: tests that exercise the agent's changes, run in its worktree, then mutation strength. */
  async claimDone(agent: string, task: string, evidence = '', mutate = true): Promise<ClaimResult> {
    const [a] = await this.g.query<{ wt: string | null }>(`MATCH (a:Agent {id: $agent}) RETURN a.worktree AS wt`, { agent });
    const worktree = a?.wt ?? undefined;
    const r = await verifyClaim(this.g, { agent, task, worktree, cfg: worktree ? cfgFor(worktree) : null, mutate, evidence });
    this.emit('claim.updated', agent, { task, state: r.state, strength: r.strength, blindSpots: r.blindSpots, missing: r.missing });
    if (r.state === 'FAIL' && this.lessons) await this.serial(() => this.lessonT3(agent, r));
    return r;
  }

  /** Spec §5.10 T3: the agent was told a symbol changed, never adapted a caller its tests cover, and those tests failed. */
  private async lessonT3(agent: string, r: ClaimResult) {
    const open = await this.g.query<{ payload: string }>(`MATCH (n:Notice {agent: $agent}) WHERE n.status IN ['delivered', 'acknowledged']
      MATCH (c:Change) WHERE c.id = n.change RETURN c.payload AS payload`, { agent });
    if (!open.length) return;
    const covered = new Set((await this.g.query<{ id: string }>(`MATCH (r:TestRun {agent: $agent}) WITH r ORDER BY r.at DESC LIMIT 1
      MATCH (r)-[:COVERS]->(s:Symbol) RETURN s.id AS id`, { agent })).map((x) => x.id));
    const calls = [...(this.seen.get(agent)?.values() ?? [])].flatMap((i) => i.calls);
    const label = (r.failing ?? r.labels)[0];
    for (const n of open) {
      const ch = JSON.parse(n.payload) as ChangeRec;
      const k = calls.find((x) => x.to.includes(ch.symbol.id) && covered.has(x.from));
      if (!k) continue;
      const caller = k.from.slice(k.from.indexOf('::') + 2);
      const l = await this.lessons!.record('T3', [ch.symbol.id, k.from],
        `${agent} was told ${ch.symbol.qname} changed but ${caller} was not adapted; ${label} failed.`, this.run);
      this.emit('lesson.recorded', agent, { id: l.id, hits: l.hits });
    }
  }

  /** Spec §5.10 injection scope: the agent's plan task scope, else the first file it touched; plus CALLS neighbours two hops out. */
  async lessonScope(agent: string): Promise<string[]> {
    const task = await this.task(agent);
    let ids = this.plan?.tasks.find((t) => t.id === task)?.scope ?? [];
    const f = this.firstFile.get(agent);
    if (!ids.length && f) ids = (this.view(agent, f) ?? this.base.get(f))?.symbols.map((s) => s.id) ?? [];
    if (!ids.length) return [];
    const near = await this.g.query<{ id: string }>(`MATCH (s:Symbol)-[:CALLS*1..2]-(n:Symbol) WHERE s.id IN $ids RETURN DISTINCT n.id AS id`, { ids });
    return [...new Set([...ids, ...near.map((x) => x.id)])];
  }

  /** Up to three lessons for the agent's scope, once per agent: null when already told or when there is no scope yet. */
  async pendingLessons(agent: string): Promise<string | null> {
    if (!this.lessons || this.told.has(agent)) return null;
    const scope = await this.lessonScope(agent);
    if (!scope.length) return null;
    this.told.add(agent);
    const ls = await this.lessons.about(scope, 3);
    if (!ls.length) return null;
    this.emit('lesson.injected', agent, { ids: ls.map((l) => l.id) });
    return `[loom] lessons:\n${ls.map((l) => `- ${l.text}`).join('\n')}`;
  }

  /** Every claim with its evidence, for `loom verify` and the dashboard's Verify view. */
  claims() {
    return this.g.query<{ task: string; agent: string; state: string; strength: number | null; blindSpots: string[] | null; missing: string | null; labels: string[] | null; at: number }>(
      `MATCH (c:Claim) RETURN c.task AS task, c.agent AS agent, c.state AS state, c.strength AS strength, c.blindSpots AS blindSpots,
        c.missing AS missing, c.labels AS labels, c.at AS at ORDER BY c.at DESC`);
  }

  /** Spec §5.9 decay: an edit after verification makes that evidence stale. */
  private async decay(agent: string, ids: string[], names: string[]) {
    await this.g.query(`UNWIND $ids AS id MATCH (r:TestRun {agent: $agent})-[:COVERS]->(:Symbol {id: id}) SET r.stale = true`, { ids, agent });
    const rows = await this.g.query<{ task: string }>(`MATCH (c:Claim {agent: $agent}) WHERE c.state = 'VERIFIED'
      SET c.state = 'STALE', c.missing = $why RETURN c.task AS task`, { agent, why: `evidence stale: ${names.join(', ')} changed after verification` });
    for (const r of rows) this.emit('claim.updated', agent, { task: r.task, state: 'STALE' });
  }

  /** Symbols of `file` in this agent's view, optionally within a line range. */
  symbolsAt(agent: string, file: string, start?: number, end?: number): string[] {
    return (this.view(agent, file)?.symbols ?? [])
      .filter((s) => (start === undefined || s.endLine >= start) && (end === undefined || s.startLine <= end)).map((s) => s.id);
  }

  private async task(agent: string): Promise<string> {
    const [r] = await this.g.query<{ task: string | null }>(`MATCH (a:Agent {id: $agent}) RETURN a.task AS task`, { agent });
    return r?.task ?? `implicit:${agent}`;
  }

  /** Spec 5.2: take a lease before the edit lands; deny with the holder's pending change when it conflicts. */
  async preEdit(agent: string, worktree: string, it: EditIntent): Promise<{ allow: true } | { allow: false; reason: string }> {
    if (!it.file.endsWith('.py')) return { allow: true };
    const p = join(worktree, it.file);
    const current = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const next = applyEdits(current, it);
    if (next === null) return { allow: true };
    const { sids, mode } = await predictLease(it.file, current, next);
    const known = sids.filter((s) => this.known.has(s));
    if (!mode || !known.length) return { allow: true };
    if (await acquire(this.g, agent, known, mode, await this.task(agent))) {
      this.emit('lease.granted', agent, { symbols: known, mode });
      return { allow: true };
    }
    const reason = await this.denyReason(agent, known, mode);
    const hs = await holders(this.g, agent, known, mode);
    const [h] = hs;
    // a denial is a wait: when the holder lands, wake() tells this agent (and `loom run` resumes it on the merged code)
    await this.g.query(`MATCH (b:Agent {id: $agent}) UNWIND $sids AS sid MATCH (s:Symbol {id: sid}) MERGE (b)-[w:WAITS_ON]->(s) SET w.at = $t`,
      { agent, sids: [...new Set(hs.map((x) => x.symbol))], t: now() });
    this.emit('lease.denied', agent, { symbols: known, mode, holder: h?.holder, reason });
    return { allow: false, reason };
  }

  private async denyReason(agent: string, sids: string[], mode: LeaseMode): Promise<string> {
    const hs = await holders(this.g, agent, sids, mode);
    const out = ['[loom] edit blocked before it happened:'];
    for (const h of hs) {
      const [ch] = await this.g.query<{ before: string; after: string }>(`MATCH (c:Change {agent: $a, symbol: $s})
        RETURN c.before AS before, c.after AS after ORDER BY c.at DESC LIMIT 1`, { a: h.holder, s: h.symbol });
      out.push(`  ${h.symbol} is leased by agent ${h.holder} (${h.contract ? 'contract' : h.mode}${h.task ? `, task ${h.task}` : ''}).`);
      if (ch?.after) out.push(`  ${h.holder}'s pending change: ${ch.before} → ${ch.after}`);
    }
    out.push(mode === 'contract' && !hs.some((h) => h.mode === 'write')   // a write holder owns the body too
      ? `  You were about to change that signature. Keep the signature as ${hs[0]?.holder ?? 'the holder'} has it and change only the body, or work on something else; the lease frees when they commit or after 10 min idle.`
      : '  Another agent is editing that body. Work on something else first; if nothing else is left, finish now: Loom wakes you with their change once they commit.');
    return out.join('\n');
  }

  onRead(agent: string, file: string, start?: number, end?: number) {
    return this.serial(async () => {
      const idx = this.view(agent, file);
      if (!idx) return;
      if (!this.firstFile.has(agent)) this.firstFile.set(agent, file);
      const hit = idx.symbols.filter((s) => (start === undefined || s.endLine >= start) && (end === undefined || s.startLine <= end));
      if (!hit.length) return;
      await this.g.query(`MATCH (a:Agent {id: $agent}) UNWIND $rows AS r MATCH (s:Symbol {id: r.id})
        MERGE (a)-[e:READ]->(s) SET e.at = $t, e.sigHash = r.sigHash`,
      { agent, t: now(), rows: hit.map((s) => ({ id: s.id, sigHash: s.sigHash })) });
      await this.noticeExisting(agent, hit.map((s) => s.id), 'READ');
    });
  }

  onEdit(agent: string, worktree: string, file: string) {
    return this.serial(async () => {
      const p = join(worktree, file);
      const prev = this.view(agent, file);
      const next = existsSync(p) ? await indexPython(file, readFileSync(p, 'utf8')) : undefined;
      if (!this.seen.has(agent)) this.seen.set(agent, new Map());
      if (!this.firstFile.has(agent)) this.firstFile.set(agent, file);
      if (next) this.seen.get(agent)!.set(file, next); else this.seen.get(agent)!.delete(file);
      this.contentHash.set(`${agent}|${file}`, next ? md5(next.source) : 'deleted');

      const changes = diffFile(prev, next);
      const added = changes.filter((c) => c.kind === 'added').map((c) => c.symbol);
      added.forEach((s) => this.known.add(s.id));
      if (added.length) await this.batch(UPSERT_SYMBOLS, added.map((s) => symRow(s, agent)));
      const touched = changes.map((c) => c.symbol.id);
      if (touched.length) {
        await this.g.query(`MATCH (a:Agent {id: $agent}) UNWIND $ids AS id MATCH (s:Symbol {id: id})
          MERGE (a)-[e:EDITED]->(s) SET e.at = $t`, { agent, ids: touched, t: now() });
      }
      if (next) {
        const fresh = new Set(changes.filter((c) => c.kind !== 'removed').map((c) => c.symbol.id));
        const rows = this.callRows(next, fresh);
        if (rows.length) await this.batch(UPSERT_CALLS, rows);
        // write-after-change: this agent now depends on symbols someone else already changed
        await this.noticeExisting(agent, [...new Set(rows.map((r) => r.to))], 'EDITED', 1);
      }
      let notices = 0;
      for (const ch of changes.filter((c) => c.kind !== 'added')) notices += await this.recordChange(agent, ch);
      const real = changes.filter((c) => c.kind !== 'added');
      if (real.length) await this.decay(agent, real.map((c) => c.symbol.id), real.map((c) => c.symbol.name));
      await this.resolveNotices(agent, new Set(touched));
      return { changes: changes.length, notices };
    });
  }

  private async recordChange(agent: string, ch: ChangeRec): Promise<number> {
    const id = `${this.run}:${agent}:${ch.symbol.id}:${++this.seq}`;
    await this.g.query(`MATCH (s:Symbol {id: $sid}) CREATE (c:Change {id: $id, agent: $agent, kind: $kind, symbol: $sid,
      before: $before, after: $after, payload: $payload, at: $t, task: $task})-[:OF]->(s)`, {
      sid: ch.symbol.id, id, agent, task: await this.task(agent), kind: ch.kind, before: ch.symbol.sig, after: ch.after?.sig ?? ch.renamedTo?.sig ?? '',
      payload: JSON.stringify(ch), t: now(),
    });
    this.emit('change.recorded', agent, { id, symbol: ch.symbol.id, kind: ch.kind, before: ch.symbol.sig, after: ch.after?.sig ?? ch.renamedTo?.sig ?? '' });
    const direct = await this.g.query<{ agent: string; rel: string }>(
      `MATCH (b:Agent)-[r:READ|EDITED|LEASED]->(s:Symbol {id: $sid}) WHERE b.id <> $agent RETURN b.id AS agent, type(r) AS rel`,
      { sid: ch.symbol.id, agent });
    const indirect = await this.g.query<{ agent: string; rel: string; hops: number; path: string[] }>(
      `MATCH p = (c:Symbol)-[:CALLS*1..3]->(s:Symbol {id: $sid}) MATCH (b:Agent)-[r:READ|EDITED|LEASED]->(c)
       WHERE b.id <> $agent RETURN b.id AS agent, type(r) AS rel, length(p) AS hops, [n IN nodes(p) | n.qname] AS path`,
      { sid: ch.symbol.id, agent });
    const best = new Map<string, { s: number; rel: string; hops: number; path: string[] }>();
    for (const r of [...direct.map((d) => ({ ...d, hops: 0, path: [ch.symbol.qname] })), ...indirect]) {
      const s = score(r.rel, r.hops, ch.kind);
      const cur = best.get(r.agent);
      // on a tie, the agent's own edited code wins: it is what breaks at merge, so name it
      if (!cur || s > cur.s || (s === cur.s && r.rel === 'EDITED' && cur.rel !== 'EDITED')) {
        best.set(r.agent, { s, rel: r.rel, hops: r.hops, path: r.path });
      }
    }
    let n = 0;
    for (const [target, v] of best) {
      if (v.s >= THRESHOLD && await this.createNotice(id, agent, target, ch, v)) n++;
    }
    return n;
  }

  private async noticeExisting(agent: string, ids: string[], rel: string, hops = 0) {
    if (!ids.length) return;
    const rows = await this.g.query<{ id: string; author: string; payload: string }>(
      `UNWIND $ids AS sid MATCH (c:Change)-[:OF]->(:Symbol {id: sid}) WHERE c.agent <> $agent
       RETURN c.id AS id, c.agent AS author, c.payload AS payload`, { ids, agent });
    for (const r of rows) {
      const ch = JSON.parse(r.payload) as ChangeRec;
      const s = score(rel, hops, ch.kind);
      if (s >= THRESHOLD) await this.createNotice(r.id, r.author, agent, ch, { s, rel, hops, path: [ch.symbol.qname] });
    }
  }

  private async createNotice(changeId: string, author: string, target: string, ch: ChangeRec,
    v: { s: number; rel: string; hops: number; path: string[] }): Promise<boolean> {
    const [row] = await this.g.query<{ isNew: boolean }>(
      `MERGE (n:Notice {id: $id})
       ON CREATE SET n.agent = $target, n.change = $cid, n.author = $author, n.score = $score, n.text = $text, n.via = $via,
                     n.status = 'pending', n.at = $t, n.isNew = true
       ON MATCH SET n.isNew = false
       RETURN n.isNew AS isNew`,
      { id: `${changeId}>${target}`, target, cid: changeId, author, score: v.s, t: now(), via: JSON.stringify(v),
        text: renderNotice(author, ch, { rel: v.rel, hops: v.hops, path: v.path }) });
    if (row?.isNew) this.emit('notice.created', target, { id: `${changeId}>${target}`, author, symbol: ch.symbol.id, score: v.s, path: v.path });
    return Boolean(row?.isNew);
  }

  takeNotices(agent: string): Promise<NoticeOut[]> {
    return this.serial(() => this.takeNoticesUnlocked(agent));
  }

  private async takeNoticesUnlocked(agent: string): Promise<NoticeOut[]> {
    const pending = await this.g.query<NoticeOut & { author: string; via: string | null; payload: string | null }>(
      `MATCH (n:Notice {agent: $agent, status: 'pending'}) OPTIONAL MATCH (c:Change) WHERE c.id = n.change
       RETURN n.id AS id, n.text AS text, n.score AS score, n.author AS author, n.via AS via, c.payload AS payload
       ORDER BY n.score DESC LIMIT ${MAX_PER_DELIVERY}`, { agent });
    // render at delivery: the author's callers may have been ingested after the notice was created
    const rows: NoticeOut[] = pending.map((r) => {
      if (!r.payload || !r.via) return { id: r.id, score: r.score, text: r.text };       // wake notices carry their own text
      const ch = JSON.parse(r.payload) as ChangeRec;
      return { id: r.id, score: r.score, text: renderNotice(r.author, ch, JSON.parse(r.via), this.callExample(r.author, ch)) };
    });
    if (rows.length) {
      await this.g.query(`UNWIND $rows AS r MATCH (n:Notice {id: r.id}) SET n.status = 'delivered', n.deliveredAt = $t, n.text = r.text`,
        { rows: rows.map((r) => ({ id: r.id, text: r.text })), t: now() });
      this.emit('notice.delivered', agent, { ids: rows.map((r) => r.id) });
    }
    return rows;
  }

  async touched(agent: string, kind: 'read' | 'edit', file?: string): Promise<boolean> {
    const rel = kind === 'edit' ? 'EDITED' : 'READ|EDITED';
    const where = file ? 'WHERE s.file = $file' : '';
    const [r] = await this.g.query<{ n: number }>(
      `MATCH (:Agent {id: $agent})-[e:${rel}]->(s:Symbol) ${where} RETURN count(e) AS n`, { agent, file: file ?? null });
    return (r?.n ?? 0) > 0;
  }

  /** Dashboard view: symbols any agent touches, their 1-hop CALLS neighbours, and the live coordination state. */
  async snapshot() {
    const nodes = await this.g.query<{ id: string; qname: string; file: string; kind: string }>(
      `MATCH (:Agent)-[:LEASED|READ|EDITED|WAITS_ON]->(s:Symbol)
       OPTIONAL MATCH (s)-[:CALLS]-(n:Symbol)
       WITH collect(DISTINCT s) + collect(DISTINCT n) AS ss UNWIND ss AS x WITH DISTINCT x LIMIT 300
       RETURN x.id AS id, x.qname AS qname, x.file AS file, x.kind AS kind`);
    const ids = nodes.map((n) => n.id);
    const edges = await this.g.query<{ from: string; to: string }>(
      `MATCH (a:Symbol)-[:CALLS]->(b:Symbol) WHERE a.id IN $ids AND b.id IN $ids RETURN a.id AS from, b.id AS to`, { ids });
    const st = await this.status();
    return { nodes, edges, agents: st.agents, leases: st.leases, notices: await this.allNotices() };
  }

  allNotices() {
    return this.g.query(`MATCH (n:Notice) RETURN n.id AS id, n.agent AS agent, n.author AS author, n.score AS score,
      n.status AS status, n.kind AS kind, n.at AS at, n.deliveredAt AS deliveredAt, n.text AS text ORDER BY n.at`);
  }
}
