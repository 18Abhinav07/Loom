import { useEffect, useMemo, useState } from 'react';
import { api, post } from './api';

interface Hit { id: string; path: string | null }
interface Story { id: string; path: string; versions: { id: string; by: string | null; task: string | null; decision: string | null; commit: string | null; at: number }[]; collisions: { id: string; kind: string }[] }
interface Fn { id: string; name: string }

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : './');
const fileOf = (p: string) => p.split('/').pop() ?? p;
const fnName = (id: string) => id.split('::')[1] ?? id;

/** The repo as tiles: one per file, grouped by folder, sized by how many functions it holds. Open a file to see its functions. */
interface Snap { nodes: { id: string; file: string; qname: string; kind: string }[] }
/** Demo mode: the code the recorded run worked on, read from the replay's own snapshot. */
async function demoHits(): Promise<Hit[]> {
  const runs = await api<string[]>('/runs').catch(() => [] as string[]);
  let run = runs.filter((r) => r.startsWith('coord:replay')).pop();
  if (!run) run = (await post<{ run: string }>('/demo/replay', { speed: 3, maxGapMs: 1200 })).run;
  for (let i = 0; i < 20; i++) {
    const snap = await api<Snap>(`/snapshot?run=${encodeURIComponent(run)}`);
    const fns = snap.nodes.filter((n) => n.kind === 'function');
    if (fns.length) return fns.map((n) => ({ id: `${n.file}::${n.qname}::definition#0`, path: n.file }));
    await new Promise((r) => setTimeout(r, 500));
  }
  return [];
}

export function Functions({ demo = false }: { demo?: boolean }) {
  const [all, setAll] = useState<Hit[] | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'name' | 'size'>('name');
  const [open, setOpen] = useState<string | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  useEffect(() => { setAll(null); (demo ? demoHits() : api<Hit[]>('/regions?q=::definition&limit=5000')).then(setAll).catch(() => setAll([])); }, [demo]);

  const files = useMemo(() => {
    const m = new Map<string, Fn[]>();
    for (const h of all ?? []) {
      const p = h.path ?? h.id.split('::')[0];
      (m.get(p) ?? m.set(p, []).get(p)!).push({ id: h.id, name: fnName(h.id) });
    }
    return m;
  }, [all]);
  const needle = q.trim().toLowerCase();
  const hit = (p: string) => !needle || p.toLowerCase().includes(needle) || (files.get(p) ?? []).some((f) => f.name.toLowerCase().includes(needle));
  const dirs = useMemo(() => {
    const d = new Map<string, string[]>();
    for (const p of files.keys()) (d.get(dirOf(p)) ?? d.set(dirOf(p), []).get(dirOf(p))!).push(p);
    const order = (a: string, b: string) => (sort === 'size' ? (files.get(b)!.length - files.get(a)!.length) || a.localeCompare(b) : a.localeCompare(b));
    return [...d.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.sort(order)] as const);
  }, [files, sort]);

  if (all && !all.length) return (
    <div className="page"><div className="card sp"><b>No code mapped yet.</b><p className="dim">The Code Map is built from the repo's committed code. This repo has none the map can read. Commit a scaffold (files with function stubs), then run <code>loom init</code>; every function becomes a node here.</p></div></div>);

  const fns = open ? files.get(open) ?? [] : [];
  return (
    <div className="page">
      <div className="card howto reveal">
        <div className="step"><i>1</i><span><b>Each tile is a file.</b> Its second line is how many functions it holds.</span></div>
        <div className="step"><i>2</i><span><b>Open a file</b> to list its functions.</span></div>
        <div className="step"><i>3</i><span><b>Open a function</b> to read who changed it, why, and any collisions.</span></div>
      </div>
      <div className="maphead">
        <label className="search">
          <svg width="16" height="16" fill="none" stroke="#9A988F" strokeWidth="2"><circle cx="7" cy="7" r="5" /><path d="M11 11l4 4" /></svg>
          <input aria-label="search functions" placeholder="Find a file or function…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="chips">
          <button className={`chip${sort === 'name' ? ' on' : ''}`} onClick={() => setSort('name')}>A to Z</button>
          <button className={`chip${sort === 'size' ? ' on' : ''}`} onClick={() => setSort('size')}>Most functions</button>
        </div>
      </div>
      {!all ? <p className="dim">loading…</p> : (
        <div className="map">
          <div className="card tree">
            {dirs.map(([d, ps]) => (
              <div key={d} className="dir">
                <div className="dn"><span>{d}</span><span>{ps.length} file{ps.length === 1 ? '' : 's'}</span></div>
                <div className="tiles">
                  {ps.map((p) => (
                    <button key={p} className={`tile${open === p ? ' sel' : ''}${hit(p) ? '' : ' dim'}`} data-testid="tile" onClick={() => { setOpen(p); setStory(null); }}>
                      {fileOf(p)}<small>{files.get(p)!.length} function{files.get(p)!.length === 1 ? '' : 's'}</small>
                    </button>))}
                </div>
              </div>))}
          </div>
          <div className="card detail">
            {!open ? <div className="empty">Open a file to see its functions.</div> : (
              <>
                <div className="fhead">{open}</div>
                {demo && <p className="dim">Recorded run: function history is only kept for real repos.</p>}
                <div className="rlist">
                  {fns.filter((f) => !needle || f.name.toLowerCase().includes(needle) || open.toLowerCase().includes(needle)).map((f) => (
                    <button key={f.id} className="listbtn" onClick={() => { if (!demo) api<Story>(`/regions/${encodeURIComponent(f.id)}`).then(setStory).catch(() => {}); }}>{f.name}</button>))}
                </div>
                {story && (
                  <div style={{ marginTop: 14 }}>
                    <h3>{fnName(story.id)}</h3>
                    {story.versions.length ? <ol>{story.versions.map((v) => <li key={v.id}><b>{v.by ?? 'someone'}</b> {v.commit && <code>{v.commit}</code>}{v.decision && <div>Why: {v.decision}</div>}</li>)}</ol>
                      : <p className="dim">No recorded changes to this function yet.</p>}
                    {story.collisions.length > 0 && <p className="bad">Collided {story.collisions.length}×: {story.collisions.map((c) => c.kind).join(', ')}</p>}
                  </div>)}
              </>)}
          </div>
        </div>)}
    </div>
  );
}
