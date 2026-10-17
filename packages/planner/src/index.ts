import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { LoomGraph } from '@loom/core';

export interface PlanTask { id: string; title: string; prompt: string; scope?: string[] }
export interface Plan { repo?: string; base?: string; test?: string; compile?: string; tasks: PlanTask[] }
export interface Partition { components: string[][]; hubs: string[]; hubOwner: Record<string, string> }

const ID = /^[a-z][\w-]*$/;

export function validatePlan(p: any): Plan {
  if (!p || !Array.isArray(p.tasks) || !p.tasks.length) throw new Error('plan: tasks must be a non-empty list');
  const seen = new Set<string>();
  for (const [i, t] of p.tasks.entries()) {
    if (typeof t?.id !== 'string' || !ID.test(t.id)) throw new Error(`plan: tasks[${i}].id must match ${ID}`);
    if (seen.has(t.id)) throw new Error(`plan: duplicate task id ${t.id}`);
    seen.add(t.id);
    if (typeof t.title !== 'string' || !t.title.trim()) throw new Error(`plan: tasks[${i}].title is empty`);
    if (typeof t.prompt !== 'string' || !t.prompt.trim()) throw new Error(`plan: tasks[${i}].prompt is empty`);
    if (t.scope !== undefined && !(Array.isArray(t.scope) && t.scope.every((s: unknown) => typeof s === 'string')))
      throw new Error(`plan: tasks[${i}].scope must be a list of symbol ids`);
  }
  return p as Plan;
}

export function loadPlan(path: string): Plan { return validatePlan(parse(readFileSync(path, 'utf8'))); }

