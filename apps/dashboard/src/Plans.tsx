import { useEffect, useState } from 'react';
import { api, couldNot, post, type PlanRow, type Team } from './api';
import { ago, startedBy } from './explain';
import { Bot, Empty, Problem } from './ui';

interface Task { id: string; title: string; after: string[]; owns: string[] }
interface Detail { slug: string; plan: { goal: string; tasks: Task[] } | null; problems: string[] }
interface Checked { ok: boolean; problems: string[]; warnings: string[] }

export function Plans({ go }: { go: (v: string) => void }) {
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [sel, setSel] = useState('');
  const [d, setD] = useState<Detail | null>(null);
  const [chk, setChk] = useState<Checked | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api<PlanRow[]>('/plans').then((r) => { setRows(r); setSel((s) => s || r[0]?.slug || ''); }).catch((e) => setErr(couldNot('plans', e)));
    api<Team[]>('/teams').then(setTeams).catch(() => {});
  }, []);
  useEffect(() => {
    setD(null); setChk(null); setMsg('');
    if (sel) api<Detail>(`/plans/${encodeURIComponent(sel)}`).then(setD).catch((e) => setMsg(String(e.message ?? e)));
  }, [sel]);
  if (err) return <Problem msg={err} />;
  if (!rows) return <p className="dim">loading…</p>;
  if (!rows.length) return (
    <section className="screen on page"><div className="card onboard reveal"><Bot color="#9A988F" size={56} /><h3>No plans yet</h3>
      <p>A plan is the Lead's split of one goal into tasks, each owning its own files. Ask the Lead to write one, or save <code>.loom/plans/&lt;name&gt;.md</code> yourself.</p>
      <div className="cardrow" style={{ justifyContent: 'center' }}><button className="btn or" onClick={() => go('lead')}>Open the Lead</button></div></div></section>);
  const check = () => post<Checked>('/plans/check', { slug: sel }).then(setChk).catch((e) => setMsg(e.message));
  const start = () => post('/teams', { plan: sel }).then(() => go('teams')).catch((e) => setMsg(e.message));
  const runs = teams.filter((t) => t.plan === sel).sort((a, b) => b.startedAt - a.startedAt);
  return (
    <section className="screen on page">
      <h2 className="pgtitle reveal">Plans</h2>
      <p className="pgsub reveal">A plan splits one goal into tasks. Each task owns its files and gets its own Claude agent.</p>
      <div className="row reveal" style={{ gap: 8, marginBottom: 14 }}>
        {rows.map((r) => <button key={r.slug} className={`chip ${r.slug === sel ? 'on' : ''}`} onClick={() => setSel(r.slug)}>{r.slug} · {r.tasks} tasks</button>)}
      </div>
      {msg && <p className="bad">{msg}</p>}
      {d?.plan && (
        <div className="two" style={{ gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)' }}>
          <div className="stack">
            <div className="card sp reveal"><div className="h">Goal</div><p style={{ margin: '6px 0 0', font: '500 17px var(--serif)' }}>{d.plan.goal}</p></div>
            {d.plan.tasks.map((t) => (
              <div key={t.id} className="card sp reveal" data-testid="plan-task">
                <div className="row" style={{ gap: 10, alignItems: 'center' }}><span className="chipr chipw">{t.id}</span><b>{t.title}</b></div>
                <div className="kv2" style={{ marginTop: 8 }}><span>Owns</span><span>{t.owns.length ? t.owns.map((o) => <span key={o} className="chipr">{o}</span>) : <span className="dim">nothing</span>}</span></div>
                {t.after.length > 0 && <div className="kv2"><span>After</span><span>{t.after.map((a) => <span key={a} className="chipr chipw">{a}</span>)}</span></div>}
              </div>))}
            <div className="row reveal" style={{ gap: 10 }}>
              <button className="btn ghost" onClick={check}>Check plan</button>
              <button className="btn or" disabled={chk?.ok === false} onClick={start}>Start team →</button>
            </div>
            {chk && (chk.ok ? <p className="good">Plan is valid: every task owns its files and nothing overlaps.</p> : <ul>{chk.problems.map((p) => <li key={p} className="bad">{p}</li>)}</ul>)}
            {chk?.warnings.length ? <ul>{chk.warnings.map((w) => <li key={w} className="dim">{w}</li>)}</ul> : null}
          </div>
          <div className="card sp reveal">
            <div className="h">Who ran this plan</div>
            <div className="expl">Each run is a team: who started it, and what came of it.</div>
            {!runs.length ? <p className="dim" style={{ marginTop: 10 }}>No team has run this plan yet. “Start team” spawns one agent per task.</p>
              : runs.map((t) => (
                <div key={t.id} className="mv" style={{ '--kc': t.state === 'done' ? 'var(--good)' : 'var(--wait)' } as never}>
                  <div className="t">{t.state} · {ago(t.startedAt)}</div>
                  <p>{startedBy(t)}</p>
                  <p>{t.agents.filter((a) => a.lands.includes('landed')).length} of {t.agents.length} agents landed{t.landed ? <> · branch <code>{t.landed}</code></> : null}</p>
                </div>))}
          </div>
        </div>)}
      {d && !d.plan && <ul>{d.problems.map((p) => <li key={p} className="bad">{p}</li>)}</ul>}
    </section>
  );
}
