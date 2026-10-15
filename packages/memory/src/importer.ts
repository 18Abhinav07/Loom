import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { gitBlobSha } from '@loom/indexer';
import { fileSession, parseEvents, type LoomEvent } from './events.js';
import { blame, git, gitTry } from './git.js';

const DIR = '.loom/sessions';
function list(root: string, ref: string | null): string[] {
  if (!ref) return existsSync(join(root, DIR)) ? readdirSync(join(root, DIR)).filter((f) => f.endsWith('.jsonl')).map((f) => `${DIR}/${f}`) : [];
  return (gitTry(root, 'ls-tree', '--name-only', ref, `${DIR}/`) ?? '').split('\n').filter((f) => f.endsWith('.jsonl'));
}

/** §5.2: MERGE on event id; (:Imported {id: file@blob@lastCommit}) skips unchanged files — the commit part re-keys after a rewrite. */
export async function importSessions(g: LoomGraph, root: string, ref: string | null) {
  const out = { files: 0, skipped: 0, events: 0, warnings: [] as string[] };
  for (const f of list(root, ref)) {
    const fs = fileSession(f); if (!fs) continue;
    out.files++;
    const blob = ref ? git(root, 'rev-parse', `${ref}:${f}`) : gitBlobSha(readFileSync(join(root, f)));
    const last = gitTry(root, 'rev-list', '-1', ref ?? 'HEAD', '--', f) ?? '';
    const key = `${f}@${blob}@${last}`;
    if ((await g.query('MATCH (i:Imported {id: $key}) RETURN i.id', { key })).length) { out.skipped++; continue; }
    const tracked = ref !== null || gitTry(root, 'ls-files', '--error-unmatch', f) !== null;
    const rows = tracked ? blame(root, f, ref)
      : readFileSync(join(root, f), 'utf8').split('\n').map((text) => ({ commit: null as string | null, text }));
    const commitOf = new Map<string, string | null>();
    for (const r of rows) { const id = /"id":"([^"]+)"/.exec(r.text)?.[1]; if (id && !commitOf.has(id)) commitOf.set(id, r.commit); }
    const { events, warnings } = parseEvents(rows.map((r) => r.text));
    out.warnings.push(...warnings.map((w) => `${f}: ${w}`));
    for (const e of events) { await apply(g, root, fs.sid, fs.writer, e, commitOf.get(e.id) ?? null); out.events++; }
    await g.query('MERGE (i:Imported {id: $key}) SET i.file = $f, i.blob = $blob', { key, f, blob });
  }
  return out;
}

const commitMeta = new Map<string, { at: number; author: string; message: string }>();
function meta(root: string, sha: string) {
  if (!commitMeta.has(sha)) {
    const [at, author, ...msg] = git(root, 'show', '-s', '--format=%ct%n%ae%n%s', sha).split('\n');
    commitMeta.set(sha, { at: Number(at) * 1000, author, message: msg.join('\n') });
  }
  return commitMeta.get(sha)!;
}

