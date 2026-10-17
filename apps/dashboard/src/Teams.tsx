import { useEffect, useState } from 'react';
import { api, post, type Collision, type Team, type TeamAgent } from './api';

const LIVE = new Set(['working', 'starting', 'waiting', 'blocked']);

function AgentCard({ team, a, refresh }: { team: Team; a: TeamAgent; refresh: () => void }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const act = async (path: string, body: Record<string, unknown>, done?: () => void) => {
    try { await post(`/teams/${team.id}/${path}`, body); done?.(); setNote(''); refresh(); } catch (e) { setNote((e as Error).message); }
  };
  return (
    <div className="card agent-card" data-testid="agent-card">
      <div className="row"><b>{a.id}</b><span className={`state ${LIVE.has(a.state) ? 'active' : ''}`}>{a.state}</span>{a.resumed > 0 && <span className="dim">resumed {a.resumed}×</span>}</div>
      <div>{a.title}</div>
      {a.after.length > 0 && <div className="dim">after {a.after.join(', ')}</div>}
      {a.lastReply && <blockquote className="reply">{a.lastReply}</blockquote>}
      <div className="dim">{a.lands.length} landed</div>
      <div className="row">
        <input aria-label="message to agent" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message this agent" />
        <button disabled={!text.trim()} onClick={() => act('message', { agent: a.id, text: text.trim() }, () => setText(''))}>Send</button>
      </div>
      <div className="row">
        <button onClick={() => act('stop-agent', { agent: a.id })}>Stop agent</button>
        <button onClick={() => act('restart-agent', { agent: a.id })}>Restart</button>
      </div>
      {note && <p className="bad">{note}</p>}
    </div>
  );
}

export function Teams() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [cols, setCols] = useState<Collision[]>([]);
  const refresh = () => {
    api<Team[]>('/teams').then(setTeams).catch(() => setTeams((t) => t ?? []));
    api<Collision[]>('/collisions').then(setCols).catch(() => {});
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, []);
  if (!teams) return <p className="pad dim">loading…</p>;
  const current = teams.find((t) => t.state === 'running') ?? teams[0];
  if (!current) return <p className="pad dim">No team running. Start one from Home or Plans.</p>;
  return (
    <div className="pad">
      <div className="row">
        <h2>{current.plan}</h2><span className="state">{current.state}</span>
        {current.state === 'running' && <button onClick={() => post(`/teams/${current.id}/stop`).then(refresh).catch(() => {})}>Stop team</button>}
      </div>
      <p className="dim">{current.goal}</p>
      <div className="steps">{current.agents.map((a) => <AgentCard key={a.id} team={current} a={a} refresh={refresh} />)}</div>
      <h3>Collisions</h3>
      {!cols.length ? <p className="dim">No collisions so far.</p>
        : <ul className="feed">{cols.slice(0, 20).map((c) => <li key={c.id}><b>{c.kind}</b> {c.region.join(', ')} <span className="dim">{c.outcome} · {c.detail}</span></li>)}</ul>}
    </div>
  );
}
