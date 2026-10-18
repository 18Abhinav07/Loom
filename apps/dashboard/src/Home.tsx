import { useEffect, useState } from 'react';
import { api, type Team } from './api';
import { agentColor } from './stream';
import { Bot } from './ui';
import { landText } from './explain';

type Go = (view: string, say?: string) => void;

/** What the Lead is asked when someone presses Plan: the StaleBench run, three Haiku agents each side. */
export const STALEBENCH_ASK = 'Run the StaleBench workflow on this repo: check plan django-stalebench, then start it twice with model haiku: once with blind:true (three agents without Loom) and once normally (three agents with Loom). Report when both finish.';

const AGENT_STATE: Record<string, string> = { running: 'working', landed: 'landed', failed: 'failed', stopped: 'stopped', waiting: 'waiting', queued: 'queued' };

/** One team's three agents with what each is doing, and the test verdict once the team is done. Same view for the blind and the Loom team. */
function TeamPanel({ title, t }: { title: string; t: Team | null }) {
  return (
    <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line, #eee)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <b>{title}</b>
        <span className="dim">{!t ? 'not started' : t.state === 'running' ? 'running' : t.result ? (t.result.pass ? 'done · tests pass' : 'done · tests fail') : t.state === 'done' ? 'done · no test verdict' : t.state}</span>
      </div>
      {!t ? <p className="dim">Press Plan the run.</p> : t.agents.map((a) => (
        <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' }}>
          <Bot color={agentColor(a.id)} size={32} mode={a.state === 'running' ? 'm-work' : a.state === 'waiting' ? 'm-sleep' : ''} />
          <div style={{ minWidth: 0 }}>
            <b style={{ color: agentColor(a.id) }}>{a.id}</b> <span className="dim">{a.title} · {AGENT_STATE[a.state] ?? a.state}</span>
            {a.lastReply && <div className="dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>{a.lastReply}</div>}
          </div>
        </div>))}
      {t?.result && !t.result.pass && <pre className="dim" style={{ whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 90, overflow: 'auto' }}>{t.result.out}</pre>}
    </div>
  );
}

/** The full account of one team: every agent's own last report, how often it was sent back, and the test output in full. */
function TeamDetail({ title, note, t }: { title: string; note: string; t: Team | null }) {
  return (
    <div className="card sp" style={{ flex: '1 1 420px', minWidth: 0 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      <p className="dim" style={{ margin: '4px 0 12px' }}>{note}</p>
      {!t ? <p className="dim">Not started. Press Plan the run.</p> : <>
        {t.agents.map((a) => (
          <details key={a.id} style={{ padding: '8px 0', borderTop: '1px solid var(--line, #eee)' }} open={a.state === 'failed'}>
            <summary style={{ cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center' }}>
              <Bot color={agentColor(a.id)} size={26} mode={a.state === 'running' ? 'm-work' : ''} />
              <b style={{ color: agentColor(a.id) }}>{a.id}</b><span>{a.title}</span><span className="dim">· {AGENT_STATE[a.state] ?? a.state}{a.lands.length > 1 ? ` · sent back ${a.lands.length - 1}×` : ''}</span>
            </summary>
            {a.lands.length > 0 && <p className="dim" style={{ margin: '6px 0 0' }}>Landing checks: {a.lands.map(landText).join(' → ')}</p>}
            <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{a.lastReply ?? 'No report yet.'}</p>
          </details>))}
        <div style={{ borderTop: '1px solid var(--line, #eee)', paddingTop: 10 }}>
          {t.state === 'running' ? <span className="dim">Running. The test verdict appears here when all three are done.</span>
            : !t.result ? <span className="dim">Finished with no test verdict.</span>
            : <><b style={{ color: t.result.pass ? 'var(--good)' : 'var(--bad)' }}>Tests on the shared branch: {t.result.pass ? 'pass' : 'fail'}</b>
              {!t.result.pass && <pre className="dim" style={{ whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 220, overflow: 'auto', marginTop: 6 }}>{t.result.out}</pre>}</>}
        </div>
      </>}
    </div>
  );
}

export function Home({ go, plan }: { go: Go; plan: () => void }) {
  const [blind, setBlind] = useState<Team | null>(null);
  const [loom, setLoom] = useState<Team | null>(null);
  useEffect(() => {
    const poll = () => api<Team[]>('/teams').then((ts) => {
      const newest = (b: boolean) => [...ts].filter((t) => !!t.blind === b).sort((x, y) => y.startedAt - x.startedAt)[0] ?? null;
      setBlind(newest(true)); setLoom(newest(false));
    }).catch(() => {});
    poll(); const t = setInterval(poll, 2500); return () => clearInterval(t);
  }, []);
  const stat = (t: Team | null): [string, string] => !t ? ['idle', 'Not started'] : t.state === 'running' ? ['run', 'Running'] : t.result ? (t.result.pass ? ['ok', 'Tests pass'] : ['bad', 'Tests fail']) : ['idle', t.state];
  const Card = ({ title, sub, t, onClick }: { title: string; sub: string; t: Team | null; onClick?: () => void }) => {
    const [k, text] = stat(t);
    return <button className="stc" onClick={onClick}><span className="dim">{title}</span><b className={`stv ${k}`}><i className="sd" />{text}</b><span className="dim">{t ? sub : 'Press Plan to start'}</span></button>;
  };
  return (
    <section className="screen on">
      <div className="hs"><div className="hgrid">
        <div className="hcopy">
          <span className="h5chip reveal"><span className="ldot" /><b>StaleBench</b> · Django · 3 Claude Haiku agents</span>
          <h1 className="reveal" style={{ '--i': 1 } as never}>Three agents, one function. <em>Without Loom they collide.</em></h1>
          <p className="reveal" style={{ '--i': 2 } as never}>On the right, both teams of three agents: what each is doing, and the test result when they finish. The Team page shows the Loom team's graph and messages.</p>
          <div className="hcta reveal" style={{ '--i': 3 } as never}>
            <button className="btn or lg" onClick={plan}>Plan the run →</button>
            <button className="btn ghost lg" onClick={() => go('bench')}>Benchmark</button>
          </div>
          <div className="stcs reveal" style={{ '--i': 4 } as never}>
            <Card title="Without Loom" sub="shown on the stage" t={blind} />
            <Card title="With Loom" sub="open the Team page" t={loom} onClick={() => go('teams')} />
          </div>
        </div>
        <div className="card h5stage reveal" style={{ '--i': 2 } as never}>
          <TeamPanel title="Without Loom" t={blind} />
          <TeamPanel title="With Loom" t={loom} />
        </div>
      </div>
        <div className="hgrid" style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 28 }}>
          <TeamDetail title="Without Loom: what the blind agents did" note="Three agents on the same code. No hooks, no leases, no messages: they cannot see each other." t={blind} />
        </div></div>
    </section>
  );
}
