import { useEffect, useState } from 'react';
import { api, post, repoCwd, type Compare, type PlanRow, type Team } from './api';
import { agentColor } from './stream';
import { Bot, NO_REPO } from './ui';

type Go = (view: string, say?: string) => void;
const load = <T,>(path: string, set: (v: T) => void, fail?: (m: string) => void) => { api<T>(path).then(set).catch((e) => fail?.(String(e?.message ?? e))); };
const EXAMPLES = ['Add type hints to the utils package', 'Make slugify() strict about unicode', 'Split the largest module into smaller ones'];
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

const FEATURES = [
  ['Takes turns per function', 'An agent locks only the function it edits. Two agents can work in the same file; one waits only when both need the same function.', 'Without it: both edit at once, merge conflict.'],
  ['Tells agents what changed', 'When an agent changes how a function is called, every agent whose code calls it hears about it right away.', "Without it: each agent's work runs alone, then breaks once merged."],
  ['Lets in only work that still runs', 'Finished work lands on the shared branch only if it merges, every call to what it changed still fits, and the tests pass. If not, it goes back to the agent with the exact reason.', 'Without it: broken code reaches the branch.'],
  ['Lets you watch and steer', 'See who is editing what and who is waiting. Open any agent to read what it did, message it, or stop it.', 'Without it: N terminals, no idea who touched what.'],
];
const PIPE = [
  ['1 · Map', '`loom init` reads the repo into a graph: every file, function, and who calls whom.', 'tree-sitter → FalkorDB'],
  ['2 · Lock', 'Before any agent edit goes through, Loom checks which function it touches and who holds it. Busy means wait.', 'hook before every edit'],
  ['3 · Tell', "When a function's signature changes, Loom messages the agents whose code calls it.", 'call graph lookup'],
  ['4 · Land', 'One at a time: merge onto the shared branch, check every call fits, run the tests. Fail, and the work goes back with the reason.', 'merge queue'],
  ['5 · Wake', 'A waiting agent resumes the moment what it needs lands, with that work already in its copy.', 'resume the session'],
];
const USE = [['1 · Set up once', 'Maps the repo and starts Loom.', 'loom init'], ['2 · Start a team', "Describe the work; review the Lead's tasks.", 'loom new "…"'], ['3 · Watch or join in', 'Message any agent, or open its session.', 'loom lead'], ['4 · Merge the result', 'Everything that landed is on one branch.', 'git merge loom/<run>/landed']];

