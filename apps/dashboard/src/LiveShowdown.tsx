// The live head-to-head: the same three Claude agents on the same small repo, once without Loom and once with it. Nothing is recorded.
import { useEffect, useState } from 'react';
import { post, type Team } from './api';
import { RunStage } from './Demo';
import { getJson, agentColor, useRun } from './stream';
import { Bot } from './ui';

const MODELS = [['haiku', 'Claude Haiku (fastest, cheapest)'], ['sonnet', 'Claude Sonnet'], ['opus', 'Claude Opus']] as const;
const STATE_WORD: Record<string, string> = { pending: 'waiting for its turn', running: 'working', idle: 'finishing up', landed: 'landed', failed: 'failed', blocked: 'blocked', stopped: 'stopped' };

function Verdict({ t }: { t: Team | null }) {
  if (!t) return null;
  if (t.state === 'running') return <div className="sdn dim">running…</div>;
  const r = t.result;
  return (
    <div className={`verdict ${r?.pass ? 'ok' : 'bad'}`} data-testid="verdict">
      <b>{r ? (r.pass ? 'Tests pass' : 'Tests fail') : 'Finished'}</b>
      {r && !r.pass && <pre>{r.out.split('\n').slice(-8).join('\n')}</pre>}
    </div>
  );
}

function Agents({ t }: { t: Team | null }) {
  return (
    <div className="lagents">
      {(t?.agents ?? []).map((a) => (
        <div key={a.id} className="lagent">
          <Bot color={agentColor(a.id)} size={38} mode={a.state === 'running' ? 'm-work' : a.state === 'pending' ? 'm-sleep' : ''} />
          <b>{a.id}</b><span className="dim">{a.title}</span>
          <span className="chipr" style={{ marginLeft: 'auto' }}>{STATE_WORD[a.state] ?? a.state}{a.resumed ? ` · sent back ${a.resumed}×` : ''}</span>
        </div>))}
    </div>
  );
}

function Feed({ run }: { run: string | null }) {
  const { snap } = useRun(run, 1500);
  const short = (q: string) => q.split('::')[1] ?? q;
  const rows = [
    ...snap.notices.slice(-8).map((n) => ({ who: n.agent, what: `${n.status === 'pending' ? 'will be told' : n.status}`, text: n.text.split('\n')[0].replace(/^\[loom\] /, '') })),
    ...snap.leases.map((l) => ({ who: l.agent, what: `holds the ${l.mode} lock on`, text: short(l.symbol) })),
  ];
  return (
    <div className="lfeed" data-testid="feed">
      <div className="h">What Loom is doing</div>
      {rows.length === 0 && <p className="dim">Nothing yet. Locks and notices appear here as the agents start.</p>}
      {rows.map((e, i) => (<div key={i} className="lrow"><b style={{ color: agentColor(e.who) }}>{e.who}</b> {e.what} <span className="dim">{e.text}</span></div>))}
    </div>
  );
}

export function LiveShowdown() {
  const [model, setModel] = useState<string>('haiku');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const KEY = 'loom.live.ids';
  const [ids, setIds] = useState<{ blind: string; loom: string; cwd: string } | null>(() => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } });
  useEffect(() => { try { if (ids) localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* per-viewer convenience only */ } }, [ids]);
  const [teams, setTeams] = useState<{ blind: Team | null; loom: Team | null }>({ blind: null, loom: null });
  useEffect(() => {
    if (!ids) return;
    let alive = true;
    const tick = async () => {
      const get = (id: string) => getJson<Team>(`/teams/${id}?cwd=${encodeURIComponent(ids.cwd)}`).catch(() => null);
      const [blind, loom] = await Promise.all([get(ids.blind), get(ids.loom)]);
      if (alive) setTeams({ blind, loom });
    };
    void tick(); const h = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(h); };
  }, [ids]);
  const running = busy || teams.blind?.state === 'running' || teams.loom?.state === 'running';
  const go = async () => {
    setBusy(true); setErr(''); setTeams({ blind: null, loom: null }); setIds(null);
    try {
      const sb = await post<{ cwd: string; plan: string }>('/demo/sandbox');
      const [blind, loom] = await Promise.all([true, false].map((b) => post<{ team: Team }>('/teams', { cwd: sb.cwd, plan: sb.plan, model, blind: b })));
      setIds({ blind: blind.team.id, loom: loom.team.id, cwd: sb.cwd });
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };
  return (
    <div className="card showdown" data-testid="live-showdown">
      <h3>Run it live: 3 agents without Loom, 3 with it</h3>
      <p className="dim">Starts real Claude agents on a small Python repo (<code>~/.loom/demo-repo</code>). Both teams get the same three tasks, and they touch each other's code. Without Loom the agents cannot see one another. With Loom you watch the locks, the notices and the code graph. When both finish, the repo's tests decide. This uses your Claude plan.</p>
      <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap', margin: '14px 0' }}>
        <label className="dim" htmlFor="live-model">Model</label>
        <select id="live-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={running}>{MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button className="btn or" onClick={go} disabled={running}>{running ? 'Running…' : ids ? 'Run again' : 'Run 3 agents with and without Loom'}</button>
        {err && <span className="bad">{err}</span>}
      </div>
      {ids && (
        <div className="live2">
          <div className="sdcol"><div className="sdh"><b>Without Loom</b><span className="dim">blind agents, no coordination</span></div><Agents t={teams.blind} /><Verdict t={teams.blind} /></div>
          <div className="sdcol loom"><div className="sdh"><b>With Loom</b><span className="dim">locks, notices, tests before landing</span></div><Agents t={teams.loom} /><Verdict t={teams.loom} /></div>
        </div>)}
      {ids && <div className="card h5stage" style={{ marginTop: 16 }}><RunStage run={ids.loom} label="live · with Loom" pollMs={1500} /><Feed run={ids.loom} /></div>}
    </div>
  );
}
