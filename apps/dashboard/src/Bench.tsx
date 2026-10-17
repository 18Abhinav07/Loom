// StaleBench: the comparison first (from /bench/compare), the raw records folded underneath. A missing result is shown as missing, never estimated.
// Cost and wall-clock columns are never shown: the claim is correctness, not speed or price.
import { useEffect, useState } from 'react';
import { api, type Compare } from './api';
import { Empty } from './ui';
import { getJson } from './stream';

type J = Record<string, any>;
const HIDDEN = /^file$|cost|usd|second|wall|elapsed|(^|\.)time|_s$/i;
const shown = (k: string) => !HIDDEN.test(k);
const fmt = (v: unknown) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : v == null ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function KV({ o }: { o: J }) {
  return <table className="grid"><tbody>{Object.entries(o).filter(([k]) => shown(k)).map(([k, v]) => <tr key={k}><td className="dim">{k}</td><td>{fmt(v)}</td></tr>)}</tbody></table>;
}
/** Rows keyed by name (conditions, events) → one table with the union of their scalar columns. */
function Rows({ o }: { o: Record<string, J> }) {
  const flat = (v: J, p = ''): J => Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.entries(flat(x, `${p}${k}.`)) : [[`${p}${k}`, x]])));
  const rows = Object.entries(o).map(([k, v]) => [k, flat(v)] as const);
  const cols = [...new Set(rows.flatMap(([, v]) => Object.keys(v)))].filter(shown);
  return (
    <table className="grid"><thead><tr><th />{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>{rows.map(([k, v]) => <tr key={k}><td><b>{k}</b></td>{cols.map((c) => <td key={c}>{fmt(v[c])}</td>)}</tr>)}</tbody></table>
  );
}
const SECTIONS: [string, string, string][] = [
  ['E1', 'e1', 'Interference: blind vs oracle vs live'], ['E2', 'e2', 'Lease safety under contention'], ['E2', 'e2-control', 'Same load, leases off (control)'],
  ['E3', 'e3', 'Notice precision'], ['E4', 'e4-hooks', 'Hook latency'], ['E4', 'e4-indexer', 'Incremental index latency'],
];
import PREREG from '../../../bench/e5/PREREG.md?raw';
const label = (s: string) => s.replace(/^[a-z]\d+_/, '').replace(/_/g, ' ');

function Bar({ n, of, tone, text }: { n: number; of: number; tone: 'bad' | 'good'; text: string }) {
  return (
    <div className="bar"><div className={`fill ${tone}`} style={{ width: `${of ? Math.max(n / of * 100, 1.5) : 0}%` }} /><span className="stat">{text}</span></div>
  );
}

