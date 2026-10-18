import { useEffect, useState } from 'react';
import { api, type Team } from './api';

type Go = (view: string, say?: string) => void;

/** What the Lead is asked when someone presses Plan: the StaleBench run, four Haiku agents each side. */
export const STALEBENCH_ASK = 'Run the StaleBench workflow on this repo: check plan django-stalebench, then start it twice with model haiku: once with blind:true (four agents without Loom) and once normally (four agents with Loom). Report when both finish.';

const status = (t: Team | null): [string, string] => !t ? ['idle', 'Starts when you press Plan'] : t.state === 'running' ? ['run', 'Running now'] : t.result ? (t.result.pass ? ['ok', 'Finished · tests pass'] : ['bad', 'Finished · tests fail']) : ['idle', t.state === 'done' ? 'Finished' : t.state];

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
  const Side = ({ title, text, t, to, idle }: { title: string; text: string; t: Team | null; to: string; idle: string }) => {
    const [k, label] = status(t);
    return (
      <button className={`side2 ${t ? 'on' : 'off'}`} disabled={!t} onClick={() => go(to)}>
        <span className="s2t">{title}</span>
        <span className="s2d">{text}</span>
        <span className={`s2s ${k}`}><i className="sd" />{t ? label : idle}</span>
        <span className="s2go">{t ? 'Open →' : ''}</span>
      </button>);
  };
  return (
    <section className="screen on hero2">
      <svg className="threads" viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((i) => <path key={i} d={`M-50 ${80 + i * 90} C 250 ${20 + i * 90}, 450 ${200 + i * 70}, 700 ${100 + i * 85} S 1100 ${60 + i * 100}, 1250 ${140 + i * 80}`} style={{ animationDelay: `${i * -2.4}s` }} />)}
      </svg>
      <div className="blob b1" /><div className="blob b2" />
      <div className="h2c">
        <img className="hlogo reveal" src="/logo.svg" width="72" height="72" alt="Loom" />
        <span className="h5chip reveal"><span className="ldot" /><b>StaleBench</b> · Django · 4 Claude Haiku agents each side</span>
        <h1 className="reveal" style={{ '--i': 1 } as never}>Four agents, one function.<br /><em>Without Loom they collide.</em></h1>
        <p className="reveal" style={{ '--i': 2 } as never}>The same four tasks, run twice: once by agents that cannot see each other, once by agents sharing Loom's memory.</p>
        <div className="reveal" style={{ '--i': 3 } as never}><button className="btn or xl pulse" onClick={plan}>Plan the run →</button></div>
        <div className="sides reveal" style={{ '--i': 4 } as never}>
          <Side title="Without Loom" text="Blind agents: no locks, no warnings, no messages. They edit the same code and find out at the end." t={blind} to="blind" idle="Opens when the run starts" />
          <Side title="With Loom" text="The same agents sharing a live code graph: locks, warnings and send-backs before anything breaks." t={loom} to="teams" idle="Opens when the run starts" />
        </div>
      </div>
    </section>
  );
}
