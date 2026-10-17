import { useEffect, useState } from 'react';
import { api, type Collision } from './api';

const KINDS = ['lock_denied', 'lock_wait', 'caller_warning', 'landing_rejected', 'merge_conflict', 'out_of_scope', 'divergence', 'stale_version'];

export function Collisions() {
  const [rows, setRows] = useState<Collision[] | null>(null);
  const [kind, setKind] = useState('');
  useEffect(() => { api<Collision[]>(`/collisions${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`).then(setRows).catch(() => setRows([])); }, [kind]);
  if (!rows) return <p className="pad dim">loading…</p>;
  return (
    <div className="pad">
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="kind">
        <option value="">All kinds</option>
        {KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
      </select>
      {!rows.length ? <p className="dim">No collisions. Nobody has stepped on anyone else's work.</p>
        : rows.map((c) => (
          <div key={c.id} className="card">
            <div className="row"><b>{c.kind}</b><span className={`state ${c.outcome === 'open' ? '' : 'active'}`}>{c.outcome}</span></div>
            <div>{c.parties.map((p) => p.person).join(' · ')}</div>
            <div className="dim">{c.region.join(', ')}</div>
            <div>{c.detail}</div>
          </div>))}
    </div>
  );
}
