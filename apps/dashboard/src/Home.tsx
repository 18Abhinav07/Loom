import { useEffect, useState } from 'react';
import { api, repoCwd, type PlanRow, type Team } from './api';
import { agentColor } from './stream';
import { DemoStage, LiveStage, Showdown } from './Demo';
import { ago, landText, startedBy } from './explain';
import { Bot, NO_REPO } from './ui';

type Go = (view: string, say?: string) => void;
const load = <T,>(path: string, set: (v: T) => void, fail?: (m: string) => void) => { api<T>(path).then(set).catch((e) => fail?.(String(e?.message ?? e))); };
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

export function Home({ go, demo = false }: { go: Go; demo?: boolean }) {
  const [cwd, setCwd] = useState('');
  const [last, setLast] = useState<Team | null>(null);
  const [repo, setRepo] = useState<'checking' | 'ready' | 'none'>('checking');
  useEffect(() => {
    repoCwd().then(setCwd);
    load<Team[]>('/teams', (t) => setLast([...t].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null));
    load<PlanRow[]>('/plans', () => setRepo('ready'), (m) => { if (NO_REPO.test(m)) setRepo('none'); });
  }, []);
  return (
    <section className="screen on">
      <div className="hs">
        <div className="hgrid">
          <div className="hcopy">
            {demo ? <span className="h5chip reveal"><span className="ldot" /><b>Demo</b> · a recorded run of 3 Claude agents on a real open-source Python codebase</span>
              : repo === 'none'
              ? <span className="h5chip reveal"><b>Not set up</b> · {base(cwd) || 'this folder'} · run <code>loom init</code></span>
              : <span className="h5chip reveal"><span className="ldot" /><b>{repo === 'ready' ? 'Ready' : 'Checking'}</b> · {base(cwd) || 'this repo'}</span>}
            <h1 className="reveal" style={{ '--i': 1 } as never}>Run a team of coding agents on one repo. <em>Nothing breaks.</em></h1>
            <p className="reveal" style={{ '--i': 2 } as never}>Describe the work. The Lead splits it into tasks and starts one Claude agent per task. Loom makes them take turns on the same function, tells them when code they use changes, and only lets in work that still runs.</p>
            <div className="row reveal" style={{ '--i': 3, gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 26 } as never}><button className="btn or" onClick={() => go('lead')}>Plan with the Lead →</button><span className="hint">or <code>loom lead</code> in the terminal</span><a className="hint" href="?view=bench" onClick={(e) => { e.preventDefault(); go('bench'); }}>See the benchmark →</a></div>
          </div>

          <div className="card h5stage reveal" style={{ '--i': 2 } as never}>
            {demo ? <DemoStage /> : <LiveStage idle={<>
              <div className="bar"><span><b>0</b>agents</span><span><b>0</b>locked</span><span><b>0</b>waiting</span><span><b>{last ? last.agents.filter((a) => a.lands.includes('landed')).length : 0}</b>landed</span><span className="sp" /><span>{last ? 'last team · this repo' : 'live · this repo'}</span></div>
              {last ? (
                <div className="floor" style={{ height: 'auto', padding: '18px 20px' }} data-testid="last-team">
                  <div className="h">{last.plan} · {last.state} {ago(last.startedAt)}</div>
                  <p className="dim" style={{ margin: '2px 0 12px' }}>{startedBy(last)}</p>
                  {last.agents.map((a) => (
                    <div key={a.id} className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
                      <Bot color={agentColor(a.id)} size={34} /><b>{a.id}</b><span className="dim">{a.title}</span>
                      <span className="sp" /><span className="chipr" title={a.lands.map(landText).join(' ')}>{a.lands.includes('landed') ? `landed${a.lands.length > 1 ? ` after ${a.lands.length - 1} sent back` : ''}` : (a.lands.at(-1) ?? a.state).replace(/_/g, ' ')}</span>
                    </div>))}
                  {last.landed && <p style={{ margin: '12px 0 0' }}>Merge it: <code>git merge {last.landed}</code></p>}
                </div>
              ) : (
                <div className="floor" style={{ height: 300 }}><div className="empty" style={{ paddingTop: 40 }}><Bot color="#9A988F" size={56} mode="m-back" /><p style={{ marginTop: 10 }}>No agents working yet.</p><p className="dim">Start Claude in this repo, or start a team. Each agent shows up here the moment it begins.</p></div></div>)}
              <button className="btn ghost sm" style={{ margin: '10px 14px' }} onClick={() => go('teams')}>Open Team →</button>
            </>} />}
          </div>
        </div>
        {demo && <Showdown />}
      </div>

    </section>
  );
}
