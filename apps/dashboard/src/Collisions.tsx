import { useEffect, useState } from 'react';
import { api, couldNot, type Collision } from './api';
import { Problem } from './ui';

const KINDS = ['lock_denied', 'lock_wait', 'caller_warning', 'landing_rejected', 'merge_conflict', 'out_of_scope', 'divergence', 'stale_version'];

export function Collisions() {
  const [err, setErr] = useState('');
  const [rows, setRows] = useState<Collision[] | null>(null);
  const [kind, setKind] = useState('');
  useEffect(() => { api<Collision[]>(`/collisions${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`).then(setRows).catch((e) => setErr(couldNot('collisions', e))); }, [kind]);
  if (err) return <Problem msg={err} />;
  if (!rows) return <p className="dim">loading…</p>;
  return (
    <div className="page">
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="kind">
        <option value="">All kinds</option>
        {KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
      </select>
      {!rows.length ? <p className="dim">No collisions. Nobody has stepped on anyone else's work.</p>
        : rows.map((c) => (
          <div key={c.id} className="card sp" style={{ marginTop: 10, borderLeft: '4px solid var(--accent)' }}>
            <div className="row"><b>{c.kind}</b><span className={`state ${c.outcome === 'open' ? 'st-waiting' : 'st-landed'}`}>{c.outcome}</span></div>
            <div>{c.parties.map((p) => p.person).join(' · ')}</div>
            <div className="dim">{c.region.join(', ')}</div>
            <div>{c.detail}</div>
          </div>))}
    </div>
  );
}
