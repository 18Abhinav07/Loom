import { useEffect, useState } from 'react';
import { api, couldNot } from './api';
import { agentColor } from './stream';

interface Cell { bucket: string; person: string; added: number; changed: number; removed: number }
const W = 36, GAP = 10, H = 180;

/** One column per commit, stacked by person: how much of the code each of them added, changed or removed. */
export function Growth() {
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<Cell[] | null>(null);
  useEffect(() => { api<Cell[]>('/growth').then(setRows).catch((e) => setErr(couldNot('history', e))); }, []);
  if (err) return <p className="pad bad">{err}</p>;
  if (!rows) return <p className="pad dim">loading…</p>;
  if (!rows.length) return <p className="pad dim">No history yet. Growth appears as commits land.</p>;
  const buckets = [...new Set(rows.map((r) => r.bucket))];
  const size = (r: Cell) => r.added + r.changed + r.removed;
  const max = Math.max(...buckets.map((b) => rows.filter((r) => r.bucket === b).reduce((n, r) => n + size(r), 0)), 1);
  const people = [...new Set(rows.map((r) => r.person))];
  return (
    <div className="pad">
      <svg width={buckets.length * (W + GAP) + GAP} height={H + 30} role="img" aria-label="growth by person" style={{ maxWidth: '100%' }}>
        {buckets.map((b, i) => {
          let y = H;
          return (
            <g key={b}>
              {rows.filter((r) => r.bucket === b).map((r) => { const h = size(r) / max * H; y -= h;
                return <rect key={r.person} data-person={r.person} x={GAP + i * (W + GAP)} y={y} width={W} height={h} fill={agentColor(r.person)}><title>{r.person}: {r.added} added, {r.changed} changed, {r.removed} removed</title></rect>; })}
              <text x={GAP + i * (W + GAP) + W / 2} y={H + 16} textAnchor="middle" fontSize="10" fill="currentColor">{b}</text>
            </g>);
        })}
      </svg>
      <div className="row">{people.map((p) => <span key={p}><i className="dot" style={{ background: agentColor(p) }} />{p}</span>)}</div>
    </div>
  );
}
