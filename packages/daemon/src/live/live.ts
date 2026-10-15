// §6 live coordination on regions: leases before an edit, notices after it, wakes when the holder lands or lapses.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { diffRegions, regionize } from '@loom/indexer';
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
  private readonly seen = new Map<string, Map<string, string>>(); // agent → file → blob it last saw
  private seq = 0;

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
    const B = await regionize(file, before);
    const A = await regionize(file, after ?? '', { lastClean: B.degraded ? undefined : B });
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
    let notices = 0;
    for (const [region, k] of changes) {
      const cid = ulid(now);
      await this.g.query(`CREATE (:Change {id: $cid, agent: $agent, region: $region, kind: $k, beforeSig: $b, afterSig: $after, at: $now, seq: $seq})`,
        { cid, agent: a.id, region, k, b: sigB.get(region) ?? null, after: sigA.get(region) ?? null, now, seq: this.seq++ });
      notices += await this.notify(a.id, region, k, cid, kind);
    }
    return { changed: [...changes.keys()].sort(), notices };
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
    const meta = await this.regions([n.region!]);
    const m = meta.get(n.region!);
    const qname = this.qn(meta, n.region!);
    const [c] = await this.g.query<{ kind: string; after: string | null }>(`MATCH (c:Change {agent: $author, region: $region})
      RETURN c.kind AS kind, c.afterSig AS after ORDER BY c.at DESC, c.seq DESC LIMIT 1`, { author: n.author, region: n.region });
    if (n.kind === 'wake') {
      const { renderWake } = await import('../notice.js');
      return renderWake(n.author, qname, c?.after ?? m?.sig ?? qname, n.why === 'lapsed' ? 'lapsed' : 'landed');
    }
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
    const ws = await this.g.query<{ b: string; region: string }>(`MATCH (b:Agent)-[w:WAITS_ON]->(r:Region) WHERE r.id IN $regions AND b.id <> $holder
      DELETE w RETURN b.id AS b, r.id AS region`, { regions, holder });
    for (const w of ws) {
      await this.g.query(`CREATE (:Notice {id: $id, agent: $b, author: $holder, region: $region, kind: 'wake', why: $why, score: 1.0, status: 'pending', at: $now})`,
        { id: ulid(now), b: w.b, holder, region: w.region, why, now });
      this.blocked.delete(`${w.b}|${w.region}`); this.denials.delete(`${w.b}|${w.region}`);
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
