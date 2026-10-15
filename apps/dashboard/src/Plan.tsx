// Plan view: the partition — scoped symbols coloured by connected component, hubs larger, and who got which hub's contract.
import { useEffect, useMemo, useState } from 'react';
import { GraphView } from './GraphView';
import { componentColor, fetchPlan } from './stream';

interface PlanData {
  tasks: { id: string; title: string; component: number; scope: string[] }[]; hubs: string[]; hubOwner: Record<string, string>;
  nodes: { id: string; qname: string }[]; edges: { from: string; to: string }[];
}

export function Plan({ run }: { run: string }) {
  const [p, setP] = useState<PlanData | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setP(null); fetchPlan(run).then(setP).catch((e) => setErr(String(e))); }, [run]);
  const comp = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of p?.tasks ?? []) for (const s of t.scope) if (!m.has(s)) m.set(s, t.component);
    return m;
  }, [p]);
  if (err) return <p className="pad dim">{err}</p>;
  if (!p) return <p className="pad dim">loading…</p>;
  if (!p.tasks.length) return <p className="pad dim">No partition for this run yet — run <code>loom plan</code> or <code>loom run --plan</code>.</p>;
  const hubs = new Set(p.hubs);
  const node = (id: string) => ({
    color: componentColor(comp.get(id) ?? -1),
    size: hubs.has(id) ? 16 : 7,
    label: `${p.nodes.find((n) => n.id === id)?.qname ?? id}${hubs.has(id) ? ` ★ hub → ${p.hubOwner[id]}` : ''}`,
    ring: hubs.has(id) ? '#fde047' : null,
  });
  const comps = [...new Set(p.tasks.map((t) => t.component))].sort((a, b) => a - b);
  return (
    <div className="split">
      <GraphView nodes={p.nodes} edges={p.edges} node={node} />
      <aside>
        <h3>Workers by component</h3>
        {comps.map((c) => (
          <div key={c} className="comp">
            <span className="dot" style={{ background: componentColor(c) }} /> <b>component {c < 0 ? '–' : c}</b>
            <ul>{p.tasks.filter((t) => t.component === c).map((t) => (
              <li key={t.id}><b>{t.id}</b> {t.title}
                {Object.entries(p.hubOwner).filter(([, o]) => o === t.id).map(([h]) => <span key={h} className="tag">contract {h.split('::').pop()}</span>)}
              </li>))}
            </ul>
          </div>
        ))}
        <h3>Hubs</h3>
        {p.hubs.length ? <ul>{p.hubs.map((h) => <li key={h}><code>{h}</code> → {p.hubOwner[h]}</li>)}</ul> : <p className="dim">none</p>}
      </aside>
    </div>
  );
}
