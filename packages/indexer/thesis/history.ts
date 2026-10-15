import { join } from 'node:path';
import { diffRegions, gitMergeFile, regionMerge, regionize, type FileRegions } from '../src/regions/index.js';
import { applyHunks, changedIn, git, hunks, rebaseUnder, ROOT, show, writeResult } from './lib.js';

const REPO = join(ROOT, 'bench/cache/django.git');
const WINDOW = 3000, DAYS = 7;

// first-parent commits, newest first, with the .py files each changed
const log = git(REPO, 'log', '--first-parent', `-n${WINDOW}`, '--format=@%H %P %at', '--name-only', '--diff-filter=M', '--', '*.py');
const revs = new Map<string, Array<{ c: string; p: string; at: number }>>();
let cur: { c: string; p: string; at: number } | null = null;
for (const line of log.split('\n')) {
  if (line.startsWith('@')) { const [c, p, ...rest] = line.slice(1).split(' '); cur = { c, p, at: Number(rest.at(-1)) }; continue; }
  if (line && cur) (revs.get(line) ?? revs.set(line, []).get(line)!).push(cur);
}

const maps = new Map<string, FileRegions | null>();
async function map(rev: string, path: string): Promise<FileRegions | null> {
  const k = `${rev}:${path}`; if (maps.has(k)) return maps.get(k)!;
  const t = show(REPO, rev, path); const m = t === null ? null : await regionize(path, t);
  const v = m && !m.degraded ? m : null; maps.set(k, v); return v;
}

const t1 = { pairs: 0, disjoint: 0, sameRegion: 0, skipped: 0 };
const t2 = { overlap: 0, built: 0, mismatch: 0, touch: 0, gitConflict: 0, rmResolved: 0, rmConflict: 0, rmUnsupported: 0, wrong: 0, gitWrong: 0, examples: [] as string[] };
const t3 = { transitions: 0, defs: 0, defChurn: 0, gaps: 0, gapChurn: 0, churnExamples: [] as string[], renames: [] as string[] };

for (const [path, list] of revs) {
  const chron = [...list].reverse();                     // oldest first
  for (let i = 0; i < chron.length; i++) {
    const c1 = chron[i];
    const base = await map(c1.p, path), ours = await map(c1.c, path);
    if (!base || !ours) { t1.skipped++; continue; }
    // T3: every base→C1 transition
    t3.transitions++;
    const d1 = diffRegions(base.regions, ours.regions);
    const seen = new Map(ours.regions.map((r) => [r.hash + '|' + r.kind, r.id]));
    const dupe = new Set<string>(); const cnt = new Map<string, number>();
    for (const r of [...base.regions, ...ours.regions]) { const k = r.hash + '|' + r.kind; cnt.set(k, (cnt.get(k) ?? 0) + 1); }
    for (const [k, n] of cnt) if (n !== 2) dupe.add(k);
    for (const r of base.regions) {
      const k = r.hash + '|' + r.kind; if (dupe.has(k) || !seen.has(k)) continue;
      const def = r.kind === 'definition' || r.kind === 'container';
      if (def) t3.defs++; else if (r.kind === 'gap') t3.gaps++; else continue;
      if (seen.get(k) !== r.id) {
        if (def) { t3.defChurn++; if (t3.churnExamples.length < 20) t3.churnExamples.push(`${c1.c.slice(0, 10)} ${r.id} → ${seen.get(k)}`); }
        else t3.gapChurn++;
      }
    }
    for (const rn of d1.renamed) if (t3.renames.length < 20) t3.renames.push(`${c1.c.slice(0, 10)} ${rn.from} → ${rn.to}`);

    // T1/T2b: consecutive revision within DAYS
    const c2 = chron[i + 1];
    if (!c2 || c2.at - c1.at > DAYS * 86400 || c2.p !== c1.c && show(REPO, c2.p, path) !== ours.text) continue;
    const next = await map(c2.c, path);
    if (!next) { t1.skipped++; continue; }
    t1.pairs++;
    const a = changedIn(d1, 'new'), b = changedIn(diffRegions(ours.regions, next.regions), 'old');
    if ([...a].some((x) => b.has(x))) t1.sameRegion++; else t1.disjoint++;

    const r = rebaseUnder(hunks(base.text, ours.text), hunks(ours.text, next.text));
    if (r.kind === 'overlap') { t2.overlap++; continue; }
    const theirs = applyHunks(base.text, r.theirs);
    const g = gitMergeFile(base.text, ours.text, theirs);
    t2.built++; if (r.touch) t2.touch++;
    if (g.clean && g.text !== next.text) t2.gitWrong++;
    if (!g.clean) t2.gitConflict++;
    const m = await regionMerge(path, base.text, ours.text, theirs);
    if (m.status === 'merged' && m.text !== next.text) { t2.wrong++; if (t2.examples.length < 10) t2.examples.push(`${path} ${c1.c.slice(0, 10)}..${c2.c.slice(0, 10)}`); }
    if (!g.clean) {
      if (m.status === 'merged' && m.text === next.text) t2.rmResolved++;
      else if (m.status === 'conflict') t2.rmConflict++;
      else if (m.status === 'unsupported') t2.rmUnsupported++;
    }
  }
}

