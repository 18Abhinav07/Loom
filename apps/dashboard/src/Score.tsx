import type { Team } from './api';

/** Everything a live run can say about itself, read from the team record alone so a team with Loom and one without are scored the same way. */
export function scoreOf(t: Team) {
  const out = t.result?.out ?? '';
  const ran = Number(/Ran (\d+) tests?/.exec(out)?.[1] ?? NaN);
  const fail = Number(/failures=(\d+)/.exec(out)?.[1] ?? 0); const err = Number(/errors=(\d+)/.exec(out)?.[1] ?? 0);
  const skip = Number(/skipped=(\d+)/.exec(out)?.[1] ?? 0);
  const bad = fail + err; const broke = Number.isFinite(ran) ? Math.max(bad, t.result && !t.result.pass && !bad ? 1 : 0) : 0;
  const tried = t.agents.flatMap((a) => a.lands);
  const kinds = (k: string) => tried.filter((l) => l === k).length;
  return {
    ran: Number.isFinite(ran) ? ran : null, passed: Number.isFinite(ran) ? Math.max(ran - bad - skip, 0) : null, bad, broke, skip,
    n: t.agents.length, landed: t.agents.filter((a) => a.state === 'landed').length,
    firstTry: t.agents.filter((a) => a.lands[0] === 'landed').length,
    sentBack: tried.filter((l) => l !== 'landed').length,
    resumed: t.agents.reduce((s, a) => s + a.resumed, 0),
    testsFailed: kinds('tests_failed'), contract: kinds('contract_break'), conflicts: kinds('merge_conflict'), scope: kinds('out_of_scope'),
    verdict: t.result ? (t.result.pass ? 'pass' as const : 'fail' as const) : t.state === 'running' ? 'running' as const : 'none' as const,
  };
}

const Tile = ({ v, k, tone }: { v: string | number; k: string; tone?: string }) => <div className={`sc-t ${tone ?? ''}`}><b>{v}</b><span>{k}</span></div>;

/** The score of one live run: did the combined work pass, how many tests, how the landings went. `extra` adds what only Loom can count. */
export function Scorecard({ t, extra }: { t: Team; extra?: { k: string; v: number }[] }) {
  const s = scoreOf(t);
  const verdict = s.verdict === 'pass' ? ['All tests pass', 'good'] : s.verdict === 'fail' ? ['Combined work fails', 'bad'] : s.verdict === 'running' ? ['Running…', ''] : ['No test result', ''];
  return (
    <div className="card sp reveal scorecard" data-testid="scorecard">
      <div className="h">Score · {t.plan}{t.blind ? ' · without Loom' : ' · with Loom'}</div>
      <div className="sc-g">
        <Tile v={verdict[0]} k="StaleBench verdict" tone={verdict[1]} />
        <Tile v={s.ran === null ? '–' : `${s.passed}/${s.ran}`} k="tests passed" tone={s.ran === null ? '' : s.bad ? 'bad' : 'good'} />
        <Tile v={`${s.landed}/${s.n}`} k="tasks landed" tone={s.landed === s.n ? 'good' : ''} />
        <Tile v={`${s.firstTry}/${s.n}`} k="landed first try" />
        <Tile v={s.sentBack} k="sent back" tone={s.sentBack ? 'bad' : ''} />
        <Tile v={s.resumed} k="resumed after send-back" />
        {(s.testsFailed > 0 || s.contract > 0 || s.conflicts > 0 || s.scope > 0) && <Tile v={[s.testsFailed && `${s.testsFailed} tests`, s.contract && `${s.contract} contract`, s.conflicts && `${s.conflicts} merge`, s.scope && `${s.scope} scope`].filter(Boolean).join(' · ')} k="why it was sent back" />}
        {extra?.map((e) => <Tile key={e.k} v={e.v} k={e.k} />)}
      </div>
    </div>);
}

/** The newest live run of each kind next to each other, for the Bench tab. */
export function LiveVsLoom({ teams }: { teams: Team[] }) {
  const newest = (blind: boolean) => [...teams].filter((t) => !!t.blind === blind && t.state !== 'running').sort((a, b) => b.startedAt - a.startedAt)[0];
  const b = newest(true); const l = newest(false);
  if (!b && !l) return <p className="dim">No finished live run yet. Press Plan on Home; the result lands here when both teams finish.</p>;
  const cell = (t?: Team) => { if (!t) return <td colSpan={1} className="dim">not run</td>; const s = scoreOf(t); return <td className={s.verdict === 'pass' ? 'good' : s.verdict === 'fail' ? 'bad' : ''}>{s.verdict === 'pass' ? '✓ pass' : s.verdict === 'fail' ? '✕ fail' : '–'}{s.ran !== null && <span className="dim"> · {s.passed}/{s.ran} tests</span>}<br /><span className="dim">{s.landed}/{s.n} landed · {s.sentBack} sent back</span></td>; };
  return <div className="tw"><table className="grid"><thead><tr><th>Latest live run</th><th>Without Loom</th><th>With Loom</th></tr></thead><tbody><tr><td>{(l ?? b)!.plan}</td>{cell(b)}{cell(l)}</tr></tbody></table></div>;
}
