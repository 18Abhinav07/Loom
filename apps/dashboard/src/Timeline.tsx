// Timeline view: everything that happened in a run, one lane (column) per agent, rows in time order.
import { useEffect, useState } from 'react';
import { agentColor, getJson } from './stream';

interface Row { kind: 'step' | 'notice' | 'commit' | 'test'; agent: string | null; at: number; text: string }

export function Timeline({ run }: { run: string }) {
  const [d, setD] = useState<{ rows: Row[]; agents: string[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => getJson<{ rows: Row[]; agents: string[] }>(`/timeline?run=${encodeURIComponent(run)}`).then((x) => alive && setD(x)).catch((e) => setErr(String(e)));
    setD(null); load(); const t = setInterval(load, 4000); return () => { alive = false; clearInterval(t); };
  }, [run]);
  if (err) return <p className="pad dim">{err}</p>;
  if (!d) return <p className="pad dim">loading…</p>;
  if (!d.rows.length) return <p className="pad dim">Nothing recorded for this run yet.</p>;
  const t0 = d.rows[0].at;
  return (
    <div className="scroll pad">
      <table className="lanes">
        <thead><tr><th>t+s</th>{d.agents.map((a) => <th key={a}><span className="dot" style={{ background: agentColor(a) }} />{a}</th>)}</tr></thead>
        <tbody>{d.rows.map((r, i) => (
          <tr key={i}><td className="dim t">{((r.at - t0) / 1000).toFixed(1)}</td>
            {d.agents.map((a) => <td key={a}>{r.agent === a && <span className={`ev ${r.kind}`}><b>{r.kind}</b> {r.text}</span>}</td>)}
          </tr>))}
        </tbody>
      </table>
    </div>
  );
}
