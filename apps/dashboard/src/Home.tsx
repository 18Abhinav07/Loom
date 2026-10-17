import { useEffect, useState } from 'react';
import { api, type Team } from './api';
import { RunStage } from './Demo';
import { Bot } from './ui';

type Go = (view: string, say?: string) => void;
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/** What the Lead is asked when someone presses Plan: the StaleBench run, three Haiku agents each side. */
export const STALEBENCH_ASK = 'Run the StaleBench workflow on this repo: check plan django-stalebench, then start it twice with model haiku: once with blind:true (three agents without Loom) and once normally (three agents with Loom). Report when both finish.';

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
  const verdict = (t: Team | null) => !t ? 'not started' : t.state === 'running' ? 'running' : t.result ? (t.result.pass ? 'tests pass' : 'tests fail') : t.state;
  return (
    <section className="screen on">
      <div className="hs"><div className="hgrid">
        <div className="hcopy">
          <span className="h5chip reveal"><span className="ldot" /><b>StaleBench</b> · Django · 3 Claude Haiku agents</span>
          <h1 className="reveal" style={{ '--i': 1 } as never}>Three agents, one function. <em>Without Loom they collide.</em></h1>
          <p className="reveal" style={{ '--i': 2 } as never}>Same task, same model, same repo. Here three agents work without Loom. On the Team page the same three work with Loom, sharing a FalkorDB graph that tells each one when code it depends on changes.</p>
          <div className="hcta reveal" style={{ '--i': 3 } as never}>
            <button className="btn or lg" onClick={plan}>Plan the run →</button>
            <button className="btn ghost lg" onClick={() => go('teams')}>Team (with Loom)</button>
            <button className="btn ghost lg" onClick={() => go('bench')}>Benchmark</button>
          </div>
          <p className="hnote reveal" style={{ '--i': 4 } as never}>{base(location.search ? new URLSearchParams(location.search).get('cwd') ?? '' : '') || 'this repo'} · without Loom: <b>{verdict(blind)}</b> · with Loom: <b>{verdict(loom)}</b></p>
        </div>
        <div className="card h5stage reveal" style={{ '--i': 2 } as never}>
          {blind ? <RunStage run={blind.id} label="without Loom · live" pollMs={1500} />
            : <div className="floor" style={{ height: 380 }}><div className="empty" style={{ paddingTop: 70 }}><Bot color="#9A988F" size={56} mode="m-back" /><p style={{ marginTop: 10 }}>No run yet.</p><p className="dim">Press Plan the run. The Lead starts three agents without Loom and three with it.</p></div></div>}
        </div>
      </div></div>
    </section>
  );
}
