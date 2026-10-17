// Demo mode: replays the recorded real run (3 Claude agents on one codebase) through the same event stream a live team uses.
import { useEffect, useState } from 'react';
import { post } from './api';
import { getJson } from './stream';
import { agentColor, useRun, type LoomEvent, type RunState } from './stream';
import { Bot } from './ui';

export interface DemoAgent { id: string; name: string; status: 'working' | 'editing' | 'waiting' | 'landed'; note: string }
export interface DemoRow { name: string; holder?: string; waiter?: string }
export interface DemoModel { agents: DemoAgent[]; files: { file: string; rows: DemoRow[] }[]; locked: number; waiting: number; landed: number; caption: string }

const fn = (sym: string) => `${sym.split('::')[1] ?? sym}()`;
const dir = (file: string) => file.split('/').slice(1).join('/') || file;
const symsOf = (e: LoomEvent) => ((e.data?.symbols as string[] | undefined) ?? []);

export function demoModel(st: RunState): DemoModel {
  const { snap, events } = st;
  const lastOf = (agent: string, ...types: string[]) => { for (let i = events.length - 1; i >= 0; i--) if (events[i].agent === agent && types.includes(events[i].type)) return i; return -1; };
  const landedBy = new Set(events.filter((e) => e.type === 'change.landed').map((e) => e.agent));
  const denial = (a: string) => { const d = lastOf(a, 'lease.denied'); return d >= 0 && d > lastOf(a, 'lease.granted', 'change.landed', 'agent.state') ? events[d] : null; };
  const agents: DemoAgent[] = snap.agents.map((a) => {
    const name = a.taskTitle ?? a.id; const held = snap.leases.find((l) => l.agent === a.id); const den = denial(a.id);
    const told = snap.notices.find((n) => n.agent === a.id && n.status !== 'resolved');
    if (landedBy.has(a.id)) return { id: a.id, name, status: 'landed', note: 'landed' };
    if (den) return { id: a.id, name, status: 'waiting', note: `waits for ${den.data.holder} on ${fn(symsOf(den)[0])}` };
    if (held) return { id: a.id, name, status: 'editing', note: `editing ${fn(held.symbol)}` };
    if (told) return { id: a.id, name, status: 'working', note: `told: ${fn([...events].reverse().find((e) => e.type === 'notice.created' && e.agent === a.id)?.data.symbol ?? '')} changed` };
    return { id: a.id, name, status: 'working', note: 'working' };
  });
  const rows = new Map<string, DemoRow>(); const fileOf = (sym: string) => snap.nodes.find((n) => n.id === sym)?.file ?? sym.split('::')[0];
  const row = (sym: string) => { let r = rows.get(sym); if (!r) rows.set(sym, r = { name: fn(sym) }); return r; };
  for (const l of snap.leases) row(l.symbol).holder = l.agent;
  for (const a of agents) { const d = a.status === 'waiting' ? denial(a.id) : null; if (d) row(symsOf(d)[0]).waiter = a.id; }
  const files: DemoModel['files'] = [];
  for (const [sym, r] of rows) { const f = dir(fileOf(sym)); let g = files.find((x) => x.file === f); if (!g) files.push(g = { file: f, rows: [] }); g.rows.push({ name: r.name, holder: r.holder, waiter: r.waiter }); }
  const cap = [...events].reverse().find((e) => ['lease.denied', 'notice.created', 'change.landed', 'lease.granted'].includes(e.type));
  const caption = !cap ? 'Waiting for the team to start.'
    : cap.type === 'lease.denied' ? `${cap.agent} needs ${fn(symsOf(cap)[0])}, which ${cap.data.holder} holds. ${cap.agent} waits its turn instead of colliding.`
    : cap.type === 'notice.created' ? `${cap.data.author} changed ${fn(cap.data.symbol)}. ${cap.agent} calls it, so ${cap.agent} is told.`
    : cap.type === 'change.landed' ? `${cap.agent}'s work merged, every call still fits, tests pass: it landed on the shared branch.`
    : `${cap.agent} locks ${fn(symsOf(cap)[0])} before editing it.`;
  return { agents, files, locked: snap.leases.length, waiting: agents.filter((a) => a.status === 'waiting').length, landed: landedBy.size, caption };
}

