// §6 live coordination on regions: leases before an edit, notices after it, wakes when the holder lands or lapses.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { buildEdges, diffRegions, regionize, type Edge, type FileRegions, type Region } from '@loom/indexer';
import { lessonsFor, ulid } from '@loom/memory';
import { acquire, expired, holders, release, renew } from '../lease.js';
import { MAX_PER_DELIVERY, score, THRESHOLD } from '../notice.js';
import type { EditIntent } from '../predict.js';
import { handover, type Handover } from './handover.js';
import * as R from './render.js';
import { ackStale, staleRegions } from './stale.js';
import { predictTouched } from './touch.js';

export interface LiveAgent { id: string; person: string; worktree: string; top: string; upstream: string | null; run: string | null; task: string | null; scope: string[] }
type Row = LiveAgent & { syncPending: boolean };
type Kind = 'contract' | 'body' | 'removed';
type Decision = { allow: true; context?: string } | { allow: false; reason: string };
import type { CollisionIn } from '../team/collide.js';
export interface LiveOpts { now?: () => number; backoffMs?: number; stale?: typeof staleRegions }

const BACKOFF_DENIALS = 3;
const HOPS = 3;
const SCORE_KIND = { contract: 'contract', body: 'behavior', removed: 'removed' } as const;
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

export class Live {
  private lock: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly backoffMs: number;
  private readonly stale: typeof staleRegions;
  private readonly denials = new Map<string, number[]>();   // agent|region → denial times inside the window
  private readonly blocked = new Set<string>();             // agent|region past RC5: bare deny until woken
  private readonly views = new Map<string, string | null>(); // agent|file → the text the agent last reported
  private readonly parsed = new Map<string, FileRegions>();   // agent|file → that text, regionized: the next diff's before side
  private readonly seen = new Map<string, Map<string, string>>(); // agent → file → blob it last saw
  private seq = 0;
  /** Set by LiveRoutes for a run: parties name agents, the team fills in people and sessions. */
  onCollision?: (c: CollisionIn) => void;
  private party = (agent: string) => ({ person: '', session: agent, agent });

