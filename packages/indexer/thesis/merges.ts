import { join } from 'node:path';
import { gitMergeFile, regionMerge } from '../src/regions/index.js';
import { git, ROOT, show, writeResult } from './lib.js';

const REPO = join(ROOT, 'bench/cache/django.git');
const r = { merges: 0, files: 0, gitClean: 0, same: 0, differ: [] as string[], rmConflict: 0, unsupported: 0, matchesM: 0 };
for (const m of git(REPO, 'rev-list', '--merges', 'HEAD').trim().split('\n')) {
  const [p1, p2] = git(REPO, 'rev-parse', `${m}^1`, `${m}^2`).trim().split('\n');
  let b: string; try { b = git(REPO, 'merge-base', p1, p2).trim(); } catch { continue; }
  r.merges++;
  const side = (p: string) => new Set(git(REPO, 'diff', '--name-only', b, p, '--', '*.py').trim().split('\n').filter(Boolean));
  const s1 = side(p1), s2 = side(p2);
  for (const f of [...s1].filter((x) => s2.has(x))) {
    const base = show(REPO, b, f), ours = show(REPO, p1, f), theirs = show(REPO, p2, f);
    if (base === null || ours === null || theirs === null) continue;
    r.files++;
    const g = gitMergeFile(base, ours, theirs);
    const x = await regionMerge(f, base, ours, theirs);
    if (g.clean) r.gitClean++;
    if (x.status === 'merged') { if (g.clean && x.text === g.text) r.same++; else r.differ.push(`${m.slice(0, 10)} ${f}`); if (x.text === show(REPO, m, f)) r.matchesM++; }
    else if (x.status === 'conflict') r.rmConflict++; else r.unsupported++;
  }
}
const ok = r.differ.length === 0 && r.same === r.gitClean;
writeResult('t2a', [
  `T2a sample: every Django merge commit; each .py file changed on both sides`,
  `bar: regionMerge text == git merge-file text on every file git merges cleanly`,
  `merges=${r.merges} files=${r.files} git-clean=${r.gitClean} identical=${r.same} differ=${r.differ.length} rm-conflict=${r.rmConflict} unsupported=${r.unsupported} rm==commit=${r.matchesM}`,
  ...r.differ.map((d) => '  differs: ' + d),
  `T2a: ${ok ? 'PASS' : 'FAIL'} (${r.same}/${r.gitClean})`, ''].join('\n'), r);
console.log(`T2a ${ok ? 'PASS' : 'FAIL'}`);
