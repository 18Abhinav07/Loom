import { useEffect, useState } from 'react';
import { api, post, type Compare, type PlanRow, type Team } from './api';

type Go = (view: string) => void;
const load = <T,>(path: string, set: (v: T) => void) => { api<T>(path).then(set).catch(() => {}); };

export function Home({ go }: { go: Go }) {
  const [cmp, setCmp] = useState<Compare | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [plan, setPlan] = useState('');
  const [brief, setBrief] = useState('');
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    load<Compare>('/bench/compare', setCmp);
    load<PlanRow[]>('/plans', (p) => { setPlans(p); setPlan((x) => x || p[0]?.slug || ''); });
    load<{ text: string }>('/brief', (b) => setBrief(b.text));
    const poll = () => load<Team[]>('/teams', setTeams);
    poll(); const t = setInterval(poll, 4000); return () => clearInterval(t);
  }, []);
  const e5 = cmp ? cmp.e5.reduce((a, s) => ({ l: a.l + s.loom.all_pass, b: a.b + s.blind.all_pass, n: a.n + s.loom.n }), { l: 0, b: 0, n: 0 }) : null;
  const start = async () => {
    setMsg('');
    try { await post('/teams', { plan }); go('teams'); } catch (e) { setMsg((e as Error).message); }
  };
  const copy = () => { navigator.clipboard?.writeText('loom lead').catch(() => {}); setCopied(true); };
  const running = (teams ?? []).filter((t) => t.state !== 'done' && t.state !== 'stopped');
  return (
    <div className="home pad">
      <section className="hero">
        <h1>Parallel AI agents break each other's code. Loom tells them in time.</h1>
        <p>Loom is a shared memory and lock graph for every Claude session and agent on a repo.</p>
      </section>

      <section className="how">
        <h2>How it works</h2>
        <div className="steps">
          <div className="step"><b>1 · Plan</b><span>A team plan, checked before anyone starts.</span></div>
          <div className="step"><b>2 · Team</b><span>One agent per task, with locks and landing checks.</span></div>
          <div className="step"><b>3 · Memory</b><span>Every session, decision and collision in the graph, shared through git.</span></div>
        </div>
      </section>

      {cmp && e5 && (
        <section className="proof" onClick={() => go('bench')} role="link" tabIndex={0}>
          <div className="stat bad">Without Loom {cmp.e1.blind.broke}/{cmp.e1.blind.n} broke</div>
          <div className="stat good">With Loom {cmp.e1.loom.broke}/{cmp.e1.loom.n}</div>
          <div className="stat">Real agents: Loom {e5.l}/{e5.n} · blind {e5.b}/{e5.n}</div>
          <a href="?view=bench" onClick={(e) => { e.preventDefault(); e.stopPropagation(); go('bench'); }}>See the benchmark →</a>
        </section>
      )}

      <section className="start">
        <div className="card">
          <h3>Start a lead</h3>
          <p className="dim">A Claude session that plans and runs teams for you.</p>
          <code>loom lead</code>
          <div className="row"><button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button><button onClick={() => go('lead')}>Open Lead</button></div>
        </div>
        <div className="card">
          <h3>Start a team</h3>
          <select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="plan">
            {!plans.length && <option value="">No plans yet</option>}
            {plans.map((p) => <option key={p.slug} value={p.slug}>{p.slug}</option>)}
          </select>
          <div className="row"><button disabled={!plan} onClick={start}>Start</button></div>
          {msg && <p className="bad">{msg}</p>}
        </div>
      </section>

      <section>
        <h2>Briefing</h2>
        <pre className="brief">{brief || 'Nothing yet. Briefings appear once sessions have worked in this repo.'}</pre>
      </section>

      <section>
        <h2>Live now</h2>
        {!running.length ? <p className="dim">No team running.</p>
          : running.map((t) => <div key={t.id} className="row"><b>{t.plan}</b><span className="dim">{t.agents.length} agents · {t.state}</span><button onClick={() => go('teams')}>Open</button></div>)}
      </section>
    </div>
  );
}
