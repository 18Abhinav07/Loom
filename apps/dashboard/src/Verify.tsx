// Verify view: every claim_done, grouped by state, with mutation strength and the blind spots that keep it from 1.
import { useEffect, useState } from 'react';
import { getJson } from './stream';

interface Claim { task: string; agent: string; state: string; strength: number | null; blindSpots: string[] | null; missing: string | null; labels: string[] | null; at: number }
const ORDER = ['FAIL', 'STALE', 'UNKNOWN', 'VERIFIED'];

export function Verify({ run }: { run: string }) {
  const [cs, setCs] = useState<Claim[] | null>(null);
  const [err, setErr] = useState('');
  const [ls, setLs] = useState<{ id: string; text: string; hits: number; symbols: string[] }[]>([]);
  useEffect(() => { getJson<{ lessons: any[] }>(`/lessons`).then((x) => setLs(x.lessons)).catch(() => {}); }, [run]);
  useEffect(() => {
    let alive = true;
    const load = () => getJson<{ claims: Claim[] }>(`/claims?run=${encodeURIComponent(run)}`).then((x) => alive && setCs(x.claims)).catch((e) => setErr(String(e)));
    setCs(null); load(); const t = setInterval(load, 4000); return () => { alive = false; clearInterval(t); };
  }, [run]);
  if (err) return <p className="pad dim">{err}</p>;
  if (!cs) return <p className="pad dim">loading…</p>;
  if (!cs.length) return <p className="pad dim">No claims yet. Agents claim with the <code>claim_done</code> tool, or run <code>loom verify</code>.</p>;
  return (
    <div className="scroll pad">
      {ORDER.filter((s) => cs.some((c) => c.state === s)).map((s) => (
        <section key={s}>
          <h3 className={`claim ${s}`}>{s} · {cs.filter((c) => c.state === s).length}</h3>
          <table className="grid">
            <thead><tr><th>agent</th><th>task</th><th>strength</th><th>blind spots / missing</th><th>tests</th></tr></thead>
            <tbody>{cs.filter((c) => c.state === s).map((c, i) => (
              <tr key={i}><td>{c.agent}</td><td>{c.task}</td>
                <td>{c.strength == null ? '–' : <><span className="bar"><i style={{ width: `${c.strength * 100}%` }} /></span> {c.strength.toFixed(2)}</>}</td>
                <td>{(c.blindSpots ?? []).map((b) => <code key={b} className="tag">{b.split('::').pop()}</code>)}{c.missing && <span className="dim"> {c.missing}</span>}</td>
                <td className="dim">{(c.labels ?? []).join(', ')}</td></tr>))}
            </tbody>
          </table>
        </section>))}
      <h3>Lessons (all runs)</h3>
      {ls.length ? <ul>{ls.map((l) => <li key={l.id}>{l.text} <span className="dim">· {l.id} · hits {l.hits}</span></li>)}</ul> : <p className="dim">none</p>}
    </div>
  );
}
