import { useEffect, useState } from 'react';
import { api, couldNot } from './api';
import { Avatar, Empty, Problem, PageHead } from './ui';
import { ago, person } from './explain';

interface Row { sid: string; person: string; kind: string; parent: string | null; team: string | null; task: string | null; started: number; turns: number; handoff?: string }
interface Detail extends Omit<Row, 'turns'> { turns: { from: string; text: string; at: number }[]; versions: { region: string; commit: string | null }[]; children: string[] }
export const when = (t: number) => (t ? new Date(t).toLocaleString() : '');

export function Sessions() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<Detail | null>(null);
  useEffect(() => { api<Row[]>('/sessions').then(setRows).catch((e) => setErr(couldNot('sessions', e))); }, []);
  const head = <PageHead title="Sessions" what="Every Claude session that worked in this repo with Loom on: who ran it, what was said, and which functions it changed." />;
  if (err) return <div className="page">{head}<Problem msg={err} /></div>;
  if (!rows) return <div className="page">{head}<p className="dim">loading…</p></div>;
  if (!rows.length) return <div className="page">{head}<Empty>No sessions recorded yet. They appear once Claude has worked in this repo with Loom on.</Empty></div>;
  return (
    <div className="page">
      {head}
      <div className="sess">
        <div className="slist">{rows.map((s) => (
          <button key={s.sid} className={`card sitem ${open?.sid === s.sid ? 'on' : ''}`} onClick={() => api<Detail>(`/sessions/${s.sid}`).then(setOpen).catch(() => {})}>
            <Avatar name={person(s.person)} />
            <div className="sbody"><b>{person(s.person)}</b>
              <span className="dim">{s.kind}{s.team ? ` · team ${s.team}` : ''} · {s.turns} {s.turns === 1 ? 'turn' : 'turns'}{s.started ? ` · ${ago(s.started)}` : ''}</span>
              {s.handoff && <span className="dim sh">{s.handoff}</span>}</div>
          </button>))}</div>
        <div className="card sp sdetail">
          {!open ? <div className="dim" style={{ textAlign: 'center', padding: '60px 10px' }}>Pick a session on the left to read its conversation.</div> : (
            <>
              <div className="sdh"><Avatar name={person(open.person)} size={36} /><div><b>{person(open.person)}</b><div className="dim">{open.kind}{open.team ? ` · team ${open.team}` : ''}{open.task ? ` · task ${open.task}` : ''} · started {when(open.started)}</div></div></div>
              {!open.turns.length && <p className="dim">No messages were recorded for this session.</p>}
              <div className="chat">{open.turns.map((t, i) => <div key={i} className={`bub ${t.from === 'user' ? 'me' : 'ai'}`}><small>{t.from === 'user' ? 'user' : 'claude'}{t.at ? ` · ${ago(t.at)}` : ''}</small>{t.text}</div>)}</div>
              {open.versions.length > 0 && <><h3 style={{ marginTop: 14 }}>Functions it changed</h3><div>{open.versions.map((v, i) => <span key={i} className="chipr" style={{ '--c': 'var(--accent)' } as never}>{v.region.split('::').pop()}() <small className="dim">{(v.commit ?? '').slice(0, 7)}</small></span>)}</div></>}
            </>)}
        </div>
      </div>
    </div>
  );
}
