import { useEffect, useMemo, useState } from 'react';
import { api, couldNot } from './api';
import { Empty, Problem, PageHead } from './ui';
import { agentColor } from './stream';
import { person } from './explain';

interface Cell { bucket: string; person: string | null; added: number; changed: number; removed: number }

/** One column per commit, stacked by person: how much of the code each of them added, changed or removed. */
export function Growth() {
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<Cell[] | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => { api<Cell[]>('/growth').then(setRows).catch((e) => setErr(couldNot('history', e))); }, []);
  const d = useMemo(() => {
    if (!rows || !Array.isArray(rows) || !rows.length) return null;
    const buckets = [...new Set(rows.map((r) => r.bucket))];
    const size = (r: Cell) => r.added + r.changed + r.removed;
    const by = (b: string) => rows.filter((r) => r.bucket === b);
    const max = Math.max(...buckets.map((b) => by(b).reduce((n, r) => n + size(r), 0)), 1);
    const totals = new Map<string, { a: number; c: number; r: number }>();
    for (const r of rows) { const k = r.person ?? 'unknown'; const t = totals.get(k) ?? { a: 0, c: 0, r: 0 }; t.a += r.added; t.c += r.changed; t.r += r.removed; totals.set(k, t); }
    return { buckets, by, size, max, totals: [...totals.entries()].sort((x, y) => (y[1].a + y[1].c + y[1].r) - (x[1].a + x[1].c + x[1].r)) };
  }, [rows]);
  const head = <PageHead title="Growth" what="How the code changed over time and who changed it. One column is one commit; its height is lines added, changed or removed, coloured by author." />;
  if (err) return <div className="page">{head}<Problem msg={err} /></div>;
  if (!rows) return <div className="page">{head}<p className="dim">loading…</p></div>;
  if (!d) return <div className="page">{head}<Empty>No history yet. Growth appears as commits land.</Empty></div>;
  const W = 28, GAP = 8, H = 220;
  const total = d.totals.reduce((n, [, t]) => n + t.a + t.c + t.r, 0);
  return (
    <div className="page">
      {head}
      <div className="gstats">
        <div className="card gs"><b>{d.buckets.length}</b><span>commits shown</span></div>
        <div className="card gs"><b>{d.totals.length}</b><span>authors</span></div>
        <div className="card gs"><b>{total.toLocaleString()}</b><span>lines touched</span></div>
      </div>
      <div className="card sp gchart">
        <div className="gscroll">
          <svg width={d.buckets.length * (W + GAP) + 40} height={H + 34} role="img" aria-label="growth by person">
            {[0, 0.5, 1].map((f) => <g key={f}><line x1={36} x2="100%" y1={H - f * H} y2={H - f * H} stroke="var(--line)" strokeDasharray="3 4" /><text x={30} y={H - f * H + 4} textAnchor="end" fontSize="10" fill="var(--ink3)">{Math.round(d.max * f)}</text></g>)}
            {d.buckets.map((b, i) => {
              let y = H; const x = 40 + i * (W + GAP);
              return (
                <g key={b}>
                  {d.by(b).map((r) => { const h = Math.max(d.size(r) / d.max * H, 1); y -= h; const who = r.person ?? 'unknown';
                    return <rect key={who} rx="3" x={x} y={y} width={W} height={h} fill={agentColor(who)} opacity={hover && hover !== who ? 0.25 : 1} onMouseEnter={() => setHover(who)} onMouseLeave={() => setHover(null)}><title>{person(who)}: {r.added} added, {r.changed} changed, {r.removed} removed</title></rect>; })}
                  <text x={x + W / 2} y={H + 16} textAnchor="middle" fontSize="9.5" fill="var(--ink3)" fontFamily="var(--mono)">{b.slice(0, 5)}</text>
                </g>);
            })}
          </svg>
        </div>
        <p className="dim" style={{ fontSize: 12, margin: '8px 0 0' }}>Hover a colour to follow one author. The labels under each column are commit ids.</p>
      </div>
      <div className="card sp">
        <h3>Who changed the most</h3>
        {d.totals.map(([who, t]) => { const n = t.a + t.c + t.r; return (
          <div key={who} className="grow" onMouseEnter={() => setHover(who)} onMouseLeave={() => setHover(null)}>
            <i className="dot" style={{ background: agentColor(who) }} /><span className="gname">{person(who)}</span>
            <div className="gbar"><i style={{ width: `${n / (d.totals[0][1].a + d.totals[0][1].c + d.totals[0][1].r) * 100}%`, background: agentColor(who) }} /></div>
            <span className="dim gnum">+{t.a} ~{t.c} −{t.r}</span>
          </div>); })}
        <p className="dim" style={{ fontSize: 12, margin: '8px 0 0' }}>+ added · ~ changed · − removed (lines)</p>
      </div>
    </div>
  );
}
