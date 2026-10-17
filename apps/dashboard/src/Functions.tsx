import { useEffect, useState } from 'react';
import { api } from './api';

interface Hit { id: string; path: string | null }
interface Story { id: string; path: string; versions: { id: string; by: string | null; task: string | null; decision: string | null; commit: string | null; at: number }[]; collisions: { id: string; kind: string }[] }

export function Functions() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [story, setStory] = useState<Story | null>(null);
  const [all, setAll] = useState<Hit[] | null>(null);
  useEffect(() => { api<Hit[]>('/regions?q=::definition').then(setAll).catch(() => setAll([])); }, []);
  useEffect(() => { if (!q.trim()) return setHits([]); api<Hit[]>(`/regions?q=${encodeURIComponent(q.trim())}`).then(setHits).catch(() => setHits([])); }, [q]);
  return (
    <div className="page">
      <input aria-label="search functions" placeholder="Search a function or file" value={q} onChange={(e) => setQ(e.target.value)} className="search" />
      <div className="two">
        <div>
          {!q.trim() ? (all && !all.length ? <div className="card sp"><b>No code mapped yet.</b><p className="dim">The Code Map is built from the repo's committed code. This repo has none the map can read. Commit a scaffold (files with function stubs), then run <code>loom init</code>; every function becomes a node here.</p></div>
            : <><p className="dim">{all ? `${all.length}${all.length >= 30 ? '+' : ''} functions mapped. Pick one, or search.` : 'loading…'}</p>{(all ?? []).map((h) => <button key={h.id} className="listbtn" onClick={() => api<Story>(`/regions/${encodeURIComponent(h.id)}`).then(setStory).catch(() => {})}>{h.id.replace(/::definition#\d+$/, '').replace('::', ' · ')}</button>)}</>) : !hits.length ? <p className="dim">No function matches.</p>
            : hits.map((h) => <button key={h.id} className="listbtn" onClick={() => api<Story>(`/regions/${encodeURIComponent(h.id)}`).then(setStory).catch(() => {})}>{h.id}</button>)}
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