export function Bench() {
  const [b, setB] = useState<Record<string, J> | null>(null);
  const [cmp, setCmp] = useState<Compare | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    getJson<Record<string, J>>('/bench').then(setB).catch((e) => setErr(String(e)));
    api<Compare>('/bench/compare').then(setCmp).catch(() => {});
  }, []);
  if (err) return <Empty>{err}</Empty>;
  if (!b) return <p className="dim">loading…</p>;
  const pairs: J[] = b['e1-story']?.pairs ?? [];
  const e1 = cmp?.e1?.blind && cmp.e1.loom ? cmp.e1 : null;
  const tot = cmp?.e5?.length ? cmp.e5.reduce((a, s) => ({ l: a.l + s.loom.all_pass, b: a.b + s.blind.all_pass, n: a.n + s.loom.n }), { l: 0, b: 0, n: 0 }) : null;
  const nOf = (x: number) => (x === 1 ? '1 pair' : `${x} pairs`);
  return (
    <div className="page bench">
      <div className="bh">
        <h1>StaleBench</h1>
        <p className="dim">One agent changes a function; another agent depends on it. Does the merged code still pass its tests? Same model, same repo, same prompts, pre-registered.</p>
      </div>
      {e1 && (
        <section className="card sp bhero">
          <div className="bt bad"><b>{e1.blind.broke}<small>/{e1.blind.n}</small></b><span>broke without Loom</span></div>
          <div className="bt good"><b>{e1.loom.broke}<small>/{e1.loom.n}</small></b><span>broke with Loom</span></div>
          <div className="bt"><b>{e1.blind.n}</b><span>task pairs run ({pairs[0] ? 'one per function' : 'E1 core'})</span></div>
        </section>)}
      <p className="dim bscope">Scope: {e1 ? nOf(e1.blind.n) : 'E1'} of StaleBench, each run blind and with Loom. The 36-pair full set was not run. The live Django demo is one 3-task scenario, one run per side.</p>
      {cmp && (
        <section className="card sp">
          <h3>E1 · Does a stale function break the other agent's work?</h3>
          {e1 ? <>
            <Bar n={e1.blind.broke} of={e1.blind.n} tone="bad" text={`Without Loom ${e1.blind.broke}/${e1.blind.n} broke`} />
            <Bar n={e1.loom.broke} of={e1.loom.n} tone="good" text={`With Loom ${e1.loom.broke}/${e1.loom.n} broke`} />
          </> : <p className="dim">E1 not run yet. Run <code>bench/regen.sh</code>.</p>}
          {pairs.length > 0 && (
            <div className="ptiles">
              {pairs.map((p) => (
                <div key={p.id} className="ptile" title={p.change}>
                  <b>{p.func}</b><span className="dim">{p.mech}</span>
                  <div><span className={`pv ${p.blind?.broke ? 'bad' : 'good'}`}>{p.blind?.broke ? '✕ broke' : '✓ ok'}</span><span className="dim"> without</span></div>
                  <div><span className={`pv ${!p.live ? '' : p.live.broke ? 'bad' : 'good'}`}>{!p.live ? '–' : p.live.broke ? '✕ broke' : '✓ held'}</span><span className="dim"> with</span></div>
                </div>))}
            </div>)}
        </section>)}
      {cmp && (
        <section className="card sp">
          <h3>E5 · Real agents on one repo</h3>
          {!tot ? <p className="dim">Real agents: not run yet.</p> : <>
            <div className="tw"><table className="grid"><thead><tr><th>Scenario</th><th>Without Loom</th><th>With Loom</th><th>Broken merged</th><th>Merge conflicts</th></tr></thead>
              <tbody>{cmp.e5.map((s) => (
                <tr key={s.scenario}><td>{label(s.scenario)}</td><td>{`${s.blind.all_pass}/${s.blind.n} pass`}</td><td>{`${s.loom.all_pass}/${s.loom.n} pass`}</td>
                  <td>{s.blind.broken}</td><td>{s.blind.conflicts}</td></tr>))}</tbody></table></div>
            <p className="stat">With Loom {tot.l}/{tot.n} · without {tot.b}/{tot.n}. Small n: read it as a pilot, not a proof.</p>
          </>}
        </section>)}
      {!cmp && <p className="dim">No comparison recorded yet. Run <code>bench/regen.sh</code>.</p>}
      <details className="card sp"><summary><b>Pre-registration</b></summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, marginTop: 10 }}>{PREREG}</pre></details>
      <details className="card sp">
        <summary><b>Raw records</b></summary>
        {SECTIONS.map(([e, k, title]) => {
          const v = b[k];
          const nested = v && Object.entries(v).find(([, x]) => x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every((y) => y && typeof y === 'object'));
          return (
            <section key={k}>
              <h3>{e} · {title} <span className="dim">({k}.json)</span></h3>
              {!v ? <p className="dim">not run yet — <code>bench/regen.sh</code></p>
                : <>{nested && <Rows o={nested[1]} />}<KV o={Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== nested?.[0]))} /></>}
            </section>);
        })}
      </details>
    </div>
  );
}
