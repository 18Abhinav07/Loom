import { useEffect, useState } from 'react';
import { api } from './api';

interface Hit { id: string; path: string | null }
interface Story { id: string; path: string; versions: { id: string; by: string | null; task: string | null; decision: string | null; commit: string | null; at: number }[]; collisions: { id: string; kind: string }[] }

export function Functions() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [story, setStory] = useState<Story | null>(null);
  useEffect(() => { if (!q.trim()) return setHits([]); api<Hit[]>(`/regions?q=${encodeURIComponent(q.trim())}`).then(setHits).catch(() => setHits([])); }, [q]);
  return (
    <div className="pad">
      <input aria-label="search functions" placeholder="Search a function or file" value={q} onChange={(e) => setQ(e.target.value)} className="search" />
      <div className="split2">
        <div>
          {!q.trim() ? <p className="dim">Type a function or file name to see its story.</p> : !hits.length ? <p className="dim">No function matches.</p>
            : hits.map((h) => <button key={h.id} className="srow" onClick={() => api<Story>(`/regions/${encodeURIComponent(h.id)}`).then(setStory).catch(() => {})}>{h.id}</button>)}
        </div>
        <div>{story && (
          <>
            <h3>{story.path}</h3>
            <ol>{story.versions.map((v) => <li key={v.id}><b>{v.by ?? 'someone'}</b> {v.commit && <code>{v.commit}</code>}
              {v.decision && <div>Why: {v.decision}</div>}</li>)}</ol>
            {story.collisions.length > 0 && <p className="bad">Collided {story.collisions.length}×: {story.collisions.map((c) => c.kind).join(', ')}</p>}
          </>)}</div>
      </div>
    </div>
  );
}
