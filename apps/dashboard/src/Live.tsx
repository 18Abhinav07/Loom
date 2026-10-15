// Live view: who holds what, notices travelling the CALLS graph, denials flashing, the event tail.
import { useEffect, useMemo, useState } from 'react';
import { GraphView } from './GraphView';
import { agentColor, type RunState } from './stream';
import { focusIds, plain } from './plain';

const PULSE_MS = 1200; const FLASH_MS = 1800;
const short = (id: string) => id.split('::').pop() ?? id;
const ago = (t: number | null) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}s` : '–');

function line(e: RunState['events'][number]): string {
  const d = e.data ?? {}; const who = e.agent ?? '·';
  switch (e.type) {
    case 'lease.granted': return `${who} leased ${(d.symbols ?? []).map(short).join(', ')} (${d.mode})`;
    case 'lease.denied': return `${who} DENIED ${(d.symbols ?? []).map(short).join(', ')} — held by ${d.holder}`;
    case 'lease.released': return `${who} released ${(d.symbols ?? []).map(short).join(', ')}`;
    case 'change.recorded': return `${who} ${d.kind} ${short(d.symbol)}${d.after ? ` → ${d.after}` : ''}`;
    case 'notice.created': return `notice → ${who}: ${d.author} changed ${short(d.symbol)}`;
    case 'notice.delivered': return `${who} got ${(d.ids ?? []).length} notice(s)`;
    case 'gate.blocked': return `${who} stop blocked (${d.rule})`;
    case 'commit.recorded': return `${who} committed ${String(d.sha ?? '').slice(0, 7)} ${d.message ?? ''}`;
    case 'agent.woken': return `${who} woken: ${short(String(d.symbol ?? ''))} ${d.why ?? ''}`;
    case 'task.claimed': return `${who} claimed ${d.task} "${d.title}"`;
    case 'decision.recorded': return `${who} decided: ${d.text}`;
    case 'agent.state': return `${who} ${d.state}${d.code !== undefined ? ` (${d.code})` : ''}`;
    default: return `${who} ${e.type}`;
  }
}

export function Live({ st }: { st: RunState }) {
  const { snap } = st;
  const [tick, setTick] = useState(0);
  const [whole, setWhole] = useState(false);
  const [raw, setRaw] = useState(false);
  useEffect(() => {                      // animate while any effect is young
    if (!st.fx.some((f) => Date.now() - f.at < PULSE_MS + FLASH_MS)) return;
    const t = setInterval(() => setTick((x) => x + 1), 60);
    return () => clearInterval(t);
  }, [st.fx]);

  const lease = useMemo(() => {
    const m = new Map<string, { agent: string; contract: boolean }>();
    for (const l of snap.leases) { const p = m.get(l.symbol); if (!p || l.contract) m.set(l.symbol, { agent: l.agent, contract: l.contract }); }
    return m;
  }, [snap.leases]);

  const now = Date.now();
  const hot = new Map<string, string>();        // node or edge key -> colour override
  for (const f of st.fx) {
    const age = now - f.at;
    if (f.kind === 'deny' && age < FLASH_MS) {
      if (Math.floor(age / (FLASH_MS / 6)) % 2 === 0) for (const id of f.ids) hot.set(id, '#ef4444');   // 3 red flashes
    }
    if (f.kind === 'pulse' && age < PULSE_MS) {
      const steps = Math.max(1, f.ids.length);
      const i = Math.min(steps - 1, Math.floor((age / PULSE_MS) * steps));
      hot.set(f.ids[i], '#fde047');
      if (i > 0) hot.set(`${f.ids[i - 1]}->${f.ids[i]}`, '#fde047');
    }
  }

  // focused map: what matters now plus one CALLS hop; nothing hot yet → the whole map
  const focus = focusIds(snap, st.badges, st.fx);
  const fkey = focus ? [...focus].sort().join('|') : '';
  const shown = useMemo(() => {
    if (whole || !focus) return { nodes: snap.nodes, edges: snap.edges };
    return { nodes: snap.nodes.filter((n) => focus.has(n.id)), edges: snap.edges.filter((e) => focus.has(e.from) && focus.has(e.to)) };
  }, [whole, fkey, snap.nodes, snap.edges]);   // eslint-disable-line react-hooks/exhaustive-deps
  const caption = useMemo(() => {
    for (let i = st.events.length - 1; i >= 0; i--) { const t = plain(st.events[i]); if (t) return t; }
    return null;
  }, [st.events]);

  const node = (id: string) => {
    const l = lease.get(id); const b = st.badges[id];
    const n = snap.nodes.find((x) => x.id === id);
    const named = Boolean(l || b || hot.has(id) || (focus?.has(id) && !whole));   // whole map: only the hot symbols carry labels
    return {
      color: hot.get(id) ?? (l ? agentColor(l.agent) : '#6b7280'),
      size: (l ? 11 : 7) + (l?.contract ? 3 : 0) + (hot.has(id) ? 4 : 0),
      label: named ? `${n?.qname ?? short(id)}${b ? ` ·${b}` : ''}${l ? ` [${l.agent}${l.contract ? ' contract' : ''}]` : ''}` : '',
      ring: l?.contract ? agentColor(l.agent) : null,
    };
  };
  const edge = (a: string, b: string) => {
    const h = hot.get(`${a}->${b}`);
    return { color: h ?? '#4b5563', size: h ? 4 : 1 };
  };

  const byStatus = snap.notices.reduce<Record<string, number>>((m, n) => ((m[n.status] = (m[n.status] ?? 0) + 1), m), {});
  return (
    <div className="split">
      <div className="stage">
        <div className="caption">{caption ?? <span className="dim">Waiting for the agents to do something that affects each other…</span>}</div>
        <GraphView nodes={shown.nodes} edges={shown.edges} node={node} edge={edge} tick={tick} />
        <div className="legend">
          <span><i className="sw" style={{ background: agentColor(snap.agents[0]?.id ?? 'a') }} />colour = the agent working there</span>
          <span><i className="sw" style={{ background: '#fde047' }} />yellow pulse = Loom telling an agent</span>
          <span><i className="sw" style={{ background: '#ef4444' }} />red flash = edit blocked</span>
          <span><i className="sw ring" />ring = signature held</span>
          <button className={whole ? 'on' : ''} onClick={() => setWhole((w) => !w)}>{whole ? 'whole map' : focus ? `focused: ${focus.size} of ${snap.nodes.length}` : 'whole map'}</button>
        </div>
      </div>
      <aside>
        <h3>Agents</h3>
        {snap.agents.length === 0 && <p className="dim">none yet</p>}
        {snap.agents.map((a) => (
          <div key={a.id} className="agent">
            <span className="dot" style={{ background: agentColor(a.id) }} />
            <b>{a.id}</b> <span className={`state ${a.state}`}>{a.state}</span>
            <span className="dim"> {a.taskTitle ?? a.task ?? ''} · {ago(a.heartbeatAt)}</span>
          </div>
        ))}
        <h3>Notices</h3>
        <p>{Object.keys(byStatus).length ? Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · ') : <span className="dim">none</span>}</p>
        <h3>What happened <button className={`mini ${raw ? 'on' : ''}`} onClick={() => setRaw((r) => !r)}>all events</button></h3>
        <ol className={`events ${raw ? '' : 'plain'}`}>
          {[...st.events].reverse().flatMap((e, i) => {
            const t = raw ? line(e) : plain(e);
            return t ? [<li key={`${e.at}-${i}`} className={e.type.replace('.', '-')}>
              <span className="dim">{new Date(e.at).toLocaleTimeString()}</span> {t}</li>] : [];
          })}
        </ol>
      </aside>
    </div>
  );
}
