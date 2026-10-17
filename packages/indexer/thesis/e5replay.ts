import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { regionMerge } from '../src/regions/index.js';
import { writeResult } from './lib.js';

const RUNS = join(homedir(), 'Documents/loom-v2/bench/results/e5/team-1/repos');
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryG = (cwd: string, ...a: string[]) => { try { return { ok: true, out: g(cwd, ...a) }; } catch (e: any) { return { ok: false, out: String(e.stdout ?? '') }; } };

const out: string[] = []; const rows: any[] = [];
let resolved = 0, sameRegion = 0, other = 0;
for (const scen of readdirSync(RUNS).sort()) {
  const repo = join(RUNS, scen);
  const agents = g(repo, 'for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads/loom/')
    .trim().split('\n').map((l) => l.split(' ')).filter(([r]) => /\/[a-d]$/.test(r)).sort((x, y) => Number(x[1]) - Number(y[1])).map(([r]) => r);
  const base = g(repo, 'merge-base', '--octopus', ...agents).trim();
  const wt = mkdtempSync(join(tmpdir(), 't5-'));
  g(repo, 'worktree', 'add', '-q', '--detach', wt, base);
  const row: any = { scen, order: agents, steps: [] };
  for (const a of agents) {
    const m = tryG(wt, '-c', 'user.name=t5', '-c', 'user.email=t5@x', 'merge', '--no-edit', '-q', a);
    if (m.ok) { row.steps.push({ a, git: 'clean' }); continue; }
    const files = g(wt, 'diff', '--name-only', '--diff-filter=U').trim().split('\n').filter(Boolean);
    const step: any = { a, git: 'conflict', files: [] };
    let allResolved = true;
    for (const f of files) {
      const s = (n: number) => g(wt, 'show', `:${n}:${f}`);
      const r = await regionMerge(f, s(1), s(2), s(3));
      if (r.status === 'merged') { writeFileSync(join(wt, f), r.text); g(wt, 'add', f); step.files.push({ f, class: 'resolved' }); resolved++; }
      else if (r.status === 'conflict') { allResolved = false; step.files.push({ f, class: 'same-region', regions: r.regions.map((x) => x.id) }); sameRegion++; }
      else { allResolved = false; step.files.push({ f, class: 'other', reason: r.reason }); other++; }
    }
    if (allResolved) g(wt, '-c', 'user.name=t5', '-c', 'user.email=t5@x', 'commit', '-q', '--no-edit');
    else g(wt, 'merge', '--abort');                        // v2: not landed; the agent is resumed with the brief
    row.steps.push(step);
  }
  g(repo, 'worktree', 'remove', '--force', wt); rmSync(wt, { recursive: true, force: true });
  rows.push(row);
  out.push(`${scen}: order ${agents.map((a) => a.split('/').pop()).join('→')}`);
  for (const s of row.steps) out.push(`  ${s.a.split('/').pop()}: ${s.git}${s.files ? ' ' + s.files.map((f: any) => `${f.f}=${f.class}${f.regions ? '[' + f.regions.join(',') + ']' : ''}${f.reason ? '(' + f.reason + ')' : ''}`).join(' ') : ''}`);
}
const ok = other === 0;
writeResult('t5', [
  `T5 sample: 6 E5 team-1 repos; agent branches merged in commit-time order; regionMerge on each git-conflicted file`,
  `bar: 0 conflicted files outside {resolved by regionMerge, same-region (lease-serialized)}`,
  ...out,
  `conflicted files: resolved=${resolved} same-region=${sameRegion} other=${other}`,
  `T5: ${ok ? 'PASS' : 'FAIL'} (${resolved} resolved, ${sameRegion} same-region, ${other} other)`, ''].join('\n'), rows);
console.log(`T5 ${ok ? 'PASS' : 'FAIL'}`);
