import { useEffect, useState } from 'react';
import { api } from './api';

interface Row { sid: string; person: string; kind: string; parent: string | null; team: string | null; task: string | null; started: number; turns: number; handoff?: string }
interface Detail extends Omit<Row, 'turns'> { turns: { from: string; text: string; at: number }[]; versions: { region: string; commit: string }[]; children: string[] }
export const when = (t: number) => (t ? new Date(t).toLocaleString() : '');

export function Sessions() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  useEffect(() => { api<Row[]>('/sessions').then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <p className="pad dim">loading…</p>;
  if (!rows.length) return <p className="pad dim">No sessions recorded yet. They appear once Claude has worked in this repo with Loom on.</p>;
  return (
    <div className="pad split2">
      <div>{rows.map((s) => (
        <button key={s.sid} className={`srow ${open?.sid === s.sid ? 'on' : ''}`} onClick={() => api<Detail>(`/sessions/${s.sid}`).then(setOpen).catch(() => {})}>
          <b>{s.person}</b> <span className="dim">{s.kind}{s.team ? ` · team ${s.team}` : ''} · {s.turns} turns</span>
          {s.handoff && <div className="dim">{s.handoff}</div>}
        </button>))}</div>
      <div>
        {!open ? <p className="dim">Pick a session.</p> : (
          <>
            <h3>{open.person} · {open.kind}</h3>
            {open.turns.map((t, i) => <div key={i} className={`turn ${t.from}`}><span className="dim">{t.from}</span><div>{t.text}</div></div>)}
            {open.versions.length > 0 && <><h3>Changed</h3><ul>{open.versions.map((v, i) => <li key={i}><code>{v.region}</code> <span className="dim">{v.commit}</span></li>)}</ul></>}
          </>)}
      </div>
    </div>
  );
}