export function DemoStage() {
  const [run, setRun] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const start = () => { setRun(null); setErr(''); post<{ run: string }>('/demo/replay', { speed: 1.5 }).then((r) => setRun(r.run)).catch((e) => setErr((e as Error).message)); };
  useEffect(start, []);
  return <RunStage run={run} label="demo · recorded run" err={err ? `Could not start the demo: ${err}` : ''} onReplay={start} />;
}

/** The agents working in this repo right now: any run the daemon holds that is not the demo replay. Empty until a session registers. */
export function LiveStage({ idle }: { idle: React.ReactNode }) {
  const [run, setRun] = useState<string | null>(null);
  useEffect(() => {
    const poll = () => getJson<string[]>('/runs').then((rs) => { const r = rs.filter((x) => !x.startsWith('coord:replay')); setRun((p) => (p && r.includes(p) ? p : r[r.length - 1] ?? null)); }).catch(() => {});
    poll(); const t = setInterval(poll, 3000); return () => clearInterval(t);
  }, []);
  const st = useRun(run);
  if (!run || !st.snap.agents.length) return <>{idle}</>;
  return <RunStage run={run} label="live · this repo" />;
}

function RunStage({ run, label, err, onReplay }: { run: string | null; label: string; err?: string; onReplay?: () => void }) {
  const m = demoModel(useRun(run));
  return (
    <>
      <div className="bar">
        <span><b>{m.agents.length}</b>agents</span><span><b>{m.locked}</b>locked</span><span><b>{m.waiting}</b>waiting</span><span><b>{m.landed}</b>landed</span>
        <span className="sp" /><span>{label}</span>
      </div>
      <div className="floor" style={{ height: 380 }}>
        {err && <p className="bad" style={{ padding: 16 }}>{err}</p>}
        {m.agents.map((a, i) => (
          <div key={a.id} className="agent5" style={{ [i % 2 ? 'right' : 'left']: '1%', top: 8 + Math.floor(i / 2) * 150 + (i % 2 ? 70 : 0) } as never}>
            <div className="bw"><Bot color={agentColor(a.id)} size={54} mode={a.status === 'editing' ? 'm-work' : a.status === 'waiting' ? 'm-sleep' : ''} /></div>
            <div className="nm" style={{ color: agentColor(a.id) }}>{a.name}</div><div className="st">{a.note}</div>
          </div>))}
        <div className="h5repo">
          {m.files.map((f) => (
            <div key={f.file} className="file"><div className="fn"><span>{f.file}</span></div>
              {f.rows.map((r) => (
                <div key={r.name} className="row5" style={r.holder ? { borderColor: agentColor(r.holder) } : undefined}><span>{r.name}</span>
                  <span className="h5tag">{r.holder && <span className="h5pill" style={{ background: 'var(--panel2, #eee)', color: agentColor(r.holder) }}>🔒 {r.holder}</span>}{r.waiter && <span className="h5pill" style={{ background: 'var(--wait-soft)', color: 'var(--wait-d)' }}>{r.waiter} waits</span>}</span></div>))}
            </div>))}
        </div>
        <div className="h5lane">
          <div className="lbl">Shared branch</div>
          <div className="gates"><div className="gate"><i>·</i>Merges</div><span className="garrow">→</span><div className="gate"><i>·</i>Callers fit</div><span className="garrow">→</span><div className="gate"><i>·</i>Tests pass</div></div>
          <div className="landed5">{Array.from({ length: Math.max(3, m.agents.length) }, (_, i) => <div key={i} className="slot">{i < m.landed ? '✓' : ''}</div>)}</div>
        </div>
      </div>
      <div className="h5cap"><span className="n">{m.landed + m.waiting + 1}</span><p>{m.caption}</p>{onReplay && <div className="ctl"><button onClick={onReplay} title="Replay" aria-label="Replay">↺</button></div>}</div>
    </>
  );
}
