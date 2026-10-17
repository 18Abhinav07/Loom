import { useEffect, useState } from 'react';
import { api, couldNot, post, type Collision, type Team, type TeamAgent } from './api';
import { agentColor } from './stream';
import { Bot, Problem } from './ui';

const WORKING = new Set(['working', 'starting']);
const WAITING = new Set(['waiting', 'blocked']);
const pill = (a: TeamAgent) => (WORKING.has(a.state) ? 'working' : WAITING.has(a.state) ? 'waiting' : a.lands.length ? 'landed' : 'idle');
const KIND: Record<string, [string, string]> = {
  lock_wait: ['wait', 'Made to wait'], lock_denied: ['wait', 'Edit refused'], caller_warning: ['notice', 'Warned about a caller'],
  landing_rejected: ['back', 'Sent back'], merge_conflict: ['back', 'Merge conflict'], out_of_scope: ['back', 'Out of scope'], divergence: ['notice', 'Diverged'], stale_version: ['notice', 'Stale version'],
};

function AgentCard({ team, a, refresh }: { team: Team; a: TeamAgent; refresh: () => void }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const act = async (path: string, body: Record<string, unknown>, done?: () => void) => {
    try { await post(`/teams/${team.id}/${path}`, body); done?.(); setNote(''); refresh(); } catch (e) { setNote((e as Error).message); }
  };
  const c = agentColor(a.id);
  return (
    <div className={`card ag ${pill(a) === 'waiting' ? 'waiting' : ''} ${a.lands.length ? 'landed' : ''}`} style={{ '--c': c } as never} data-testid="agent-card">
      <div className="aghead">
        <div className="botw"><Bot color={c} size={46} mode={WORKING.has(a.state) ? 'm-work' : ''} /><span className="badge">✓</span></div>
        <div><div className="agname">{a.id}</div><div className="agtask">{a.title}</div></div>
        <span className={`state st-${pill(a)}`}>{a.state}</span>
      </div>
      <div className="agbody">
        {a.after.length > 0 && <div className="kv2"><span>After</span><span>{a.after.map((x) => <span key={x} className="chipr chipw">{x}</span>)}</span></div>}
        <div className="kv2"><span>Landed</span><span>{a.lands.length ? a.lands.map((l) => <span key={l} className="chipr">{l}</span>) : <span className="dim">nothing yet</span>}{a.resumed > 0 && <span className="dim"> · resumed {a.resumed}×</span>}</span></div>
        {a.lastReply && <div className="term"><span className="p">›</span> {a.lastReply}</div>}
        <div className="cardrow">
          <input aria-label="message to agent" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message this agent" />
          <button className="btn sm" disabled={!text.trim()} onClick={() => act('message', { agent: a.id, text: text.trim() }, () => setText(''))}>Send</button>
        </div>
        <div className="cardrow">
          <button className="btn ghost sm" onClick={() => act('stop-agent', { agent: a.id })}>Stop agent</button>
          <button className="btn ghost sm" onClick={() => act('restart-agent', { agent: a.id })}>Restart</button>
        </div>
        {note && <p className="bad">{note}</p>}
      </div>
    </div>
  );
}

export function Teams({ go }: { go?: (v: string) => void }) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [cols, setCols] = useState<Collision[]>([]);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  const [all, setAll] = useState('');
  const refresh = () => {
    api<Team[]>('/teams').then((t) => { setErr(''); setTeams(t); }).catch((e) => setErr(couldNot('teams', e)));
    api<Collision[]>('/collisions').then(setCols).catch(() => {});
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, []);
  if (err) return <Problem msg={err} />;
  if (!teams) return <p className="dim">loading…</p>;
  const newest = [...teams].sort((a, b) => b.startedAt - a.startedAt);
  const current = teams.find((t) => t.id === pick) ?? newest.find((t) => t.state === 'running') ?? newest[0];
  if (!current) return (
    <section className="screen on page"><div className="card onboard reveal"><Bot color="#9A988F" size={56} /><h3>No team running</h3><p>Describe some work to the Lead, or start a team from a plan.</p>
      <div className="cardrow" style={{ justifyContent: 'center' }}><button className="btn or" onClick={() => go?.('home')}>Start from Home</button><button className="btn ghost" onClick={() => go?.('plans')}>Review plans</button></div></div></section>);
  const landed = current.agents.filter((a) => a.lands.length).length;
  const n = current.agents.length;
  const mine = (k: string) => cols.filter((c) => c.kind === k).length;
  const stat = (v: number, k: string) => <div className="stat"><div className="v">{v}</div><div className="k">{k}</div></div>;
  const stop = () => post(`/teams/${current.id}/stop`).then(refresh).catch((e) => setErr(String(e.message ?? e)));
  const tellAll = () => { const t = all.trim(); if (!t) return; Promise.all(current.agents.map((a) => post(`/teams/${current.id}/message`, { agent: a.id, text: t }))).then(() => { setAll(''); refresh(); }).catch((e) => setErr(String(e.message ?? e))); };
  return (
    <section className="screen on">
      <div className="card tstrip reveal">
        <div className="tname"><h2 style={{ font: '600 18px var(--serif)' }}>{current.plan}</h2><small>{landed} of {n} tasks landed</small><div className="prog"><i style={{ width: `${n ? (landed / n) * 100 : 0}%` }} /></div></div>
        {stat(current.agents.filter((a) => WORKING.has(a.state)).length, 'agents working')}
        {stat(current.agents.filter((a) => WAITING.has(a.state)).length, 'agents waiting')}
        {stat(mine('caller_warning'), 'warnings sent')}
        {stat(mine('landing_rejected'), 'breaks caught')}
        <div className="spacer" />
        {teams.length > 1 && <select aria-label="team" value={current.id} onChange={(e) => setPick(e.target.value)}>{newest.map((t) => <option key={t.id} value={t.id}>{t.plan} · {t.state}</option>)}</select>}
        <span className={`state st-${current.state === 'running' ? 'working' : current.state === 'done' ? 'landed' : 'idle'}`}>{current.state}</span>
        {current.state === 'running' && <button className="btn ghost" onClick={stop}>Stop team</button>}
      </div>
      <p className="pgsub reveal">{current.goal}</p>
      <div className="two" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' }}>
        <div className="stack">
          <div className="steps" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))' }}>{current.agents.map((a) => <AgentCard key={a.id} team={current} a={a} refresh={refresh} />)}</div>
          {current.state === 'running' && <div className="card sp"><div className="h">Message all agents</div><div className="cardrow" style={{ marginTop: 10 }}><input aria-label="message to all agents" value={all} onChange={(e) => setAll(e.target.value)} placeholder="Tell every agent…" /><button className="btn sm" disabled={!all.trim()} onClick={tellAll}>Send to all</button></div></div>}
        </div>
        <div className="card feed reveal" style={{ position: 'static', maxHeight: 'none' }}>
          <div className="h">What Loom just did</div>
          <div className="expl">Newest first.</div>
          <div className="moves">{!cols.length ? <div className="emptyfeed">No collisions so far. Nobody has stepped on anyone else's work.</div>
            : cols.slice(0, 20).map((c) => { const [k, label] = KIND[c.kind] ?? ['notice', c.kind]; const color = { wait: 'var(--wait)', notice: 'var(--blue-d)', back: 'var(--bad)' }[k]; return (
              <div key={c.id} className="mv" style={{ '--kc': color } as never}><div className="t">{label}</div><p>{c.region.join(', ')} · {c.outcome}</p><p>{c.detail}</p></div>); })}</div>
        </div>
      </div>
    </section>
  );
}
