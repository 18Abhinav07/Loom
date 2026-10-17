// StaleBench: the comparison first (from /bench/compare), the raw records folded underneath. A missing result is shown as missing, never estimated.
// Cost and wall-clock columns are never shown: the claim is correctness, not speed or price.
import { useEffect, useState } from 'react';
import { api, type Compare } from './api';
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
const PREREG = 'https://github.com/18Abhinav07/Loom/blob/main/bench/e5/PREREG.md';
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
  if (err) return <p className="pad dim">{err}</p>;
  if (!b) return <p className="pad dim">loading…</p>;
  const pairs: J[] = b['e1-story']?.pairs ?? [];
  const e1 = cmp?.e1?.blind && cmp.e1.loom ? cmp.e1 : null;
  const tot = cmp?.e5?.length ? cmp.e5.reduce((a, s) => ({ l: a.l + s.loom.all_pass, b: a.b + s.blind.all_pass, n: a.n + s.loom.n }), { l: 0, b: 0, n: 0 }) : null;
  return (
    <div className="scroll pad">
      <h1>StaleBench</h1>
      <p className="dim">Same task, same repo, same prompts; pre-registered. <a href={PREREG} target="_blank" rel="noreferrer">Read the pre-registration</a></p>
      {cmp && (
        <section className="card">
          <h3>E1 · Does a stale function break the other agent's work?</h3>
          {e1 ? <>
            <Bar n={e1.blind.broke} of={e1.blind.n} tone="bad" text={`Without Loom ${e1.blind.broke}/${e1.blind.n} broke`} />
            <Bar n={e1.loom.broke} of={e1.loom.n} tone="good" text={`With Loom ${e1.loom.broke}/${e1.loom.n}`} />
          </> : <p className="dim">E1 not run yet — <code>bench/regen.sh</code></p>}
          {pairs.length > 0 && (
            <div className="pairs">{pairs.map((p) => (
              <div key={p.id} className="pair" title={p.change}>
                <b>{p.func}</b><span className="dim">{p.mech}</span>
                <span className={p.blind?.broke ? 'bad' : 'good'}>{p.blind?.broke ? 'broke' : 'ok'}</span>
                <span className={p.live?.broke ? 'bad' : 'good'}>{p.live ? (p.live.broke ? 'broke' : 'held') : 'none'}</span>
              </div>))}
              <p className="dim">Each row: the function, how it changed, then without Loom, then with Loom.</p>
            </div>)}
        </section>)}
      {cmp && !tot && <section className="card"><h3>E5 · Real agents on one repo</h3><p className="dim">Real agents: not run yet.</p></section>}
      {cmp && tot && (
        <section className="card">
          <h3>E5 · Real agents on one repo</h3>
          <table className="grid"><thead><tr><th>Scenario</th><th>Without Loom passes</th><th>With Loom passes</th><th>Broken merged (without)</th><th>Merge conflicts (without)</th></tr></thead>
            <tbody>{cmp.e5.map((s) => (
              <tr key={s.scenario}><td>{label(s.scenario)}</td><td>{`${s.blind.all_pass}/${s.blind.n}`}</td><td>{`${s.loom.all_pass}/${s.loom.n}`}</td>
                <td>{s.blind.broken}</td><td>{s.blind.conflicts}</td></tr>))}
              <tr><td colSpan={5}><b className="stat">Loom {tot.l}/{tot.n} · blind {tot.b}/{tot.n}</b></td></tr>
            </tbody></table>
        </section>)}
      {!cmp && <p className="dim">No comparison recorded yet. Run <code>bench/regen.sh</code>.</p>}
      <details>
        <summary>Raw records</summary>
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
