import { useEffect, useState } from 'react';
import { api, couldNot, type Collision, type Team } from './api';
import { agentColor } from './stream';
import { ago, landText } from './explain';
import { Bot, Problem } from './ui';

type K = 'wait' | 'notice' | 'back' | 'land';
const CAT: Record<string, K> = { lock_denied: 'wait', lock_wait: 'wait', caller_warning: 'notice', landing_rejected: 'back', merge_conflict: 'back', out_of_scope: 'back', divergence: 'back', stale_version: 'back' };
const KC: Record<K, string> = { wait: 'var(--wait)', notice: '#5B8FC7', back: 'var(--bad)', land: 'var(--good)' };
const KB: Record<K, [string, string]> = { wait: ['var(--wait-soft)', 'var(--wait-d)'], notice: ['var(--blue-soft)', 'var(--blue-d)'], back: ['var(--bad-soft)', 'var(--bad)'], land: ['var(--good-soft)', 'var(--good)'] };
const KL: Record<K, string> = { wait: 'Made to wait', notice: 'Warning', back: 'Sent back', land: 'Landed' };
const WHY: Record<string, string> = {
  lock_denied: 'Another agent was already editing this function, so Loom made this one wait instead of letting both overwrite each other.',
  lock_wait: 'Another agent was already editing this function, so Loom made this one wait instead of letting both overwrite each other.',
  caller_warning: 'This agent changed a function other code depends on. Loom told the owners of those callers before the change could land.',
  landing_rejected: 'The change failed Loom’s checks on the code that depends on it, so it was sent back to be fixed before landing.',
  merge_conflict: 'Two changes touched the same code. Loom stopped the merge and sent it back.',
  out_of_scope: 'The agent edited something outside its task. Loom sent it back.',
  divergence: 'The agent’s copy of the code had drifted from what others landed. Loom sent it back.',
  stale_version: 'The agent was working from an out-of-date version of the code. Loom sent it back.',
};

interface Ev { id: string; k: K; agent: string; title: string; why: string; region: string | null; at: number | null }

export function Collisions({ go, newTeam }: { go?: (v: 'functions' | 'home') => void; newTeam?: () => void } = {}) {
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<Collision[] | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const [f, setF] = useState<'all' | K>('all');
  useEffect(() => {
    const pull = () => {
      api<Collision[]>('/collisions').then(setRows).catch((e) => setErr(couldNot('collisions', e)));
      api<Team[]>('/teams').then((t) => setTeam(t.find((x) => x.state === 'running') ?? t[0] ?? null)).catch(() => {});
    };
    pull(); const i = setInterval(pull, 4000); return () => clearInterval(i);
  }, []);
  if (err) return <Problem msg={err} />;
  if (!rows) return <p className="dim">loading…</p>;

  const evs: Ev[] = rows.map((c) => {
    const k = CAT[c.kind] ?? 'back';
    const agent = (c.parties[0] as { agent?: string } | undefined)?.agent ?? 'agent';
    const fn = c.region[0]?.split('::')[1];
    const title = k === 'wait' ? `${team?.agents.find((a) => a.id === agent)?.title ?? agent} had to wait${fn ? ` for ${fn}()` : ''}`
      : k === 'notice' ? `${agent} was warned about ${fn ? `${fn}()` : 'a change'}` : `${agent}’s landing was sent back${fn ? ` (${fn}())` : ''}`;
    return { id: c.id, k, agent, title, why: k === 'back' ? `${WHY[c.kind] ?? ''} ${landText(c.detail?.replace(/^\w+: /, '').split(' — ')[0] ?? '')}`.trim() : WHY[c.kind] ?? c.kind.replace(/_/g, ' '), region: c.region[0] ?? null, at: c.at };
  });
  for (const a of team?.agents ?? []) if (a.state === 'landed') evs.unshift({ id: `land-${a.id}`, k: 'land', agent: a.id, title: `${a.title} landed`, why: a.lands.length > 1 ? `It was sent back ${a.lands.length - 1}× (${[...new Set(a.lands.slice(0, -1))].map(landText).join('; ')}), fixed it, and then passed Loom’s checks and was merged.` : 'Its change passed Loom’s checks first time and was merged.', region: null, at: null });
  const shown = evs.filter((e) => f === 'all' || e.k === f);
  const chip = (k: 'all' | K, label: string) => <button key={k} className={`chip${f === k ? ' on' : ''}`} onClick={() => setF(k)}>{label}</button>;

  if (!evs.length) return (
    <div className="page"><div className="card bigempty"><Bot color="#9A988F" size={56} mode="waiting" />
      <h3>Nothing to show yet</h3><p className="dim">Loom records every time it changes what an agent does: a wait, a warning, a landing it refuses.</p>
      {newTeam && <button className="btn or" onClick={newTeam}>Start a team</button>}</div></div>);
  return (
    <div className="page">
      <div className="chips" style={{ marginBottom: 12 }}>{chip('all', 'All')}{chip('wait', 'Made to wait')}{chip('notice', 'Warnings')}{chip('back', 'Sent back')}{chip('land', 'Landed')}</div>
      {!shown.length && <p className="dim">Nothing in this filter.</p>}
      {shown.map((e, j) => (
        <div key={e.id} className="card lc" style={{ ['--i' as string]: Math.min(j, 8), ['--kc' as string]: KC[e.k], marginBottom: 10 } as React.CSSProperties}>
          <span className="num">#{String(shown.length - j).padStart(2, '0')}</span>
          <Bot color={agentColor(e.agent)} size={40} mode={e.k === 'back' ? 'sentback' : e.k === 'land' ? 'landed' : e.k === 'wait' ? 'waiting' : 'working'} />
          <div><div className="t"><span className="kb" style={{ background: KB[e.k][0], color: KB[e.k][1] }}>{KL[e.k]}</span>{e.title}{e.at ? <span className="dim" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>{ago(e.at)}</span> : null}</div><p>{e.why}</p></div>
          {e.region && go ? <a className="link" onClick={() => go('functions')}>See {e.region.split('::')[1] ?? e.region.split('::')[0]}() in Code Map →</a> : <span />}
        </div>))}
    </div>
  );
}