export function Home({ go }: { go: Go }) {
  const [cmp, setCmp] = useState<Compare | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [plan, setPlan] = useState('');
  const [brief, setBrief] = useState('');
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [msg, setMsg] = useState('');
  const [ask, setAsk] = useState('');
  const [cwd, setCwd] = useState('');
  const [repo, setRepo] = useState<'checking' | 'ready' | 'none'>('checking');
  useEffect(() => {
    repoCwd().then(setCwd);
    load<Compare>('/bench/compare', setCmp);
    load<PlanRow[]>('/plans', (p) => { setRepo('ready'); setPlans(p); setPlan((x) => x || p[0]?.slug || ''); }, (m) => { if (NO_REPO.test(m)) setRepo('none'); });
    load<{ text: string }>('/brief', (b) => { setRepo('ready'); setBrief(b.text); });
    const poll = () => load<Team[]>('/teams', setTeams);
    poll(); const t = setInterval(poll, 4000); return () => clearInterval(t);
  }, []);
  const e5 = cmp?.e5?.length ? cmp.e5.reduce((a, s) => ({ l: a.l + s.loom.all_pass, b: a.b + s.blind.all_pass, n: a.n + s.loom.n }), { l: 0, b: 0, n: 0 }) : null;
  const e1 = cmp?.e1?.blind && cmp.e1.loom ? cmp.e1 : null;
  const start = async () => {
    setMsg('');
    try { await post('/teams', { plan }); go('teams'); } catch (e) { setMsg((e as Error).message); }
  };
  const running = (teams ?? []).filter((t) => t.state !== 'done' && t.state !== 'stopped');
  const live = running[0];
  const count = (s: string[]) => live?.agents.filter((a) => s.includes(a.state)).length ?? 0;
  return (
    <section className="screen on">
      <div className="hs">
        <div className="hgrid">
          <div className="hcopy">
            {repo === 'none'
              ? <span className="h5chip reveal"><b>Not set up</b> · {base(cwd) || 'this folder'} · run <code>loom init</code></span>
              : <span className="h5chip reveal"><span className="ldot" /><b>{repo === 'ready' ? 'Ready' : 'Checking'}</b> · {base(cwd) || 'this repo'}</span>}
            <h1 className="reveal" style={{ '--i': 1 } as never}>Run a team of coding agents on one repo. <em>Nothing breaks.</em></h1>
            <p className="reveal" style={{ '--i': 2 } as never}>Describe the work. The Lead splits it into tasks and starts one Claude agent per task. Loom makes them take turns on the same function, tells them when code they use changes, and only lets in work that still runs.</p>
            <div className="card ask reveal" style={{ '--i': 3 } as never}>
              <textarea id="askbox" aria-label="what to build" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. Make slugify() strict about unicode, and render admin change messages as “a, b and c”…" />
              <div className="row"><span className="hint">or <code>loom lead</code> in the terminal</span><button className="btn or" onClick={() => go('lead', ask.trim())}>Plan with the Lead →</button></div>
            </div>
            <div className="examples reveal" style={{ '--i': 4 } as never}>{EXAMPLES.map((x) => <button key={x} onClick={() => setAsk(x)}>{x}</button>)}</div>
          </div>

          <div className="card h5stage reveal" style={{ '--i': 2 } as never}>
            <div className="bar">
              <span><b>{live?.agents.length ?? 0}</b>agents</span><span><b>{count(['working', 'starting'])}</b>working</span>
              <span><b>{count(['waiting', 'blocked'])}</b>waiting</span><span><b>{live ? live.agents.reduce((n, a) => n + a.lands.length, 0) : 0}</b>landed</span>
              <span className="sp" /><span>{live ? 'live now' : 'no team yet'}</span>
            </div>
            {!live ? (
              <div className="empty"><Bot color="#9A988F" size={52} mode="m-back" /><p style={{ marginTop: 10 }}>No team running.</p><p className="dim">Describe some work on the left, or start a team from a plan below.</p></div>
            ) : (
              <div className="stack">
                <b className="serif" style={{ fontSize: 17 }}>{live.plan}</b>
                {live.agents.map((a) => (
                  <div key={a.id} className="row"><span className="cardrow"><Bot color={agentColor(a.id)} size={30} mode={a.state === 'working' ? 'm-work' : ''} /><b>{a.id}</b><span className="dim">{a.title}</span></span><span className={`state st-${a.state === 'working' || a.state === 'starting' ? 'working' : a.state === 'waiting' || a.state === 'blocked' ? 'waiting' : a.lands.length ? 'landed' : 'idle'}`}>{a.state}</span></div>))}
                <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => go('teams')}>Open the team →</button>
              </div>)}
          </div>
        </div>
      </div>

      {cmp && e1 && (
        <div className="proof reveal" onClick={() => go('bench')} role="link" tabIndex={0}>
          <div className="card sc bad"><div className="big">{e1.blind.broke}/{e1.blind.n}</div><div><div className="l">Without Loom {e1.blind.broke}/{e1.blind.n} broke</div><div className="d">Parallel agents, no coordination.</div></div></div>
          <div className="card sc good"><div className="big">{e1.loom.broke}/{e1.loom.n}</div><div><div className="l">With Loom {e1.loom.broke}/{e1.loom.n}</div><div className="d">The same scenarios, coordinated.</div></div></div>
          <div className="card sc"><div><div className="l">{e5 ? `Real agents: Loom ${e5.l}/${e5.n} · blind ${e5.b}/${e5.n}` : 'Real agents: not run yet'}</div><div className="d">Landed with tests green.</div></div></div>
          <a className="prooflink" href="?view=bench" onClick={(e) => { e.preventDefault(); e.stopPropagation(); go('bench'); }}>See the benchmark →</a>
        </div>)}

      <div className="grid-start" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16, marginTop: 28 }}>
        <div className="card sp reveal">
          <div className="h">Start a team from a plan</div>
          <div className="cardrow" style={{ marginTop: 12 }}>
            <select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="plan">
              {!plans.length && <option value="">No plans yet</option>}
              {plans.map((p) => <option key={p.slug} value={p.slug}>{p.slug}</option>)}
            </select>
            <button className="btn or" disabled={!plan} onClick={start}>Start</button>
            <button className="btn ghost" onClick={() => go('plans')}>Review plans</button>
          </div>
          {msg && <p className="bad" style={{ marginTop: 8 }}>{msg}</p>}
        </div>
        <div className="card sp reveal" style={{ '--i': 1 } as never}>
          <div className="h">Briefing</div>
          <pre className="brief" style={{ marginTop: 10 }}>{brief || 'Nothing yet. Briefings appear once sessions have worked in this repo.'}</pre>
        </div>
      </div>

      <div className="hsec"><div className="sech"><h2>What Loom does for a team of agents</h2><p>Each agent works in its own copy of the repo. Loom sits between them and the shared branch.</p></div>
        <div className="feats">{FEATURES.map(([t, d, no]) => <div key={t} className="card feat" style={{ gridTemplateColumns: '1fr' }}><div><h3>{t}</h3><p>{d}</p><div className="no">{no}</div></div></div>)}</div>
      </div>

      <div className="hsec"><div className="sech"><h2>How it works</h2><p>A small server runs next to your repo. Every agent edit and every landing passes through it.</p></div>
        <div className="pipe">{PIPE.map(([t, d, tech]) => <div key={t} className="pst"><div className="ic" style={{ font: '600 16px var(--serif)', color: 'var(--accent-d)' }}>{t[0]}</div><h3>{t.slice(4)}</h3><p>{d.replace(/`/g, '')}</p><span className="tech">{tech}</span></div>)}</div>
        <div className="langs">
          <div className="card lang"><div className="t"><i style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>✓</i>Python</div><div className="ls"><span>.py</span></div><p>Loom reads the code itself and checks every call against the new signature before work lands, then runs your tests.</p></div>
          <div className="card lang"><div className="t"><i style={{ background: 'var(--good-soft)', color: 'var(--good)' }}>✓</i>Typed languages</div><div className="ls"><span>TypeScript</span><span>Go</span><span>Rust</span><span>Java</span></div><p>Your compiler checks the calls at landing (<code>tsc</code>, <code>go build</code>, <code>cargo check</code>). Only new errors block, so an already-messy repo still works.</p></div>
          <div className="card lang"><div className="t"><i style={{ background: 'var(--line2)', color: 'var(--ink3)' }}>–</i>Not supported</div><div className="ls"><span>JavaScript</span><span>Ruby</span><span>PHP</span></div><p>Nothing can tell for sure that a call still fits without running it, so Loom can't promise landed work runs.</p></div>
        </div>
        <div className="use">{USE.map(([t, d, c]) => <div key={t} className="card"><b>{t}</b>{d}<code>{c}</code></div>)}</div>
      </div>
    </section>
  );
}
