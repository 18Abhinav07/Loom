import { useEffect, useState } from 'react';
import { api, couldNot, post, type PlanRow } from './api';
import { Empty, Problem } from './ui';

interface Detail { slug: string; plan: { goal: string; tasks: { id: string; title: string; after: string[]; owns: string[] }[] } | null; problems: string[] }
interface Checked { ok: boolean; problems: string[]; warnings: string[] }

export function Plans({ go }: { go: (v: string) => void }) {
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [sel, setSel] = useState('');
  const [d, setD] = useState<Detail | null>(null);
  const [chk, setChk] = useState<Checked | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api<PlanRow[]>('/plans').then((r) => { setRows(r); setSel((s) => s || r[0]?.slug || ''); }).catch((e) => setErr(couldNot('plans', e))); }, []);
  useEffect(() => {
    setD(null); setChk(null); setMsg('');
    if (sel) api<Detail>(`/plans/${encodeURIComponent(sel)}`).then(setD).catch((e) => setMsg(String(e.message ?? e)));
  }, [sel]);
  if (err) return <Problem msg={err} />;
  if (!rows) return <p className="dim">loading…</p>;
  if (!rows.length) return <Empty>No plans yet. Ask the lead to write one, or add <code>.loom/plans/&lt;name&gt;.md</code>.</Empty>;
  const check = () => post<Checked>('/plans/check', { slug: sel }).then(setChk).catch((e) => setMsg(e.message));
  const start = () => post('/teams', { plan: sel }).then(() => go('teams')).catch((e) => setMsg(e.message));
  return (
    <div className="page">
      <div className="row">
        <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="plan">{rows.map((r) => <option key={r.slug} value={r.slug}>{r.slug} · {r.tasks} tasks</option>)}</select>
        <button onClick={check}>Check</button><button disabled={chk?.ok === false} onClick={start}>Start team</button>
      </div>
      {msg && <p className="bad">{msg}</p>}
      {d?.plan && (
        <>
          <p>{d.plan.goal}</p>
          <ol>{d.plan.tasks.map((t) => <li key={t.id}><b>{t.id}</b> {t.title}{t.after.length > 0 && <span className="dim"> · after {t.after.join(', ')}</span>}<div className="dim">owns {t.owns.join(', ') || 'nothing'}</div></li>)}</ol>
        </>)}
      {d && !d.plan && <ul>{d.problems.map((p) => <li key={p} className="bad">{p}</li>)}</ul>}
      {chk && (chk.ok ? <p className="good">Plan is valid.</p> : <ul>{chk.problems.map((p) => <li key={p} className="bad">{p}</li>)}</ul>)}
      {chk?.warnings.length ? <ul>{chk.warnings.map((w) => <li key={w} className="dim">{w}</li>)}</ul> : null}
    </div>
  );
}
