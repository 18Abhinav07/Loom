// Every StaleBench pair of a benchmark run at once: one card per pair (A, B, verdict), newest first. Click one to open it below.
import type { Team } from './api';

const cond = (t: Team) => (/__(blind|live|oracle)__/.exec(t.id)?.[1] ?? '');
const name = (t: Team) => t.plan.replace(/^sb-/, '');
const dot = (s: string) => (s === 'landed' ? 'ok' : s === 'failed' || s === 'stopped' || s === 'blocked' ? 'bad' : s === 'running' ? 'run' : 'wait');

export const isPair = (t: Team) => t.plan.startsWith('sb-');

export function PairGrid({ teams, current, onPick }: { teams: Team[]; current: string; onPick: (id: string) => void }) {
  const pairs = teams.filter(isPair).sort((a, b) => b.startedAt - a.startedAt);
  if (!pairs.length) return null;
  const running = pairs.filter((t) => t.state === 'running').length;
  const passed = pairs.filter((t) => t.state === 'done' && t.result?.pass).length;
  const failed = pairs.filter((t) => t.state !== 'running' && !(t.state === 'done' && t.result?.pass)).length;
  return (
    <div className="card pgrid reveal">
      <div className="h">StaleBench pairs <small>{pairs.length} total · {running} running · {passed} held when merged · {failed} broke</small></div>
      <div className="pg">
        {pairs.map((t) => {
          const [a, b] = [t.agents.find((x) => x.id === 'a'), t.agents.find((x) => x.id === 'b')];
          const v = t.state === 'running' ? 'running' : t.result?.pass ? 'held' : 'broke';
          return (
            <button key={t.id} className={`pgc ${v}${t.id === current ? ' sel' : ''}`} onClick={() => onPick(t.id)}>
              <b>{name(t).split('__')[0]}</b>
              <small>{name(t).split('__')[1]}{cond(t) ? ` · ${cond(t)}` : ''}</small>
              <span className="pgs"><i className={`d ${dot(a?.state ?? '')}`} title={`A ${a?.state}`} />A <i className={`d ${dot(b?.state ?? '')}`} title={`B ${b?.state}`} />B <em>{v}</em></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