const pct = (x: number, n: number) => (n ? ((100 * x) / n).toFixed(1) : '—') + '%';
const v1 = t1.disjoint / t1.pairs > 0.5;
const v2 = t2.wrong === 0;
const churn = t3.defChurn / t3.defs;
const v3 = churn <= 0.005;
writeResult('t1', [
  `T1 sample: consecutive first-parent revisions of a .py file, last ${WINDOW} commits, ≤${DAYS} days apart, clean maps`,
  `bar: > 50% region-disjoint`,
  `pairs=${t1.pairs} disjoint=${t1.disjoint} (${pct(t1.disjoint, t1.pairs)}) same-region=${t1.sameRegion} skipped(missing/degraded)=${t1.skipped}`,
  `T1: ${v1 ? 'PASS' : 'FAIL'} (${pct(t1.disjoint, t1.pairs)} of ${t1.pairs})`, ''].join('\n'), t1);
writeResult('t2b', [
  `T2b sample: T1 pairs; theirs = C2's hunks rebased under C1; truth = file at C2`,
  `bar: 0 wrong merges (regionMerge merged ≠ truth)`,
  `line-overlap (not constructible)=${t2.overlap} built=${t2.built} touching=${t2.touch}`,
  `git: conflicts=${t2.gitConflict} clean-but-wrong=${t2.gitWrong}`,
  `regionMerge on git conflicts: resolved-correctly=${t2.rmResolved} (${pct(t2.rmResolved, t2.gitConflict)}) still-conflict=${t2.rmConflict} unsupported=${t2.rmUnsupported}`,
  `regionMerge wrong merges=${t2.wrong} ${t2.examples.join(' ; ')}`,
  `T2b: ${v2 ? 'PASS' : 'FAIL'} (wrong=${t2.wrong}, resolved ${t2.rmResolved}/${t2.gitConflict} git conflicts)`, ''].join('\n'), t2);
writeResult('t3', [
  `T3 sample: every base→C1 transition of a .py file in the last ${WINDOW} first-parent commits (unique-text regions only)`,
  `bar: ≤ 0.5% id churn on unchanged definition/container regions`,
  `transitions=${t3.transitions} defs=${t3.defs} churn=${t3.defChurn} (${(100 * churn).toFixed(3)}%) gaps=${t3.gaps} gap-churn=${t3.gapChurn} (${pct(t3.gapChurn, t3.gaps)})`,
  `churn examples:`, ...t3.churnExamples.map((x) => '  ' + x),
  `renames (first 20, inspect by hand):`, ...t3.renames.map((x) => '  ' + x),
  `T3: ${v3 ? 'PASS' : 'FAIL'} (${(100 * churn).toFixed(3)}% of ${t3.defs})`, ''].join('\n'), t3);
console.log([v1, v2, v3].map((v, i) => `T${['1', '2b', '3'][i]} ${v ? 'PASS' : 'FAIL'}`).join(' · '));
