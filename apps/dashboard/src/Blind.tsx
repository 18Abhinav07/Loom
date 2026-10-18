import { Scorecard } from './Score';
import { PairGrid } from './PairGrid';
import { useEffect, useState } from 'react';
import { api, couldNot, type Team } from './api';
import { agentColor } from './stream';
import { ago, landText } from './explain';
import { Bot, Problem } from './ui';
import { checksOf, face, FACE_TEXT } from './Teams';

/** The test runner's output as a short account: what ran, what is missing, what failed. The raw text stays one click away. */
export function readVerdict(out: string) {
  const ran = /Ran (\d+) tests?/.exec(out)?.[1];
  const missing = [...new Set([...out.matchAll(/No module named '([^']+)'/g)].map((m) => m[1]))];
  const failed = [...out.matchAll(/^(?:FAIL|ERROR): (\w+) \(([^)]+)\)/gm)].map((m) => ({ test: m[1], where: m[2] }));
  const why = [...out.matchAll(/^(AssertionError|TypeError|ValueError|AttributeError|NameError): (.+)$/gm)].map((m) => `${m[1]}: ${m[2]}`).slice(0, 3);
  return { ran, missing, failed, why };
}

function Verdict({ t }: { t: Team }) {
  if (t.state === 'running') return <div className="card sp reveal"><div className="h">Test result</div><p className="dim">The four agents are still working. The tests run on the combined result when all of them are done.</p></div>;
  if (!t.result) return <div className="card sp reveal"><div className="h">Test result</div><p className="dim">The team finished without a test result.</p></div>;
  const v = readVerdict(t.result.out); const ok = t.result.pass;
  return (
    <div className="card sp reveal bverdict">
      <div className="h">Test result on the combined work</div>
      <div className={`bv ${ok ? 'ok' : 'bad'}`}><i className="sd" />{ok ? 'All tests pass' : 'The combined work fails its tests'}{v.ran && <span className="dim"> · {v.ran} tests ran</span>}</div>
      {!ok && <ul className="bwhy">
        {v.missing.map((m) => <li key={m}>A test file the plan expects, <code>{m.replace(/\./g, '/')}.py</code>, is not on the branch: the agent that writes it never got its work landed.</li>)}
        {v.failed.map((f) => <li key={f.where}><code>{f.test}</code> failed <span className="dim">({f.where})</span></li>)}
        {v.why.map((w) => <li key={w} className="dim">{w}</li>)}
        {!v.missing.length && !v.failed.length && <li>The run failed; open the raw output below.</li>}
      </ul>}
      <details><summary className="dim" style={{ cursor: 'pointer' }}>Show the raw test output</summary><pre className="term" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', marginTop: 8 }}>{t.result.out}</pre></details>
    </div>);
}

/** The without-Loom team, laid out like the Team page: one card per agent, the landing checks, then the test result. No graph, no locks, no messages: there are none. */
export function Blind({ go }: { go?: (v: string) => void }) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  useEffect(() => {
    const poll = () => api<Team[]>('/teams').then((t) => { setErr(''); setTeams(t); }).catch((e) => setErr(couldNot('teams', e)));
    poll(); const i = setInterval(poll, 2000); return () => clearInterval(i);
  }, []);
  if (err) return <Problem msg={err} />;
  if (!teams) return <p className="dim">loading…</p>;
  const mine = [...teams].filter((t) => t.blind).sort((a, b) => b.startedAt - a.startedAt);
  const cur = mine.find((t) => t.id === pick) ?? mine.find((t) => t.state === 'running') ?? mine[0];
  if (!cur) return <section className="screen on page"><div className="card onboard reveal"><Bot color="#9A988F" size={56} /><h3>No run without Loom yet</h3><p>Press Plan. The four agents without Loom appear here as soon as they start.</p><button className="btn or" onClick={() => go?.('home')}>Back to Home</button></div></section>;
  const agents = cur.agents; const landed = agents.filter((a) => a.state === 'landed').length;
  return (
    <section className="screen on">
      <div className="card tstrip reveal">
        <div className="tname"><b>{cur.plan} · without Loom</b><small>{landed} of {agents.length} tasks landed</small><div className="prog"><i style={{ width: `${agents.length ? (landed / agents.length) * 100 : 0}%` }} /></div></div>
        <div className="spacer" />
        {cur.state === 'done' && <div className={`done-banner on ${cur.result?.pass ? '' : 'bad'}`}>{cur.result ? (cur.result.pass ? '✓ Finished · tests pass' : '✕ Finished · tests FAIL') : '✓ Finished'}</div>}
      </div>
      <p className="pgsub reveal" style={{ marginBottom: 14 }}>{cur.goal} <span className="dim">· started {ago(cur.startedAt)}. These agents cannot see each other: no locks, no warnings, no messages.</span></p>
      <PairGrid teams={mine} current={cur.id} onPick={setPick} />
      <Scorecard t={cur} />
      <div className="bagents">
        {agents.map((a) => {
          const f = face(a, false); const c = agentColor(a.id); const k = checksOf(a);
          return (
            <div key={a.id} className={`card ag ${f}`} style={{ '--c': c } as never} data-testid="agent-card">
              <div className="aghead">
                <div className="botw"><Bot color={c} size={50} mode={f === 'working' ? 'm-work' : ''} /><span className="badge">{f === 'landed' ? '✓' : '!'}</span></div>
                <div><div className="agname">{a.id}</div><div className="agtask">{a.title}</div></div>
                <span className={`state st-${f}`}>{FACE_TEXT[f]}</span>
              </div>
              <div className="agbody">
                <div className="kv2"><span>Landing</span><span>{a.lands.length ? a.lands.map(landText).join(' → ') : a.state === 'running' ? 'Not finished yet' : 'Not checked yet'}{a.lands.length > 1 ? ` · tried ${a.lands.length}×` : ''}</span></div>
                <div className="kv2"><span>Result</span><span style={{ color: k.color }}>{k.why || k.res}</span></div>
                <details className="breport" open={f === 'sentback'}>
                  <summary>{a.lastReply ? 'What it reported' : 'No report yet'}</summary>
                  {a.lastReply && <div className="breply">{a.lastReply}</div>}
                </details>
              </div>
            </div>);
        })}
      </div>
      <Verdict t={cur} />
    </section>
  );
}
