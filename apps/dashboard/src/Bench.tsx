// Bench view: renders only what bench/results/*.json holds; a missing result is shown as missing, never estimated.
import { useEffect, useState } from 'react';
import { getJson } from './stream';

type J = Record<string, any>;
const fmt = (v: unknown) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : v == null ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function KV({ o }: { o: J }) {
  return <table className="grid"><tbody>{Object.entries(o).map(([k, v]) => <tr key={k}><td className="dim">{k}</td><td>{fmt(v)}</td></tr>)}</tbody></table>;
}
/** Rows keyed by name (conditions, events) → one table with the union of their scalar columns. */
function Rows({ o }: { o: Record<string, J> }) {
  const flat = (v: J, p = ''): J => Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.entries(flat(x, `${p}${k}.`)) : [[`${p}${k}`, x]])));
  const rows = Object.entries(o).map(([k, v]) => [k, flat(v)] as const);
  const cols = [...new Set(rows.flatMap(([, v]) => Object.keys(v)))];
  return (
    <table className="grid"><thead><tr><th />{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>{rows.map(([k, v]) => <tr key={k}><td><b>{k}</b></td>{cols.map((c) => <td key={c}>{fmt(v[c])}</td>)}</tr>)}</tbody></table>
  );
}
const SECTIONS: [string, string, string][] = [
  ['E1', 'e1', 'Interference: blind vs oracle vs live'], ['E2', 'e2', 'Lease safety under contention'], ['E2', 'e2-control', 'Same load, leases off (control)'],
  ['E3', 'e3', 'Notice precision'], ['E4', 'e4-hooks', 'Hook latency'], ['E4', 'e4-indexer', 'Incremental index latency'],
];

export function Bench() {
  const [b, setB] = useState<Record<string, J> | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { getJson<Record<string, J>>('/bench').then(setB).catch((e) => setErr(String(e))); }, []);
  if (err) return <p className="pad dim">{err}</p>;
  if (!b) return <p className="pad dim">loading…</p>;
  return (
    <div className="scroll pad">
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
    </div>
  );
}
