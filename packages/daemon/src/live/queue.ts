// R6.1: a run's agents land one at a time onto the run's landed branch. The daemon owns the queue because landing needs the graph
// (covering tests, Versions, wakes); the CLI only asks over HTTP.
import { spawnSync } from 'node:child_process';
import type { LoomGraph } from '@loom/core';
import { diffRegions, regionize } from '@loom/indexer';
import { contractBreaks, renderBreaks } from './contract.js';
import { handover } from './handover.js';

export interface LandResult { status: 'landed' | 'empty' | 'conflict' | 'tests_failed' | 'contract_break'; sha: string | null; regions: string[]; tail: string; missing?: boolean }
export interface LandJob { repo: string; wt: string; landed: string; agent: string; title: string; testCmd: string | null; g: LoomGraph }

const ID = ['-c', 'user.email=loom@local', '-c', 'user.name=loom'];
const git = (cwd: string, ...a: string[]) => spawnSync('git', [...ID, ...a], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const show = (cwd: string, ref: string, f: string) => { const r = git(cwd, 'show', `${ref}:${f}`); return r.status === 0 ? r.stdout : null; };
/** Never landed: the run's own bookkeeping and the agent's local settings. */
export const KEEP_OUT = [':!.loom', ':!.claude', ':!.mcp.json', ':!.loom-mcp.json', ':!CLAUDE.md'];
const tail = (s: string) => s.split('\n').slice(-40).join('\n');

/** Regions whose text differs between `from` and `to` (updated, created, removed, renamed-from), per changed file. */
export async function changedRegions(wt: string, from: string, to: string): Promise<string[]> {
  const files = git(wt, 'diff', '--name-only', `${from}...${to}`).stdout.split('\n').filter(Boolean);
  const out = new Set<string>();
  for (const f of files) {
    const [a, b] = [show(wt, from, f), show(wt, to, f)];
    const A = a === null ? [] : (await regionize(f, a)).regions;
    const B = b === null ? [] : (await regionize(f, b)).regions;
    const d = diffRegions(A, B);
    for (const id of [...d.updated, ...d.created, ...d.tombstoned, ...d.renamed.flatMap((r) => [r.from, r.to])]) out.add(id);
  }
  return [...out].sort();
}

/** The tests that cover these regions (TESTS edges). A pytest-like command gets their files appended; any other runs whole. */
export async function coveringTests(g: LoomGraph, regions: string[], testCmd: string | null): Promise<string | null> {
  if (!testCmd) return null;
  if (!/\bpytest\b/.test(testCmd)) return testCmd;
  const rows = await g.query<{ path: string }>(`MATCH (t:Region)-[:TESTS]->(r:Region) WHERE r.id IN $regions RETURN DISTINCT t.path AS path`, { regions });
  const files = [...new Set(rows.map((r) => r.path))].sort();
  return files.length ? `${testCmd} ${files.join(' ')}` : testCmd;
}

/** Commit the agent's work, merge landed into it, run the covering tests, then move landed to it only if landed did not move meanwhile. */
export async function landOne(j: LandJob): Promise<LandResult> {
  if (git(j.wt, 'status', '--porcelain', '--', '.', ...KEEP_OUT).stdout.trim()) {
    git(j.wt, 'add', '-A', '--', '.', ...KEEP_OUT);
    const c = git(j.wt, 'commit', '-qm', `${j.agent}: ${j.title}`);
    if (c.status !== 0) return { status: 'conflict', sha: null, regions: [], tail: tail(c.stderr + c.stdout) };
  }
  const old = git(j.repo, 'rev-parse', `refs/heads/${j.landed}`).stdout.trim();
  if (git(j.wt, 'merge-base', '--is-ancestor', 'HEAD', old).status === 0) return { status: 'empty', sha: old, regions: [], tail: '' };
  const h = await handover(j.wt, old);
  if (h.status === 'conflict') {
    git(j.wt, 'merge', '--abort');
    return { status: 'conflict', sha: null, regions: h.regions, tail: `conflict in ${h.files.join(', ')}` };
  }
  const regions = await changedRegions(j.wt, old, 'HEAD');
  // a call another agent's work no longer fits never lands, whichever side moved (live coordination D)
  const breaks = await contractBreaks(j.wt, old, 'HEAD');
  // missing: every break is a callee that is not in the landed code at all, which only someone else's landing can supply
  if (breaks.length) return { status: 'contract_break', sha: null, regions, tail: renderBreaks(breaks), missing: breaks.every((b) => b.missing) };
  const cmd = await coveringTests(j.g, regions, j.testCmd);
  if (cmd) {
    const t = spawnSync('sh', ['-c', cmd], { cwd: j.wt, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900_000 });
    if (t.status !== 0) return { status: 'tests_failed', sha: null, regions, tail: tail(`${t.stdout}\n${t.stderr}`) };
  }
  const sha = git(j.wt, 'rev-parse', 'HEAD').stdout.trim();
  const u = git(j.repo, 'update-ref', `refs/heads/${j.landed}`, sha, old);
  if (u.status !== 0) return { status: 'conflict', sha: null, regions, tail: tail(u.stderr) };
  return { status: 'landed', sha, regions, tail: '' };
}

/** One landing at a time per run. */
export class MergeQueue {
  private q: Promise<unknown> = Promise.resolve();
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.q.then(fn, fn);
    this.q = p.catch(() => undefined);
    return p;
  }
}