const STUB = 'MERGE (r:Region {id: rid}) ON CREATE SET r.stub = true';
const Q: Record<string, string> = {
  session: `MERGE (s:Session {id: $sid}) SET s.person = $person, s.kind = $kind, s.base = $base, s.upstream = $upstream, s.started = $at
    MERGE (p:Person {id: $person}) MERGE (p)-[:STARTED]->(s)`,
  agent: `MERGE (s:Session {id: $sid}) MERGE (a:Agent {id: $sid + '/' + $name}) SET a.model = $model, a.name = $name MERGE (s)-[:RAN]->(a)`,
  task: `MERGE (t:Task {id: $id}) SET t.title = $title, t.status = $status, t.claimed_by = $ag, t.at = $at
    FOREACH (rid IN coalesce($scope, []) | ${STUB} MERGE (t)-[:SCOPE]->(r))`,
  version: `MERGE (v:Version {id: $id}) SET v.region = $region, v.hash = $hash, v.sig = $sig, v.deleted = $deleted,
      v.degraded = $degraded, v.at = $at, v.external = false, v.commits = coalesce(v.commits, []), v.renamed_from = $renamed_from
    MERGE (r:Region {id: $region}) ON CREATE SET r.stub = true MERGE (v)-[:OF]->(r)
    MERGE (a:Agent {id: $ag}) MERGE (v)-[:BY]->(a) MERGE (s:Session {id: $sid}) MERGE (s)-[:RAN]->(a)
    FOREACH (pid IN coalesce($prev, []) | MERGE (pv:Version {id: pid}) MERGE (v)-[:PREV]->(pv))`,
  decision: `MERGE (d:Decision {id: $id}) SET d.text = $text, d.at = $at MERGE (a:Agent {id: $ag}) MERGE (d)-[:BY]->(a) MERGE (s:Session {id: $sid}) MERGE (s)-[:RAN]->(a)
    FOREACH (rid IN coalesce($regions, []) | ${STUB} MERGE (d)-[:ABOUT]->(r))
    FOREACH (vid IN coalesce($led_to, []) | MERGE (v:Version {id: vid}) MERGE (d)-[:LED_TO]->(v))`,
  evidence: `MERGE (x:Evidence {id: $id}) SET x.test = $test, x.result = $result, x.at = $at
    FOREACH (vid IN coalesce($versions, []) | MERGE (v:Version {id: vid}) MERGE (x)-[:VERIFIES]->(v))`,
  lesson: `MERGE (l:Lesson {id: $id}) SET l.text = $text, l.source = $source, l.at = $at
    FOREACH (rid IN coalesce($regions, []) | ${STUB} MERGE (l)-[:ON]->(r))`,
  message: `MERGE (m:Message {id: $id}) SET m.kind = $kind, m.text = $text, m.at = $at
    MERGE (f:Agent {id: $ag}) MERGE (m)-[:FROM]->(f)
    FOREACH (_ IN CASE WHEN $thread IS NULL THEN [] ELSE [1] END | MERGE (t:Thread {id: $thread}) MERGE (m)-[:IN_THREAD]->(t))`,
  handoff: `MERGE (h:Handoff {id: $id}) SET h.summary = $summary, h.open_leases = $open_leases, h.at = $at
    MERGE (s:Session {id: $sid}) MERGE (h)-[:FROM]->(s)
    FOREACH (tid IN coalesce($open_tasks, []) | MERGE (t:Task {id: tid}) MERGE (h)-[:LEAVES]->(t))`,
};
const DEFAULTS = { person: null, kind: null, base: null, upstream: null, name: null, model: null, title: null, status: null, scope: null,
  region: null, hash: null, sig: null, deleted: false, degraded: false, prev: null, renamed_from: null, text: null, regions: null,
  led_to: null, test: null, result: null, versions: null, source: null, thread: null, summary: null, open_leases: null, open_tasks: null };

async function apply(g: LoomGraph, root: string, sid: string, writer: string, e: LoomEvent, commit: string | null) {
  await g.query(Q[e.type], { ...DEFAULTS, ...e, sid, writer, ag: `${sid}/${e.by ?? e.from ?? writer}` });
  if (e.type === 'version' && commit) {
    const m = meta(root, commit);
    await g.query(`MATCH (v:Version {id: $id}) MERGE (c:Commit {sha: $sha})
      SET c.at = $cat, c.author = $author, c.message = $message MERGE (v)-[:IN]->(c)
      SET v.commits = CASE WHEN $sha IN v.commits THEN v.commits ELSE v.commits + $sha END`,
      { id: e.id, sha: commit, cat: m.at, author: m.author, message: m.message });
  }
  if (e.type === 'version' && e.task) await g.query('MATCH (v:Version {id: $id}) MERGE (t:Task {id: $task}) MERGE (v)-[:FOR]->(t)', { id: e.id, task: e.task });
}
