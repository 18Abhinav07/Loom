// RC1/RC2: bring landed work into an agent's worktree without losing its uncommitted edits.
// git merges first; regionMerge only gets the files git could not merge.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { regionMerge } from '@loom/indexer';

export interface Handover { status: 'clean' | 'resolved' | 'conflict' | 'noop'; files: string[]; regions: string[]; stashKept: boolean }

const ID = ['-c', 'user.email=loom@local', '-c', 'user.name=loom'];
const run = (wt: string, ...a: string[]) => spawnSync('git', [...ID, ...a], { cwd: wt, encoding: 'utf8', maxBuffer: 1 << 28 });
const out = (wt: string, ...a: string[]) => run(wt, ...a).stdout;
const stashes = (wt: string) => out(wt, 'stash', 'list').split('\n').filter(Boolean).length;
const hasRef = (wt: string, ref: string) => run(wt, 'rev-parse', '-q', '--verify', ref).status === 0;

export async function handover(wt: string, ref: string): Promise<Handover> {
  if (run(wt, 'merge-base', '--is-ancestor', ref, 'HEAD').status === 0) return { status: 'noop', files: [], regions: [], stashKept: false };
  const before = stashes(wt);
  const m = run(wt, 'merge', '--autostash', '--no-edit', ref);
  if (m.status === 0) return { status: 'clean', files: [], regions: [], stashKept: stashes(wt) > before };

  const files = out(wt, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  if (!files.length) throw new Error(`git merge ${ref} failed: ${m.stderr.trim()}`);
  const regions: string[] = [];
  const left: string[] = [];
  for (const f of files) {
    const stage = (n: number) => { const r = run(wt, 'show', `:${n}:${f}`); return r.status === 0 ? r.stdout : null; };
    const [base, ours, theirs] = [stage(1), stage(2), stage(3)];
    const r = base !== null && ours !== null && theirs !== null ? await regionMerge(f, base, ours, theirs) : null;
    if (r?.status === 'merged') { writeFileSync(join(wt, f), r.text); run(wt, 'add', '--', f); continue; }
    left.push(f);
    regions.push(...(r?.status === 'conflict' ? r.regions.map((x) => x.id) : [`${f}::file`]));
  }
  if (left.length) return { status: 'conflict', files: left, regions: [...new Set(regions)].sort(), stashKept: hasRef(wt, 'MERGE_AUTOSTASH') };

  // Concluding the merge applies the autostash; if that conflicts git keeps it as a stash entry.
  const c = run(wt, 'commit', '--no-edit');
  if (c.status !== 0) throw new Error(`git commit after regionMerge failed: ${c.stderr.trim()}`);
  return { status: 'resolved', files, regions: [], stashKept: stashes(wt) > before };
}
