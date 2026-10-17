import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { parse } from 'yaml';

/** §3.3: one agent per task. `owns` is soft (locks stay the hard rule); the checker uses it for overlap and ordering. */
export interface TeamTask { id: string; title: string; owns: string[]; reads: string[]; after: string[]; done: string; prompt: string }
export interface TeamPlan { goal: string; sources: string[]; test: string | null; compile: string | null; base: string; tasks: TeamTask[]; body: string }
export interface PlanRepo { files: (ref: string) => string[]; regions: number; regionPaths: string[] }

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === 'string' && v ? [v] : []);

/** The YAML front matter of `.loom/plans/<slug>.md`, then the free-form body. Never throws. */
export function parseTeamPlan(text: string): { plan: TeamPlan | null; problems: string[] } {
  const m = FM.exec(text);
  if (!m) return { plan: null, problems: ['front matter: missing (the file must start with ---)'] };
  let y: any;
  try { y = parse(m[1]); } catch (e) { return { plan: null, problems: [`front matter: ${String((e as Error).message).split('\n')[0]}`] }; }
  if (!y || typeof y !== 'object' || Array.isArray(y)) return { plan: null, problems: ['front matter: not a key/value block'] };
  if (!Array.isArray(y.tasks)) return { plan: null, problems: ['tasks must be a list'] };
  const tasks: TeamTask[] = y.tasks.map((t: any) => ({
    id: str(t?.id), title: str(t?.title), owns: list(t?.owns), reads: list(t?.reads), after: list(t?.after), done: str(t?.done), prompt: str(t?.prompt),
  }));
  return {
    plan: { goal: str(y.goal), sources: list(y.sources), test: str(y.test) || null, compile: str(y.compile) || null,
      base: str(y.base) || 'HEAD', tasks, body: text.slice(m[0].length) },
    problems: [],
  };
}

/** A path or glob as a concrete path a glob can be tested against. */
const probe = (g: string) => g.replace(/\*\*/g, 'zz').replace(/\*/g, 'zz').replace(/\?/g, 'z').replace(/\/+$/, '');
const match = (path: string, glob: string) => path === glob || path.startsWith(glob.replace(/\/+$/, '') + '/') || matchesGlob(path, glob);
/** Two owns/reads entries cover a common path: a file on base matches both, or one's probe falls inside the other. */
const overlap = (a: string, b: string, files: string[]) =>
  a === b || match(probe(a), b) || match(probe(b), a) || files.some((f) => match(f, a) && match(f, b));
const isCode = (f: string) => !f.split('/').some((s) => s.startsWith('.')) && !/\.(md|markdown|txt|rst|adoc)$/i.test(f) && !/^(LICEN[CS]E|COPYING)/i.test(f.split('/').pop()!);

/** §3.3: the problems refuse a team start; the warnings do not. */
export function checkTeamPlan(p: TeamPlan, repo: PlanRepo): { ok: boolean; problems: string[]; warnings: string[] } {
  const problems: string[] = []; const warnings: string[] = [];
  const name = (t: TeamTask, i: number) => t.id || `#${i + 1}`;
  p.tasks.forEach((t, i) => {
    for (const f of ['id', 'title', 'owns', 'done', 'prompt'] as const) {
      const v = t[f];
      if (Array.isArray(v) ? !v.length : !v.trim()) problems.push(`task ${name(t, i)}: missing ${f}`);
    }
  });
  if (!p.test) problems.push('test is missing');

  const ids = new Map(p.tasks.filter((t) => t.id).map((t) => [t.id, t]));
  for (const t of p.tasks) for (const a of t.after) if (!ids.has(a)) problems.push(`task ${t.id}: after names unknown task ${a}`);
  // cycles: DFS over known ids, report each cycle once
  const state = new Map<string, 1 | 2>(); const seen = new Set<string>();
  const dfs = (id: string, path: string[]) => {
    state.set(id, 1);
    for (const a of ids.get(id)!.after) {
      if (!ids.has(a)) continue;
      if (state.get(a) === 1) {
        const cyc = [...path.slice(path.indexOf(a)), a];
        const key = [...new Set(cyc)].sort().join(',');
        if (!seen.has(key)) { seen.add(key); problems.push(`after: cycle ${cyc.join(' → ')}`); }
      } else if (!state.has(a)) dfs(a, [...path, a]);
    }
    state.set(id, 2);
  };
  for (const id of ids.keys()) if (!state.has(id)) dfs(id, [id]);
  // what must land before a task: its after ids, transitively
  const before = (id: string, acc = new Set<string>()): Set<string> => {
    for (const a of ids.get(id)?.after ?? []) if (ids.has(a) && !acc.has(a)) { acc.add(a); before(a, acc); }
    return acc;
  };

  let files: string[];
  try { files = repo.files(p.base); } catch { problems.push(`base ${p.base} is not a commit in this repo`); return { ok: false, problems, warnings }; }

  const T = p.tasks.filter((t) => t.id);
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
    const [a, b] = [T[i], T[j]];
    const g = a.owns.find((x) => b.owns.some((y) => overlap(x, y, files)));
    if (g && !before(a.id).has(b.id) && !before(b.id).has(a.id)) problems.push(`tasks ${a.id} and ${b.id} both own ${g} and neither is after the other`);
  }
  for (const t of T) {
    const earlier = [...before(t.id)].flatMap((id) => ids.get(id)!.owns);
    for (const r of t.reads) {
      if (files.some((f) => match(f, r))) continue;
      if (earlier.some((o) => overlap(r, o, []))) continue;
      problems.push(`task ${t.id} reads ${r}, which does not exist on ${p.base} and no earlier task owns it`);
    }
  }
  // the empty-repo rule: nothing to read yet, so a scaffold task (every other task comes after it) must come first
  if (T.length > 1 && !files.some(isCode)) {
    const scaffold = T.some((s) => T.every((t) => t === s || before(t.id).has(s.id)));
    if (!scaffold) problems.push(`empty repo: no code on ${p.base} under any reads path; add a scaffold task first`);
  }

  for (const t of T) {
    if (repo.regions > 0) {
      const n = repo.regionPaths.filter((f) => t.owns.some((o) => match(f, o))).length;
      const pct = Math.round((n / repo.regions) * 100);
      if (pct > 40) warnings.push(`task ${t.id} owns ${pct}% of indexed regions`);
    }
    if (!t.reads.length) warnings.push(`task ${t.id} has no reads`);
  }
  return { ok: problems.length === 0, problems, warnings };
}

/** `.loom/plans/*.md`: slug, goal, task count. An unparseable plan lists with an empty goal and 0 tasks. */
export function listPlans(root: string): { slug: string; goal: string; tasks: number }[] {
  const dir = join(root, '.loom', 'plans');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const { plan } = parseTeamPlan(readFileSync(join(dir, f), 'utf8'));
    return { slug: f.slice(0, -3), goal: plan?.goal ?? '', tasks: plan?.tasks.length ?? 0 };
  });
}
