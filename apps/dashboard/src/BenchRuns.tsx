import { useEffect, useState } from 'react';
import { getJson } from './stream';

interface Rec { id: string; mech: string; cond: string; solo: boolean; merged: boolean; interference: number; seconds: number; cost: number | null; ok: boolean; aLandedS: number | null; delivered: number; resumed: boolean; notices: { text: string; status?: string; score?: number }[] }
interface Runs { dir: string | null; records: Rec[]; updated: number }

const label = (id: string) => { const [fn, m] = id.split('__'); return { fn, m }; };
const MECH: Record<string, string> = { signature: 'signature gains a required argument', rename: 'function renamed', rettype: 'return type changes' };

function Side({ r, loom }: { r?: Rec; loom: boolean }) {
  if (!r) return <div className="brs wait"><span className="sd" />{loom ? 'with Loom' : 'without Loom'}<b>waiting…</b></div>;
  const held = r.merged;
  return (
    <div className={`brs ${held ? 'ok' : 'bad'}`}>
      <span className="sd" />{loom ? 'with Loom' : 'without Loom'}
      <b>{held ? '✓ merged code passes' : '✕ merged code breaks'}</b>
      <small className="dim">agent B {r.seconds}s{r.cost != null ? ` · $${r.cost.toFixed(3)}` : ''}</small>
      {loom && <small className="dim">A's change reached the graph at {r.aLandedS ?? '–'}s · {r.delivered} notice{r.delivered === 1 ? '' : 's'} delivered to B{r.resumed ? ' · B woken' : ''}</small>}
      {loom && r.notices[0] && <details><summary className="dim">what Loom told B</summary><pre className="term" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, marginTop: 6 }}>{r.notices[0].text}</pre></details>}
      {loom && !held && <small className="bad">B saw the notice ({r.notices[0]?.status ?? 'none'}) but its change still does not fit A's.</small>}
    </div>);
}

/** The newest StaleBench run, filled in pair by pair while `loom stalebench` runs. Per pair: what broke without Loom, what Loom told the agent, what held. */
export function BenchRuns() {
  const [d, setD] = useState<Runs | null>(null);
  useEffect(() => {
    const poll = () => getJson<Runs>('/bench/runs').then(setD).catch(() => {});
    poll(); const i = setInterval(poll, 3000); return () => clearInterval(i);
  }, []);
  if (!d?.dir) return <p className="dim">No StaleBench run on this machine yet. <code>loom stalebench --pairs 12</code> fills this in pair by pair while it runs.</p>;
  const ids = [...new Set(d.records.map((r) => r.id))];
  const get = (id: string, c: string) => d.records.find((r) => r.id === id && r.cond === c);
  const done = (c: string) => d.records.filter((r) => r.cond === c);
  const live = Date.now() - d.updated < 120000;
  const b = done('blind'); const l = done('live');
  return (
    <section className="card sp benchruns" data-testid="bench-runs">
      <h3>This machine's StaleBench run {live && <span className="chip on"><i className="sd" /> running</span>}</h3>
      <div className="sc-g">
        <div className="sc-t bad"><b>{b.filter((r) => !r.merged).length}/{b.length}</b><span>broke without Loom</span></div>
        <div className="sc-t good"><b>{l.filter((r) => !r.merged).length}/{l.length}</b><span>broke with Loom</span></div>
        <div className="sc-t"><b>{l.reduce((s, r) => s + r.delivered, 0)}</b><span>notices Loom delivered to B</span></div>
        <div className="sc-t"><b>{ids.length}</b><span>pairs so far</span></div>
      </div>
      <div className="brgrid">
        {ids.map((id) => { const { fn, m } = label(id); return (
          <div key={id} className="brpair">
            <div className="brh"><b>{fn}()</b><span className="dim">{MECH[m] ?? m}</span></div>
            <Side r={get(id, 'blind')} loom={false} />
            <Side r={get(id, 'live')} loom />
          </div>); })}
      </div>
      <p className="dim" style={{ fontSize: 12 }}>One pair = agent A changes the function, agent B (a real Haiku run) builds on it. A's change is a fixed patch from the dataset; the Loom side gets it through Loom's edit path while B works. Run: <code>{d.dir}</code></p>
    </section>);
}
