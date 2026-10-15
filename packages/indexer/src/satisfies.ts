import type { CallRec, ParamSpec, Satisfies } from '@loom/core';

/** Spec 5.12: does a call site with this shape bind against this signature? */
export function callSatisfies(call: Pick<CallRec, 'argc' | 'kwargs' | 'star' | 'dstar' | 'method'>, p?: ParamSpec): Satisfies {
  if (!p || call.star || call.dstar) return 'unknown';
  let posonly = p.posonly; let pos = p.pos;
  if (p.self && call.method) { if (posonly.length) posonly = posonly.slice(1); else pos = pos.slice(1); }
  const positional = [...posonly, ...pos];
  if (call.argc > positional.length && !p.vararg) return false;
  const bound = new Set(positional.slice(0, call.argc).map((x) => x.name));
  for (const k of call.kwargs) {
    if (posonly.some((x) => x.name === k)) { if (p.kwarg) continue; return false; }
    const named = pos.some((x) => x.name === k) || p.kwonly.some((x) => x.name === k);
    if (named) { if (bound.has(k)) return false; bound.add(k); continue; }
    if (!p.kwarg) return false;
  }
  return [...positional, ...p.kwonly].every((x) => x.default || bound.has(x.name));
}