/** Full-text terms from free text: Lucene/RediSearch metacharacters become spaces, short words drop. */
export function ftQuery(text: string): string {
  const terms = [...new Set(text.replace(/[+\-&|!(){}\[\]^"~*?:\\\/@<>=,.;'$%#]/g, ' ').toLowerCase().split(/\s+/).filter((w) => w.length >= 3))];
  return terms.join(' | ');
}

/** Words written as code: inside backticks, called `x(`, the last part of a dotted path, or snake_case. */
export function codeIdents(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) { const id = /^[\w.]*?(\w+)\s*(\(|$)/.exec(m[1].trim()); if (id) out.add(id[1]); }
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\(/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b[a-z_]\w*(?:\.\w+)+\b/g)) if (!/\.py$/.test(m[0])) out.add(m[0].split('.').pop()!);
  for (const m of text.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)) out.add(m[0]);
  return [...out].filter((w) => w.length >= 3 && !/^\d/.test(w));
}

/** Spec §5.7 step 3: a task's symbols — given ones verified, else the top-k full-text hits on name + docstring. */
export async function scope(g: LoomGraph, task: Pick<PlanTask, 'title' | 'prompt' | 'scope'> & { id?: string }, k = 8): Promise<string[]> {
  if (task.scope?.length) {
    const rows = await g.query<{ id: string }>(`UNWIND $ids AS i MATCH (s:Symbol {id: i}) RETURN s.id AS id`, { ids: task.scope });
    const have = new Set(rows.map((r) => r.id));
    const bad = task.scope.filter((s) => !have.has(s));
    if (bad.length) throw new Error(`plan: task ${task.id ?? ''} scope names unknown symbols: ${bad.join(', ')}`);
    return task.scope;
  }
  const q = ftQuery(`${task.title} ${task.prompt}`);
  if (!q) return [];
  const n = Math.max(1, Math.floor(k));
  // identifiers the task writes as code (`x`, x(…), a.b.x, snake_case) name its targets: those lead, symbols in a file the
  // task mentions first, so docstrings that merely repeat the prompt's common words cannot crowd them out
  const text = `${task.title} ${task.prompt}`;
  const named = await g.query<{ id: string }>(`MATCH (s:Symbol) WHERE s.name IN $idents
    WITH s.name AS w, collect(s) AS ss WHERE size(ss) <= 5
    UNWIND ss AS s RETURN s.id AS id ORDER BY CASE WHEN s.file IN $files THEN 0 ELSE 1 END, size(ss), id`,
  { idents: codeIdents(text), files: text.match(/[\w./-]+\.py\b/g) ?? [] });
  const ft = await g.query<{ id: string }>(`CALL db.idx.fulltext.queryNodes('Symbol', $q) YIELD node, score
    RETURN node.id AS id ORDER BY score DESC, id LIMIT ${n}`, { q });
  return [...new Set([...named, ...ft].map((r) => r.id))].slice(0, n);
}

/** Spec §5.7 step 4: tasks sharing a WCC component of the scoped CALLS subgraph run together; betweenness names the hubs. */
export async function partition(g: LoomGraph, scopes: Map<string, string[]>): Promise<Partition> {
  const ids = [...new Set([...scopes.values()].flat())];
  try {
    await g.query(`MATCH (s:Symbol) WHERE s.id IN $ids SET s:Scoped WITH s MATCH (s)-[:CALLS]-(n:Symbol) SET n:Scoped`, { ids });
    const comp = new Map((await g.query<{ id: string; c: number }>(
      `CALL algo.WCC({nodeLabels: ['Scoped'], relationshipTypes: ['CALLS']}) YIELD node, componentId RETURN node.id AS id, componentId AS c`))
      .map((r) => [r.id, r.c] as const));
    // union tasks whose symbols share a component; plan order is kept inside and across groups
    const order = [...scopes.keys()];
    const parent = new Map(order.map((t) => [t, t]));
    const find = (t: string): string => (parent.get(t) === t ? t : find(parent.get(t)!));
    const owner = new Map<number, string>();
    for (const t of order) for (const s of scopes.get(t)!) {
      const c = comp.get(s);
      if (c === undefined) continue;
      if (!owner.has(c)) owner.set(c, t);
      else {
        const a = find(owner.get(c)!), b = find(t);
        if (a !== b) { const [keep, drop] = order.indexOf(a) < order.indexOf(b) ? [a, b] : [b, a]; parent.set(drop, keep); }
      }
    }
    const groups = new Map<string, string[]>();
    for (const t of order) { const r = find(t); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(t); }

    // a symbol several tasks scope is contested by them: the most-shared ones are the hubs (§5.7.4 "the task that changes a
    // hub"); betweenness only decides when no symbol is shared
    const share = new Map<string, number>();
    for (const t of order) for (const s of new Set(scopes.get(t))) share.set(s, (share.get(s) ?? 0) + 1);
    const most = Math.max(0, ...share.values());
    const shared = most >= 2 ? [...share].filter(([, n]) => n === most).map(([s]) => s) : [];
    const bc = shared.length ? [] : await g.query<{ id: string; score: number }>(
      `CALL algo.betweenness({nodeLabels: ['Scoped'], relationshipTypes: ['CALLS']}) YIELD node, score RETURN node.id AS id, score`);
    let hubs: string[];
    const pos = bc.filter((r) => r.score > 0).map((r) => r.score).sort((a, b) => a - b);
    if (shared.length) hubs = shared;
    else if (pos.length) {
      const all = bc.map((r) => r.score).sort((a, b) => a - b);
      const p90 = all[Math.min(all.length - 1, Math.floor(all.length * 0.9))];
      hubs = bc.filter((r) => r.score > 0 && r.score >= p90).map((r) => r.id);
      if (!hubs.length) hubs = bc.filter((r) => r.score === pos[pos.length - 1]).map((r) => r.id);
    } else {   // a star (all callers → one callee) has zero betweenness in a directed graph: take the most-called symbol
      const [top] = await g.query<{ id: string; n: number }>(`MATCH (s:Scoped) OPTIONAL MATCH (:Scoped)-[c:CALLS]->(s)
        WITH s, count(c) AS n WHERE n > 0 RETURN s.id AS id, n ORDER BY n DESC, id LIMIT 1`);
      hubs = top ? [top.id] : [];
    }
    const hubOwner: Record<string, string> = {};
    for (const h of hubs) { const t = order.find((x) => scopes.get(x)!.includes(h)); if (t) hubOwner[h] = t; }
    return { components: [...groups.values()], hubs, hubOwner };
  } finally {
    await g.query(`MATCH (n:Scoped) REMOVE n:Scoped`);
  }
}

export * from './teamplan.js';
