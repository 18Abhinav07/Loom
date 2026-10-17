// Live run state: the snapshot plus the SSE event stream folded into it. The snapshot is re-fetched (debounced) on change.recorded.
import { useEffect, useState } from 'react';

export interface Node { id: string; qname: string; file: string; kind: string }
export interface Lease { agent: string; symbol: string; mode: string; contract: boolean; expires: number }
export interface Agent { id: string; state: string; heartbeatAt: number | null; task: string | null; taskTitle: string | null }
export interface Notice { id: string; agent: string; author: string; status: string; kind?: string; text: string }
export interface Snapshot { nodes: Node[]; edges: { from: string; to: string }[]; agents: Agent[]; leases: Lease[]; notices: Notice[] }
export interface LoomEvent { type: string; at: number; run: string; agent?: string; data: Record<string, any> }
/** A transient effect the graph animates: a notice pulse along a path, or a denied-lease flash. */
export interface Fx { kind: 'pulse' | 'deny'; ids: string[]; at: number }
export interface RunState { snap: Snapshot; events: LoomEvent[]; badges: Record<string, number>; fx: Fx[]; live: boolean }

const EMPTY: Snapshot = { nodes: [], edges: [], agents: [], leases: [], notices: [] };
export const initial = (): RunState => ({ snap: EMPTY, events: [], badges: {}, fx: [], live: false });

const qid = (s: Snapshot, q: string) => s.nodes.find((n) => n.id === q || n.qname === q)?.id;

export function reduce(st: RunState, e: LoomEvent): RunState {
  const s = st.snap; const d = e.data ?? {};
  const events = e.type === 'step.recorded' ? st.events : [...st.events, e].slice(-30);   // trace steps are the agent's, not coordination
  const ids = (d.symbols as string[] | undefined) ?? [];
  switch (e.type) {
    case 'lease.granted': {
      const keep = s.leases.filter((l) => !(l.agent === e.agent && ids.includes(l.symbol)));
      const add = ids.map((symbol) => ({ agent: e.agent!, symbol, mode: d.mode, contract: d.mode === 'contract', expires: Infinity }));
      return { ...st, events, snap: { ...s, leases: [...keep, ...add] } };
    }
    case 'lease.released':
      return { ...st, events, snap: { ...s, leases: s.leases.filter((l) => !(l.agent === e.agent && ids.includes(l.symbol))) } };
    case 'lease.denied':
      return { ...st, events, fx: [...st.fx, { kind: 'deny', ids, at: Date.now() }] };
    case 'change.recorded':
      return { ...st, events, badges: { ...st.badges, [d.symbol]: (st.badges[d.symbol] ?? 0) + 1 } };
    case 'notice.created': {
      const path = ((d.path as string[] | undefined) ?? []).map((q) => qid(s, q)).filter(Boolean) as string[];
      const n: Notice = { id: d.id, agent: e.agent!, author: d.author, status: 'pending', text: '' };
      return { ...st, events, fx: [...st.fx, { kind: 'pulse', ids: path.length ? path : [d.symbol], at: Date.now() }],
        snap: { ...s, notices: [...s.notices.filter((x) => x.id !== n.id), n] } };
    }
    case 'notice.delivered':
    case 'notice.resolved': {
      const set = new Set(d.ids as string[]); const status = e.type === 'notice.delivered' ? 'delivered' : 'resolved';
      return { ...st, events, snap: { ...s, notices: s.notices.map((n) => (set.has(n.id) ? { ...n, status } : n)) } };
    }
    case 'agent.registered':
      return { ...st, events, snap: s.agents.some((a) => a.id === e.agent) ? s
        : { ...s, agents: [...s.agents, { id: e.agent!, state: 'active', heartbeatAt: e.at, task: null, taskTitle: null }] } };
    case 'agent.state':
      return { ...st, events, snap: { ...s, agents: s.agents.map((a) => (a.id === e.agent ? { ...a, state: d.state } : a)) } };
    case 'task.claimed':
      return { ...st, events, snap: { ...s, agents: s.agents.map((a) => (a.id === e.agent ? { ...a, task: d.task, taskTitle: d.title } : a)) } };
    default:
      return { ...st, events, snap: { ...s, agents: s.agents.map((a) => (a.id === e.agent ? { ...a, heartbeatAt: e.at, state: a.state === 'exited' ? a.state : 'active' } : a)) } };
  }
}

export const getJson = async <T,>(path: string): Promise<T> => {
  const r = await fetch(path);
  if (!r.ok) {
    const e = await r.json().then((b: { error?: unknown }) => b?.error, () => undefined);
    throw new Error(typeof e === 'string' ? e : `${path}: ${r.status}`);
  }
  return r.json();
};
export const fetchRuns = () => getJson<string[]>('/runs');
export const fetchPlan = (run: string) => getJson<any>(`/plan?run=${encodeURIComponent(run)}`);

/** Subscribe to one run: snapshot first, then events; fx older than 4 s are dropped. */
export function useRun(run: string | null, pollMs = 0): RunState {
  const [st, setSt] = useState<RunState>(initial);
  useEffect(() => {
    setSt(initial());
    if (!run) return;
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const q = encodeURIComponent(run);
    const refetch = () => getJson<Snapshot>(`/snapshot?run=${q}`).then((snap) => alive && setSt((p) => ({ ...p, snap }))).catch(() => {});
    refetch();
    const es = new EventSource(`/events?run=${q}`);
    es.onopen = () => setSt((p) => ({ ...p, live: true }));
    es.onerror = () => setSt((p) => ({ ...p, live: false }));
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as LoomEvent;
      setSt((p) => reduce(p, e));
      if (e.type === 'change.recorded' || e.type === 'lease.granted' || e.type === 'agent.registered') {
        clearTimeout(timer); timer = setTimeout(refetch, 500);
      }
    };
    const poll = pollMs ? setInterval(refetch, pollMs) : undefined;
    const gc = setInterval(() => setSt((p) => (p.fx.length ? { ...p, fx: p.fx.filter((f) => Date.now() - f.at < 4000) } : p)), 1000);
    return () => { alive = false; es.close(); clearTimeout(timer); clearInterval(gc); if (poll) clearInterval(poll); };
  }, [run, pollMs]);
  return st;
}

/** A stable colour per agent id. */
const PALETTE = ['#D97757', '#5B8FC7', '#9B6BB5', '#4F8A43', '#C99619', '#2E9AA0', '#C4554D', '#7A6A5A'];
export function agentColor(id: string): string {
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export const componentColor = (i: number) => (i < 0 ? '#6b7280' : PALETTE[i % PALETTE.length]);
