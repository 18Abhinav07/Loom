// Live coordination D: before landed moves, every call that this landing could have broken must still bind to what it calls.
// Two sides can break a call: a signature changed here (all its callers in the merged tree are checked) or a call written here
// (checked against the merged signature). Python only; a call Loom cannot judge (*args, **kw, outside the repo) passes.
import { spawnSync } from 'node:child_process';
import type { CallRec, FileIndex, SymbolRec } from '@loom/core';
import { callSatisfies, indexPython } from '@loom/indexer';

export interface Break { file: string; line: number; caller: string; callee: string; why: string; missing?: boolean }   // missing: the callee is not there (yet)

const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const PY = /\.py$/;
const shape = (c: CallRec) => [c.argc ? `${c.argc} positional` : 'no positional', c.kwargs.length ? `keywords ${c.kwargs.join(', ')}` : ''].filter(Boolean).join(', ');

// A test that calls with the wrong arguments on purpose expects the TypeError that call raises: not a break.
const RAISES_TYPE = /^\s*(async\s+)?with\b.*\b(raises|assertRaises|assertRaisesRegexp?)\s*\(\s*\(?[^)]*\bTypeError\b/;
const indent = (l: string) => l.length - l.trimStart().length;
function expectsTypeError(source: string, line: number): boolean {
  const ls = source.split('\n');
  let lvl = indent(ls[line - 1] ?? '');
  for (let i = line - 2; i >= 0 && lvl > 0; i--) {
    if (!ls[i].trim() || indent(ls[i]) >= lvl) continue;
    lvl = indent(ls[i]);
    if (RAISES_TYPE.test(ls[i])) return true;
  }
  return false;
}

export async function contractBreaks(wt: string, from: string, to: string): Promise<Break[]> {
  const cache = new Map<string, FileIndex | null>();
  const at = async (ref: string, f: string): Promise<FileIndex | null> => {
    const k = `${ref}:${f}`;
    if (!cache.has(k)) {
      const r = git(wt, 'show', k);
      cache.set(k, r.status === 0 ? await indexPython(f, r.stdout) : null);
    }
    return cache.get(k)!;
  };
  const files = git(wt, 'diff', '--name-only', from, to).stdout.split('\n').filter((f) => PY.test(f));
  const checks: Array<{ c: CallRec; file: string }> = [];
  const resig = new Set<string>();   // symbol ids whose signature changed or that went away
  for (const f of files) {
    const [A, B] = [await at(from, f), await at(to, f)];
    const old = new Map((A?.symbols ?? []).map((s) => [s.id, s]));
    const now = new Map((B?.symbols ?? []).map((s) => [s.id, s]));
    for (const s of old.values()) if (s.kind !== 'class' && (!now.has(s.id) || now.get(s.id)!.sigHash !== s.sigHash)) resig.add(s.id);
    const edited = new Set([...now.values()].filter((s) => old.get(s.id)?.bodyHash !== s.bodyHash || old.get(s.id)?.sigHash !== s.sigHash).map((s) => s.id));
    for (const c of B?.calls ?? []) if (edited.has(c.from)) checks.push({ c, file: f });
  }
  for (const id of resig) {
    const name = id.split('::')[1].split('.').at(-1)!;
    const hits = git(wt, 'grep', '-l', '-w', '-e', name, to, '--', '*.py').stdout.split('\n').filter(Boolean).map((l) => l.slice(to.length + 1));
    for (const f of hits) for (const c of (await at(to, f))?.calls ?? []) if (c.to.includes(id)) checks.push({ c, file: f });
  }

  const out = new Map<string, Break>();
  for (const { c, file } of checks) {
    const key = `${file}:${c.line}:${c.callee}`;
    if (out.has(key)) continue;
    let target: SymbolRec | undefined; let known = false;
    for (const cand of c.to) {
      const [path, qname] = cand.split('::');
      const idx = await at(to, path);
      if (!idx) continue;
      known = true;
      target = idx.symbols.find((s) => s.qname === qname);
      // a name the module only re-exports or assigns is not judged: it must not appear there at all to count as missing
      if (!target && new RegExp(`\\b${qname.split('.').at(-1)}\\b`).test(idx.source)) known = false;
      if (target || !known) break;
    }
    const caller = c.from.split('::')[1];
    const callee = c.callee;
    if (known && !target) out.set(key, { file, line: c.line, caller, callee, why: `${callee} does not exist in the merged code`, missing: true });
    else if (target?.kind === 'class' || !target) continue;
    else if (callSatisfies(c, target.params) === false && !expectsTypeError((await at(to, file))!.source, c.line)) out.set(key, { file, line: c.line, caller, callee, why: `called with ${shape(c)}; the merged signature is ${target.sig}` });
  }
  return [...out.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export const renderBreaks = (bs: Break[]) =>
  ['calls that no longer fit what they call in the merged code:', ...bs.map((b) => `  ${b.file}:${b.line} ${b.caller} calls ${b.callee}: ${b.why}`)].join('\n');
