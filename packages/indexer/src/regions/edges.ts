import type { FileRegions, ImportBinding } from './types.js';

export interface Edge { kind: 'CALLS' | 'IMPORTS' | 'TESTS' | 'CONTAINS'; from: string; to: string; via: 'same_file' | 'import' | 'unique_name' }
export const TEST_PATH = /(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|\.test\.[jt]sx?$|\.spec\.[jt]sx?$/;
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

export function moduleKeys(path: string): string[] {
  if (/\.pyi?$/.test(path)) return [path.replace(/\.pyi?$/, '').replace(/\/__init__$/, '').replaceAll('/', '.')];
  const noExt = path.replace(/\.(d\.ts|[cm]?[jt]sx?)$/, '');
  return noExt.endsWith('/index') ? [noExt, noExt.slice(0, -'/index'.length)] : [noExt];
}

/** §3.9: resolution order same_file → import → unique_name → unresolved. */
export function buildEdges(files: FileRegions[]): { edges: Edge[]; unresolved: number } {
  const byQ = new Map<string, Map<string, string>>();
  const byName = new Map<string, string[]>();
  const mods = new Map<string, string>();
  for (const f of files) {
    const m = new Map<string, string>();
    byQ.set(f.path, m);
    for (const k of moduleKeys(f.path)) mods.set(k, f.path);
    for (const r of f.regions) {
      if (r.kind !== 'definition' && r.kind !== 'container') continue;
      if (!m.has(r.qname)) m.set(r.qname, r.id);
      const last = r.qname.split('.').at(-1)!;
      (byName.get(last) ?? byName.set(last, []).get(last)!).push(r.id);
    }
  }
  const lookup = (module: string, qname: string) => { const p = mods.get(module); return p ? byQ.get(p)?.get(qname) : undefined; };
  const dotted = (d: string) => {
    const parts = d.split('.');
    for (let i = parts.length - 1; i >= 1; i--) { const id = lookup(parts.slice(0, i).join('.'), parts.slice(i).join('.')); if (id) return id; }
    return undefined;
  };
  const target = (f: FileRegions, b: ImportBinding, rest: string) => {
    if (/\.pyi?$/.test(f.path)) return dotted([b.module, b.name, rest].filter(Boolean).join('.'));
    const q = [b.name && b.name !== 'default' ? b.name : null, rest].filter(Boolean).join('.');
    return q ? lookup(b.module, q) : undefined;
  };
  const out = new Map<string, Edge>();
  const add = (e: Edge) => { if (e.from !== e.to) out.set(`${e.kind}|${e.from}|${e.to}`, e); };
  let unresolved = 0;
  for (const f of files) {
    const local = byQ.get(f.path)!;
    const qOf = new Map(f.regions.map((r) => [r.id, r.qname]));
    const binds = new Map((f.imports ?? []).map((b) => [b.local, b]));
    for (const b of f.imports ?? []) {
      if (!b.name) continue;
      const t = target(f, b, '');
      if (t) add({ kind: 'IMPORTS', from: b.from, to: t, via: 'import' });
    }
    for (const c of f.calls ?? []) {
      let to: string | undefined;
      let via: Edge['via'] = 'same_file';
      if (DOTTED.test(c.name)) {
        const self = /^(self|this|cls)\.(.+)$/.exec(c.name);
        if (self) {
          const q = qOf.get(c.from) ?? '';
          for (let cls = q.slice(0, q.lastIndexOf('.')); cls && !to; cls = cls.includes('.') ? cls.slice(0, cls.lastIndexOf('.')) : '') to = local.get(`${cls}.${self[2]}`);
        } else {
          to = local.get(c.name);
          if (!to) {
            const [head, ...rest] = c.name.split('.');
            const b = binds.get(head);
            if (b && (to = target(f, b, rest.join('.')))) via = 'import';
          }
        }
      }
      if (!to) {
        const last = /([A-Za-z_$][\w$]*)\s*$/.exec(c.name)?.[1];
        const cands = last ? byName.get(last) : undefined;
        if (cands?.length === 1) { to = cands[0]; via = 'unique_name'; }
      }
      if (!to) { unresolved++; continue; }
      add({ kind: 'CALLS', from: c.from, to, via });
      if (TEST_PATH.test(f.path)) add({ kind: 'TESTS', from: c.from, to, via });
    }
    for (const r of f.regions) {
      if (r.kind !== 'container') continue;
      for (const s of f.regions) {
        if ((s.kind === 'definition' || s.kind === 'container') && s.qname.startsWith(`${r.qname}.`) && !s.qname.slice(r.qname.length + 1).includes('.'))
          add({ kind: 'CONTAINS', from: r.id, to: s.id, via: 'same_file' });
      }
    }
  }
  return { edges: [...out.values()], unresolved };
}