  constructor(private readonly g: LoomGraph, o: LiveOpts = {}) {
    this.now = o.now ?? Date.now;
    this.backoffMs = o.backoffMs ?? 60_000;
    this.stale = o.stale ?? staleRegions;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => undefined);
    return p;
  }

  register(a: LiveAgent): Promise<void> {
    return this.serial(async () => {
      await this.g.query(`MERGE (a:Agent {id: $id}) SET a.person = $person, a.worktree = $worktree, a.top = $top, a.upstream = $upstream,
        a.run = $run, a.task = $task, a.scope = $scope`, { ...a });
    });
  }

  preEdit(agent: string, it: EditIntent): Promise<Decision> { return this.serial(() => this.preEditU(agent, it)); }
  postEdit(agent: string, file: string) { return this.serial(() => this.postEditU(agent, file)); }
  unseen(agent: string) { return this.serial(() => this.unseenU(agent)); }
  takeNotices(agent: string) { return this.serial(() => this.takeU(agent)); }
  ack(agent: string, noticeId: string) { return this.serial(() => this.ackU(agent, noticeId)); }
  land(agent: string, regions: string[], v?: { sha: string; task: string | null }) { return this.serial(() => this.landU(agent, regions, v)); }
  sweep() { return this.serial(() => this.sweepU()); }
  release(agent: string) { return this.serial(() => this.releaseU(agent)); }
  syncIfPending(agent: string) { return this.serial(async () => { const a = await this.agent(agent); return a ? this.syncU(a) : null; }); }

  private async agent(id: string): Promise<Row | null> {
    const [r] = await this.g.query<Row>(`MATCH (a:Agent {id: $id}) RETURN a.id AS id, a.person AS person, a.worktree AS worktree, a.top AS top,
      a.upstream AS upstream, a.run AS run, a.task AS task, coalesce(a.scope, []) AS scope, coalesce(a.syncPending, false) AS syncPending`, { id });
    if (r) await renew(this.g, id, this.now());
    return r ?? null;
  }

  private async regions(ids: string[]) {
    const rows = await this.g.query<{ id: string; qname: string; path: string; sig: string | null }>(
      'MATCH (r:Region) WHERE r.id IN $ids RETURN r.id AS id, r.qname AS qname, r.path AS path, r.sig AS sig', { ids });
    return new Map(rows.map((r) => [r.id, r]));
  }
  private qn = (m: Map<string, { qname: string }>, id: string) => m.get(id)?.qname ?? id.split('::')[1] ?? id;

  private async allow(regions: string[]): Promise<Decision> {
    const ls = await lessonsFor(this.g, regions);
    return ls.length ? { allow: true, context: R.renderLessons(ls) } : { allow: true };
  }

  private async preEditU(agent: string, it: EditIntent): Promise<Decision> {
    let a = await this.agent(agent);
    if (!a) return { allow: true };
    if (await this.syncU(a)) a = (await this.agent(agent))!;
    const t = await predictTouched(a.worktree, it);
    if (!t || !t.mode) return this.allow(t?.created ?? []);
    const meta = await this.regions(t.ids);
    const ids = t.ids.filter((i) => meta.has(i));   // regions the graph has never seen have nothing to lease
    if (!ids.length) return this.allow(t.created);
    const now = this.now();

    const gated = ids.find((r) => this.blocked.has(`${agent}|${r}`));
    if (gated) return { allow: false, reason: R.renderGate(this.qn(meta, gated)) };

    if (a.upstream) {
      const st = await this.stale(this.g, a.top, ids, { upstream: a.upstream, me: { person: a.person, agent, run: !!a.run } });
      if (st.length) {
        if (a.run) {
          // a run's agent cannot pull by itself: Loom merges the landed work in, then denies once so it re-reads
          for (const s of st) await ackStale(this.g, agent, s.region, s.version);
          await this.g.query('MATCH (a:Agent {id: $agent}) SET a.syncPending = true', { agent });
          await this.syncU({ ...a, syncPending: true });
          return { allow: false, reason: R.renderStaleRun(st.map((s) => ({ summary: s.summary, qname: this.qn(meta, s.region) }))) };
        }
        const out: Array<{ summary: string; notice: string }> = [];
        for (const s of st) {
          const [n] = await this.g.query<{ id: string }>(`MERGE (n:Notice {agent: $agent, kind: 'stale', region: $region, version: $version})
            ON CREATE SET n.id = $id, n.author = $by, n.score = 1.0, n.status = 'delivered', n.at = $now RETURN n.id AS id`,
          { agent, region: s.region, version: s.version, id: ulid(now), by: s.by, now });
          out.push({ summary: s.summary, notice: n.id });
        }
        return { allow: false, reason: R.renderStale(out) };
      }
    }

    if (await acquire(this.g, agent, ids, t.mode, a.task ?? '', now)) {
      for (const r of ids) this.denials.delete(`${agent}|${r}`);
      return this.allow([...ids, ...t.created]);
    }
    const hs = await holders(this.g, agent, ids, t.mode, now);
    await this.g.query(`MATCH (b:Agent {id: $agent}) UNWIND $ids AS id MATCH (r:Region {id: id}) MERGE (b)-[w:WAITS_ON]->(r) SET w.at = $now`,
      { agent, ids: [...new Set(hs.map((h) => h.symbol))], now });
    for (const h of hs) this.onCollision?.({ kind: 'lock_denied', region: [h.symbol], parties: [this.party(agent), this.party(h.holder)], outcome: 'rejected',
      detail: `${agent} was refused ${this.qn(meta, h.symbol)}, held by ${h.holder}` });
    let tripped: { region: string; holder: string } | null = null;
    for (const h of hs) {
      const k = `${agent}|${h.symbol}`;
      const ts = [...(this.denials.get(k) ?? []).filter((x) => now - x < this.backoffMs), now];
      this.denials.set(k, ts);
      if (ts.length >= BACKOFF_DENIALS) { this.blocked.add(k); tripped ??= { region: h.symbol, holder: h.holder }; }
    }
    if (tripped) return { allow: false, reason: R.renderBackoff(this.qn(meta, tripped.region), tripped.holder) };
    const median = await this.medianTaskMs();
    const rows: R.DenyRow[] = [];
    for (const h of hs) {
      const [l] = await this.g.query<{ since: number | null }>('MATCH (:Agent {id: $h})-[l:LEASED]->(:Region {id: $r}) RETURN l.since AS since', { h: h.holder, r: h.symbol });
      rows.push({ holder: h.holder, qname: this.qn(meta, h.symbol), mode: h.contract ? 'contract' : h.mode, task: h.task,
        ageMs: l?.since == null ? null : now - l.since, medianMs: median });
    }
    return { allow: false, reason: R.renderDeny(rows) };
  }

  /** Median duration of finished tasks in this graph, or null when none has both ends recorded. */
  private async medianTaskMs(): Promise<number | null> {
    const ds = (await this.g.query<{ d: number }>('MATCH (t:Task) WHERE t.doneAt IS NOT NULL AND t.startedAt IS NOT NULL RETURN t.doneAt - t.startedAt AS d'))
      .map((r) => r.d).sort((x, y) => x - y);
    return ds.length ? ds[Math.floor(ds.length / 2)] : null;
  }

  private headText(wt: string, file: string): string | null {
    const r = git(wt, 'show', `HEAD:${file}`);
    return r.status === 0 ? r.stdout : null;
  }
  private fileText(wt: string, file: string): string | null {
    const p = join(wt, file);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  private async postEditU(agent: string, file: string) {
    const a = await this.agent(agent);
    if (!a) return { changed: [], notices: 0 };
    return this.observe(a, file, 'change');
  }

  /** Diff the file against the agent's last view, record a Change per touched region, and queue notices for dependents. */
  private async observe(a: Row, file: string, kind: 'change' | 'unleased_write') {
    const key = `${a.id}|${file}`;
    const before = this.views.has(key) ? this.views.get(key)! : this.headText(a.worktree, file);
    const after = this.fileText(a.worktree, file);
    this.views.set(key, after);
    if (before === null || before === after) return { changed: [], notices: 0 };
    const hit = this.parsed.get(key);
    const B = hit?.text === before ? hit : await regionize(file, before);
    const A = await regionize(file, after ?? '', { lastClean: B.degraded ? undefined : B });
    this.parsed.set(key, A);
    const sigB = new Map(B.regions.map((r) => [r.id, r.sig]));
    const sigA = new Map(A.regions.map((r) => [r.id, r.sig]));
    const changes = new Map<string, Kind>();
    if (A.degraded) for (const id of A.touched ?? []) changes.set(id, 'contract');
    else {
      const d = diffRegions(B.regions, A.regions);
      for (const id of d.updated) changes.set(id, sigB.get(id) !== sigA.get(id) ? 'contract' : 'body');
      for (const id of [...d.tombstoned, ...d.renamed.map((r) => r.from)]) changes.set(id, 'removed');
    }
    const now = this.now();
    let notices = A.degraded ? 0 : await this.liveEdges(a, A, now);
    for (const [region, k] of changes) {
      const cid = ulid(now);
      await this.g.query(`CREATE (:Change {id: $cid, agent: $agent, region: $region, kind: $k, beforeSig: $b, afterSig: $after, at: $now, seq: $seq})`,
        { cid, agent: a.id, region, k, b: sigB.get(region) ?? null, after: sigA.get(region) ?? null, now, seq: this.seq++ });
      notices += await this.notify(a.id, region, k, cid, kind);
    }
    return { changed: [...changes.keys()].sort(), notices };
  }

  /**
   * A–C: the calls and imports in the agent's current text are its own overlay edges ({by: agent}, replacing its previous ones from
   * this file), the functions it created are regions it leases, and a new call to a function another agent is re-signing tells both.
   */
  private async liveEdges(a: Row, A: FileRegions, now: number): Promise<number> {
    const defs = A.regions.filter((r) => r.kind === 'definition' || r.kind === 'container');
    const have = new Set((await this.g.query<{ id: string }>('MATCH (r:Region) WHERE r.id IN $ids RETURN r.id AS id', { ids: defs.map((r) => r.id) })).map((r) => r.id));
    const made = defs.filter((r) => !have.has(r.id));
    if (made.length) {
      await this.g.query(`UNWIND $rs AS r CREATE (:Region {id: r.id, path: $path, kind: r.kind, qname: r.qname, sig: r.sig, start: r.start, end: r.end,
        hash: r.hash, degraded: false, tombstoned: false, stub: false, live: $by})`,
      { rs: made.map(({ id, kind, qname, sig, start, end, hash }) => ({ id, kind, qname, sig, start, end, hash })), path: A.path, by: a.id });
      await acquire(this.g, a.id, made.map((r) => r.id), 'write', a.task ?? '', now);
    }

    // import targets come in as stubs (their definitions only); a name unique within this subset proves nothing, so no unique_name
    const stubs: FileRegions[] = [];
    if (/\.pyi?$/.test(A.path)) {
      const mods = new Set<string>();
      for (const b of A.imports ?? []) {
        const parts = [b.module, b.name].filter(Boolean).join('.').split('.');
        for (let i = 1; i <= parts.length; i++) mods.add(parts.slice(0, i).join('.'));
      }
      const paths = [...mods].flatMap((m) => [`${m.replaceAll('.', '/')}.py`, `${m.replaceAll('.', '/')}/__init__.py`]).filter((p) => p !== A.path);
      const rows = paths.length ? await this.g.query<{ path: string; id: string; kind: Region['kind']; qname: string }>(`MATCH (r:Region)
        WHERE r.path IN $paths AND r.kind IN ['definition', 'container'] AND NOT coalesce(r.tombstoned, false)
        RETURN r.path AS path, r.id AS id, r.kind AS kind, r.qname AS qname`, { paths }) : [];
      const by = new Map<string, Region[]>();
      for (const r of rows) (by.get(r.path) ?? by.set(r.path, []).get(r.path)!).push({ ...r, start: 0, end: 0, hash: '', masked: '', sig: null });
      for (const [path, regions] of by) stubs.push({ path, pack: 'stub', degraded: false, text: '', regions, warnings: [] });
    }
    const key = (e: { kind: string; from: string; to: string }) => `${e.kind}|${e.from}|${e.to}`;
    const want = buildEdges([A, ...stubs]).edges.filter((e) => e.kind !== 'CONTAINS' && e.via !== 'unique_name' && e.from.startsWith(`${A.path}::`));
    const cur = await this.g.query<{ kind: string; from: string; to: string; by: string | null }>(`MATCH (s:Region {path: $path})-[e:CALLS|IMPORTS|TESTS]->(t:Region)
      WHERE e.by IS NULL OR e.by = $by RETURN type(e) AS kind, s.id AS from, t.id AS to, e.by AS by`, { path: A.path, by: a.id });
    const base = new Set(cur.filter((e) => e.by === null).map(key));
    const old = new Set(cur.filter((e) => e.by !== null).map(key));
    const nu = want.filter((e) => !base.has(key(e)));
    await this.g.query(`MATCH (s:Region {path: $path})-[e:CALLS|IMPORTS|TESTS {by: $by}]->() DELETE e`, { path: A.path, by: a.id });
    for (const kind of ['CALLS', 'IMPORTS', 'TESTS'] as const) {
      const es = nu.filter((e) => e.kind === kind).map((e) => ({ a: e.from, b: e.to, via: e.via }));
      if (es.length) await this.g.query(`UNWIND $es AS e MATCH (a:Region {id: e.a}), (b:Region {id: e.b}) CREATE (a)-[:${kind} {via: e.via, by: $by}]->(b)`, { es, by: a.id });
    }

    // contract first: the callee is already being re-signed by someone else
    const fresh = nu.filter((e: Edge) => e.kind === 'CALLS' && !old.has(key(e)));
    if (!fresh.length) return 0;
    const busy = await this.g.query<{ holder: string; region: string }>(`MATCH (o:Agent)-[l:LEASED]->(r:Region) WHERE r.id IN $ts AND o.id <> $me
      AND l.expires > $now AND l.contract = true RETURN o.id AS holder, r.id AS region`, { ts: [...new Set(fresh.map((e) => e.to))], me: a.id, now });
    let n = 0;
    for (const b of busy) {
      await this.g.query(`MERGE (n:Notice {agent: $me, author: $holder, region: $region, kind: 'contract_use', status: 'pending'})
        ON CREATE SET n.id = $id, n.at = $now, n.score = 0.9`, { me: a.id, holder: b.holder, region: b.region, id: ulid(now), now });
      this.onCollision?.({ kind: 'caller_warning', region: [b.region], parties: [this.party(a.id), this.party(b.holder)], outcome: 'open',
        detail: `${a.id} wrote a call to ${b.region}, which ${b.holder} is re-signing` });
      n += 1 + await this.newCaller(b.holder, a.id, b.region, fresh.filter((e) => e.to === b.region).map((e) => e.from), now);
    }
    return n;
  }

  /** Tells the agent re-signing `region` which callers `author` has written against it; each caller is reported once. */
  private async newCaller(rec: string, author: string, region: string, callers: string[], now: number): Promise<number> {
    const told = new Set((await this.g.query<{ regions: string | null }>(`MATCH (n:Notice {agent: $rec, author: $author, region: $region, kind: 'new_caller'})
      RETURN n.regions AS regions`, { rec, author, region })).flatMap((r) => JSON.parse(r.regions ?? '[]') as string[]));
    const add = [...new Set(callers)].filter((c) => !told.has(c));
    if (!add.length) return 0;
    const [p] = await this.g.query<{ regions: string | null }>(`MERGE (n:Notice {agent: $rec, author: $author, region: $region, kind: 'new_caller', status: 'pending'})
      ON CREATE SET n.id = $id, n.at = $now, n.score = 0.9 RETURN n.regions AS regions`, { rec, author, region, id: ulid(now), now });
    const all = [...new Set([...(JSON.parse(p?.regions ?? '[]') as string[]), ...add])].sort();
    await this.g.query(`MATCH (n:Notice {agent: $rec, author: $author, region: $region, kind: 'new_caller', status: 'pending'}) SET n.regions = $rs`,
      { rec, author, region, rs: JSON.stringify(all) });
    return 1;
  }

  /** Dependents only: a change to R reaches the regions that call, import or test R (within 3 hops), plus R itself. */
  private async notify(author: string, region: string, k: Kind, cid: string, kind: 'change' | 'unleased_write'): Promise<number> {
    const now = this.now();
    const deps = await this.g.query<{ id: string; hops: number }>(
      `MATCH p = (t:Region)-[:CALLS|IMPORTS|TESTS*1..${HOPS}]->(:Region {id: $region}) WHERE t.id <> $region RETURN t.id AS id, min(length(p)) AS hops`, { region });
    const hops = new Map<string, number>([[region, 0], ...deps.map((d) => [d.id, d.hops] as [string, number])]);
    const ts = [...hops.keys()];
    const leased = await this.g.query<{ agent: string; region: string }>(`MATCH (o:Agent)-[l:LEASED]->(r:Region) WHERE r.id IN $ts AND o.id <> $author AND l.expires > $now
      RETURN o.id AS agent, r.id AS region`, { ts, author, now });
    const scoped = await this.g.query<{ agent: string; scope: string[] }>(`MATCH (o:Agent) WHERE o.id <> $author AND size(coalesce(o.scope, [])) > 0
      RETURN o.id AS agent, o.scope AS scope`, { author });
    const best = new Map<string, number>();
    const offer = (ag: string, rel: string, h: number) => best.set(ag, Math.max(best.get(ag) ?? 0, score(rel, h, SCORE_KIND[k])));
    for (const l of leased) offer(l.agent, 'LEASED', hops.get(l.region)!);
    for (const s of scoped) for (const r of s.scope) if (hops.has(r)) offer(s.agent, 'SCOPE', hops.get(r)!);
    let n = 0;
    if (k !== 'body') {
      // caller first: calls other agents wrote against the old signature are news to the one changing it
      const cs = await this.g.query<{ by: string; id: string }>(`MATCH (t:Region)-[e:CALLS]->(:Region {id: $region}) WHERE e.by IS NOT NULL AND e.by <> $author
        RETURN DISTINCT e.by AS by, t.id AS id`, { region, author });
      for (const by of new Set(cs.map((c) => c.by))) n += await this.newCaller(author, by, region, cs.filter((c) => c.by === by).map((c) => c.id), now);
    }
    for (const [rec, s] of best) {
      if (s < THRESHOLD) continue;
      // one pending notice per (recipient, author, region): its text is rendered from the latest Change when it is read (RC3)
      await this.g.query(`MERGE (n:Notice {agent: $rec, author: $author, region: $region, kind: $kind, status: 'pending'})
        ON CREATE SET n.id = $id, n.at = $now, n.score = $s
        SET n.change = $cid, n.score = CASE WHEN n.score > $s THEN n.score ELSE $s END`,
      { rec, author, region, kind, id: ulid(now), now, s, cid });
      n++;
    }
    return n;
  }

  private async unseenU(agent: string): Promise<string[]> {
    const a = await this.agent(agent);
    if (!a) return [];
    const files = git(a.worktree, 'ls-files', '-m', '-o', '--exclude-standard', '-z').stdout.split('\0')
      .filter((f) => f && !f.startsWith('.loom/') && existsSync(join(a.worktree, f)));
    const seen = this.seen.get(agent) ?? new Map<string, string>();
    this.seen.set(agent, seen);
    const out: string[] = [];
    for (const f of [...new Set(files)].sort()) {
      const blob = git(a.worktree, 'hash-object', '--', f).stdout.trim();
      if (seen.get(f) === blob) continue;
      seen.set(f, blob);
      out.push(f);
      await this.observe(a, f, 'unleased_write');
    }
    return out;
  }

  private async takeU(agent: string): Promise<Array<{ id: string; kind: string; text: string }>> {
    const rows = await this.g.query<{ id: string; kind: string; author: string; region: string | null; why: string | null; regions: string | null }>(
      `MATCH (n:Notice {agent: $agent, status: 'pending'}) RETURN n.id AS id, n.kind AS kind, n.author AS author, n.region AS region,
        n.why AS why, n.regions AS regions ORDER BY n.score DESC, n.at LIMIT ${MAX_PER_DELIVERY}`, { agent });
    const out: Array<{ id: string; kind: string; text: string }> = [];
    for (const r of rows) out.push({ id: r.id, kind: r.kind, text: await this.render(r) });
    if (out.length) await this.g.query(`UNWIND $rs AS r MATCH (n:Notice {id: r.id}) SET n.status = 'delivered', n.deliveredAt = $now, n.text = r.text`,
      { rs: out.map((o) => ({ id: o.id, text: o.text })), now: this.now() });
    return out;
  }

  private async render(n: { kind: string; author: string; region: string | null; why: string | null; regions: string | null }): Promise<string> {
    if (n.kind === 'conflict') return R.renderConflict(JSON.parse(n.regions ?? '[]'));
    if (n.kind === 'new_caller') {
      const callers = JSON.parse(n.regions ?? '[]') as string[];
      const cm = await this.regions([n.region!, ...callers]);
      return R.renderNewCaller(n.author, this.qn(cm, n.region!), callers.map((c) => this.qn(cm, c)));
    }
    const meta = await this.regions([n.region!]);
    const m = meta.get(n.region!);
    const qname = this.qn(meta, n.region!);
    const [c] = await this.g.query<{ kind: string; after: string | null }>(`MATCH (c:Change {agent: $author, region: $region})
      RETURN c.kind AS kind, c.afterSig AS after ORDER BY c.at DESC, c.seq DESC LIMIT 1`, { author: n.author, region: n.region });
    if (n.kind === 'wake') {
      const { renderWake } = await import('../notice.js');
      return renderWake(n.author, qname, c?.after ?? m?.sig ?? qname, n.why === 'lapsed' ? 'lapsed' : 'landed');
    }
    if (n.kind === 'contract_use') return R.renderContractUse({ author: n.author, qname, path: m?.path ?? n.region!.split('::')[0], before: m?.sig ?? null, after: c?.after ?? null });
    const [h] = await this.g.query<{ id: string }>(`MATCH (o:Agent)-[l:LEASED]->(:Region {id: $region}) WHERE l.expires > $now RETURN o.id AS id LIMIT 1`,
      { region: n.region, now: this.now() });
    return R.renderChange({ author: n.author, qname, path: m?.path ?? n.region!.split('::')[0], kind: c?.kind ?? 'body',
      before: m?.sig ?? null, after: c?.after ?? null, holder: h?.id ?? null }, n.kind === 'unleased_write');
  }

  private async ackU(agent: string, id: string): Promise<void> {
    const [n] = await this.g.query<{ kind: string; region: string | null; version: string | null }>(
      `MATCH (n:Notice {id: $id, agent: $agent}) SET n.status = 'acknowledged', n.ackedAt = $now RETURN n.kind AS kind, n.region AS region, n.version AS version`,
      { id, agent, now: this.now() });
    if (n?.kind === 'stale' && n.region && n.version) await ackStale(this.g, agent, n.region, n.version);
  }

  /** Wake every agent waiting on these regions except the one that held them; their back-off gate opens. */
  private async wake(holder: string, regions: string[], why: 'landed' | 'lapsed'): Promise<string[]> {
    if (!regions.length) return [];
    const now = this.now();
    const ws = await this.g.query<{ b: string; region: string; at: number | null }>(`MATCH (b:Agent)-[w:WAITS_ON]->(r:Region) WHERE r.id IN $regions AND b.id <> $holder
      WITH b, r, w, w.at AS at DELETE w RETURN b.id AS b, r.id AS region, at`, { regions, holder });
    for (const w of ws) {
      await this.g.query(`CREATE (:Notice {id: $id, agent: $b, author: $holder, region: $region, kind: 'wake', why: $why, score: 1.0, status: 'pending', at: $now})`,
        { id: ulid(now), b: w.b, holder, region: w.region, why, now });
      this.blocked.delete(`${w.b}|${w.region}`); this.denials.delete(`${w.b}|${w.region}`);
      this.onCollision?.({ kind: 'lock_wait', region: [w.region], parties: [this.party(w.b), this.party(holder)], outcome: 'waited',
        waited_ms: w.at == null ? 0 : Math.max(0, now - w.at), version: `${holder}@${now}`, detail: `${w.b} waited for ${holder} (${why})` });
    }
    return [...new Set(ws.map((w) => w.b))];
  }

  private async landU(agent: string, regions: string[], v?: { sha: string; task: string | null }): Promise<string[]> {
    await this.agent(agent);
    // R6.4: a landing is a Version of each region, by this agent, for its task; the stale check reads these
    if (v) for (const region of regions) {
      await this.g.query(`MERGE (r:Region {id: $region}) WITH r OPTIONAL MATCH (p:Version)-[:OF]->(r)
        WITH r, p ORDER BY p.at DESC LIMIT 1
        CREATE (n:Version {id: $id, region: $region, commits: [$sha], at: $now, external: false})-[:OF]->(r)
        MERGE (a:Agent {id: $agent}) CREATE (n)-[:BY]->(a)
        FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | CREATE (n)-[:PREV]->(p))
        FOREACH (t IN CASE WHEN $task IS NULL THEN [] ELSE [$task] END | MERGE (k:Task {id: t}) CREATE (n)-[:FOR]->(k))`,
      { region, id: `run:${v.sha}:${region}`, sha: v.sha, now: this.now(), agent, task: v.task });
    }
    await release(this.g, agent, regions);
    const woken = await this.wake(agent, regions, 'landed');
    const held = await this.g.query<{ id: string }>(`MATCH (o:Agent)-[l:LEASED]->(r:Region) WHERE r.id IN $regions AND o.id <> $agent AND l.expires > $now
      RETURN DISTINCT o.id AS id`, { regions, agent, now: this.now() });
    const scoped = await this.g.query<{ id: string; scope: string[] }>(`MATCH (o:Agent) WHERE o.id <> $agent AND size(coalesce(o.scope, [])) > 0
      RETURN o.id AS id, o.scope AS scope`, { agent });
    const ids = [...new Set([...woken, ...held.map((h) => h.id), ...scoped.filter((s) => s.scope.some((r) => regions.includes(r))).map((s) => s.id)])].sort();
    if (ids.length) await this.g.query('UNWIND $ids AS id MATCH (a:Agent {id: id}) SET a.syncPending = true', { ids });
    return ids;
  }

  private async sweepU(): Promise<void> {
    const rows = await expired(this.g, this.now());
    const by = new Map<string, string[]>();
    for (const r of rows) by.set(r.agent, [...(by.get(r.agent) ?? []), r.symbol]);
    for (const [agent, regions] of by) await this.wake(agent, regions, 'lapsed');
  }

  private async releaseU(agent: string): Promise<void> {
    const ids = await release(this.g, agent);
    await this.g.query('MATCH (:Agent {id: $agent})-[w:WAITS_ON]->() DELETE w', { agent });
    await this.wake(agent, ids, 'lapsed');
  }

  private async syncU(a: Row): Promise<Handover | null> {
    if (!a.syncPending || !a.upstream) return null;
    const h = await handover(a.worktree, a.upstream);
    await this.g.query('MATCH (a:Agent {id: $id}) SET a.syncPending = false', { id: a.id });
    if (h.status === 'conflict') {
      await this.g.query(`CREATE (:Notice {id: $nid, agent: $id, author: 'loom', kind: 'conflict', regions: $regions, score: 1.0, status: 'pending', at: $now})`,
        { nid: ulid(this.now()), id: a.id, regions: JSON.stringify(h.regions), now: this.now() });
    }
    // landed text is not the agent's own edit: its next postEdit diffs against the merged file
    for (const k of this.views.keys()) if (k.startsWith(`${a.id}|`)) this.views.set(k, this.fileText(a.worktree, k.slice(a.id.length + 1)));
    return h;
  }
}
