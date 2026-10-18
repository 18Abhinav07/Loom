import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { api, post, type Team } from './api';
import { agentColor, useRun } from './stream';
import { Bot } from './ui';

interface Hit { id: string; path: string | null }
interface Story { id: string; path: string; versions: { id: string; by: string | null; task: string | null; decision: string | null; commit: string | null; at: number }[]; collisions: { id: string; kind: string }[] }
interface Fn { id: string; name: string }

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : './');
const fileOf = (p: string) => (p ?? '').split('/').pop() ?? p;
const fnName = (id: string) => (id ?? '').split('::')[1] ?? id;

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
  const [filter, setFilter] = useState<'all' | 'locked' | 'changed' | 'hot'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [openFn, setOpenFn] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [story, setStory] = useState<Story | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  useEffect(() => { setAll(null); (demo ? demoHits() : api<Hit[]>('/regions?q=::definition&limit=5000')).then(setAll).catch(() => setAll([])); }, [demo]);
  useEffect(() => {
    if (demo) return;
    const pull = () => api<Team[]>('/teams').then((t) => { const lm = t.filter((x) => !x.blind); setTeam(lm.find((x) => x.state === 'running') ?? lm[0] ?? null); }).catch(() => {});
    pull(); const i = setInterval(pull, 4000); return () => clearInterval(i);
  }, [demo]);
  const run = useRun(team?.id ?? null, 2000);
  const live = !!team && team.state === 'running';
  const lease = useMemo(() => new Map(run.snap.leases.map((l) => [l.symbol, l.agent])), [run.snap.leases]);
  const changed = useMemo(() => new Set(run.snap.changed ?? []), [run.snap.changed]);
  const waits = useMemo(() => new Map((run.snap.waits ?? []).map((w) => [w.symbol, w.agent])), [run.snap.waits]);
  const callers = useMemo(() => { const m = new Map<string, string[]>(); for (const e of run.snap.edges) (m.get(e.to) ?? m.set(e.to, []).get(e.to)!).push(e.from); return m; }, [run.snap.edges]);
  const callees = useMemo(() => { const m = new Map<string, string[]>(); for (const e of run.snap.edges) (m.get(e.from) ?? m.set(e.from, []).get(e.from)!).push(e.to); return m; }, [run.snap.edges]);

  const files = useMemo(() => {
    const m = new Map<string, Fn[]>();
    for (const h of all ?? []) {
      const p = h.path ?? h.id.split('::')[0];
      (m.get(p) ?? m.set(p, []).get(p)!).push({ id: h.id, name: fnName(h.id) });
    }
    return m;
  }, [all]);
  const fileLocks = (p: string) => (files.get(p) ?? []).filter((f) => lease.has(f.id));
  const fileChanged = (p: string) => (files.get(p) ?? []).some((f) => changed.has(f.id));
  const heat = (p: string) => (files.get(p) ?? []).reduce((n, f) => n + (callers.get(f.id)?.length ?? 0), 0);
  const needle = q.trim().toLowerCase();
  const hit = (p: string) => {
    const textOk = !needle || p.toLowerCase().includes(needle) || (files.get(p) ?? []).some((f) => f.name.toLowerCase().includes(needle));
    const f = filter === 'all' || (filter === 'locked' && fileLocks(p).length > 0) || (filter === 'changed' && fileChanged(p)) || (filter === 'hot' && heat(p) >= 2);
    return textOk && f;
  };
  const dirs = useMemo(() => {
    const d = new Map<string, string[]>();
    for (const p of files.keys()) (d.get(dirOf(p)) ?? d.set(dirOf(p), []).get(dirOf(p))!).push(p);
    return [...d.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.sort((a, b) => a.localeCompare(b))] as const);
  }, [files]);
  const nameOf = (id: string) => team?.agents.find((a) => a.id === id)?.title ?? id;
  const lockOf = (p: string) => fileLocks(p)[0];
  const color = (id: string) => agentColor(id);

  if (all && !all.length) return (
    <div className="page"><div className="card sp"><b>No code mapped yet.</b><p className="dim">The Code Map is built from the repo's committed code. This repo has none the map can read. Commit a scaffold (files with function stubs), then run <code>loom init</code>; every function becomes a node here.</p></div></div>);

  const pick = (p: string, fn?: string) => { setOpen(p); setOpenFn(fn ?? null); setExpanded(new Set()); setStory(null); if (fn && !demo) api<Story>(`/regions/${encodeURIComponent(fn)}`).then(setStory).catch(() => {}); };
  const fns = open ? files.get(open) ?? [] : [];
  const touched = (f: Fn) => lease.has(f.id) || changed.has(f.id) || f.id === openFn || waits.has(f.id);
  const row = (f: Fn) => {
    const holder = lease.get(f.id); const ch = changed.has(f.id); const w = waits.get(f.id);
    return (
      <button key={f.id} className={`rrow${holder ? ' lk' : ch ? ' ch' : ''}${f.id === openFn ? ' sel' : ''}`} style={holder ? { ['--c' as string]: color(holder) } : undefined} onClick={() => pick(open!, f.id)}>
        <span className="bar" /><span className="nm">{f.name}()</span>
        <span style={{ display: 'flex' }}>
          {holder && <span className="st" style={{ color: color(holder) }}><Bot color={color(holder)} size={18} />{nameOf(holder)} editing</span>}
          {!holder && ch && <span className="st" style={{ color: 'var(--accent-d)' }}>changed this run</span>}
          {w && <span className="st" style={{ color: 'var(--wait-d)', marginLeft: 8 }}>{nameOf(w)} waiting</span>}
        </span>
      </button>);
  };
  const rows = () => {
    const out: React.ReactElement[] = []; let runOf: Fn[] = [];
    const flush = (k: string) => {
      if (!runOf.length) return;
      if (expanded.has(k) || runOf.length < 3) out.push(...runOf.map(row));
      else out.push(<button key={k} className="rmore" onClick={() => setExpanded(new Set(expanded).add(k))}>··· {runOf.length} untouched functions</button>);
      runOf = [];
    };
    fns.forEach((f, i) => { if (touched(f)) { flush(`m${i}`); out.push(row(f)); } else runOf.push(f); });
    flush('end'); return out;
  };
  const holders = open ? [...new Set(fileLocks(open).map((f) => lease.get(f.id)!))] : [];
  const summary = !open ? '' : holders.length > 1 ? `${holders.map(nameOf).join(' and ')} are both working in this file right now, on different functions, so neither blocks the other.`
    : holders.length ? `${nameOf(holders[0])} is editing ${fileLocks(open).map((f) => f.name + '()').join(', ')} here. The rest of the file is free for other agents.`
    : fileChanged(open) ? 'Changed this run, and nobody is editing it now.' : live || team ? 'Nobody has touched this file this run.' : 'No team is running. Every function here is free.';
  const cur = openFn ? fns.find((f) => f.id === openFn) : undefined;
  const curHolder = openFn ? lease.get(openFn) : undefined;
  const chip = (k: typeof filter, label: string) => <button className={`chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{label}</button>;
  const mini = (ids: string[]) => ids.map((id) => <span key={id} className="mini">{fnName(id)}() <span style={{ color: 'var(--ink3)' }}>{fileOf(id.split('::')[0])}</span></span>);

  return (
    <div className="page">
      <div className="card howto">
        <div className="step"><i>1</i><span><b>Each tile is a file.</b> Bigger tiles hold more functions.</span></div>
        <div className="step"><i>2</i><span><b>Colour shows who is in it.</b> A coloured tile is locked by that agent right now.</span></div>
        <div className="step"><i>3</i><span><b>Open a file</b>, then a function, to see who calls it and what happened to it.</span></div>
      </div>
      <div className="active">
        {!team || !live ? <div className="card achip" style={{ cursor: 'default', color: 'var(--ink2)' }}>No team running. Every file is free.</div>
          : team.agents.map((a) => {
            const h = [...lease.entries()].find(([, ag]) => ag === a.id); const w = (run.snap.waits ?? []).find((x) => x.agent === a.id);
            const txt = a.state === 'landed' || a.state === 'done' ? 'finished, nothing locked' : w ? `waiting for ${fnName(w.symbol)}()` : h ? `editing ${fnName(h[0])}() in ${h[0].split('::')[0]}` : 'reading the code';
            return (
              <div key={a.id} className="card achip" onClick={() => { const t = h?.[0] ?? w?.symbol; if (t) pick(t.split('::')[0], t); }}>
                <Bot color={color(a.id)} size={28} /><span><b>{a.title}</b> · {txt}</span>
              </div>);
          })}
      </div>
      <div className="maphead">
        <label className="search">
          <svg width="16" height="16" fill="none" stroke="#9A988F" strokeWidth="2"><circle cx="7" cy="7" r="5" /><path d="M11 11l4 4" /></svg>
          <input aria-label="search functions" placeholder="Find a file or function…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="chips">{chip('all', 'All files')}{chip('locked', 'Being edited now')}{chip('changed', 'Changed this run')}{chip('hot', 'Most depended on')}</div>
        {live && <span className="livetag"><i className="ldot" />updates live</span>}
      </div>
      {all && filter !== 'all' && ![...files.keys()].some(hit) && <p className="dim" style={{ margin: '4px 0 10px' }}>{{ locked: live ? 'Nobody is editing a function right now.' : 'No team is running, so nothing is being edited.', changed: 'No function has changed in this run yet.', hot: 'No function has two or more callers in this run yet.' }[filter]}</p>}
      {!all ? <p className="dim">loading…</p> : (
        <div className="map">
          <div className="card tree">
            {dirs.map(([d, ps]) => (
              <div key={d} className="dir">
                <div className="dn"><span>{d}</span><span>{ps.length} file{ps.length === 1 ? '' : 's'}</span></div>
                <div className="tiles">
                  {ps.map((p) => {
                    const lk = lockOf(p); const holder = lk ? lease.get(lk.id) : undefined; const n = files.get(p)!.length;
                    return (
                      <button key={p} data-testid="tile" style={{ width: Math.max(96, Math.min(190, 70 + n * 14)), ...(holder ? { ['--c' as string]: color(holder) } : {}) }}
                        className={`tile${holder ? ' locked' : fileChanged(p) ? ' changed' : ''}${open === p ? ' sel' : ''}${hit(p) ? '' : ' dim'}`} onClick={() => pick(p)}>
                        {fileOf(p)}<small>{n} function{n === 1 ? '' : 's'}</small>
                        {holder && <span className="who"><Bot color={color(holder)} size={18} /></span>}
                      </button>);
                  })}
                </div>
              </div>))}
            <div className="tlegend" style={{ marginTop: 12 }}>
              <span><i style={{ background: '#F3F1EA' }} />free</span><span><i style={{ background: '#F9EEE8' }} />changed this run</span><span><i style={{ background: 'color-mix(in srgb,var(--accent) 30%,#fff)', border: '1.5px solid var(--accent)' }} />locked by an agent</span>
            </div>
          </div>
          <div className="card detail">
            {!open ? <div className="empty">Open a file to see its functions.</div> : (
              <>
                <div className="h">File</div>
                <div className="fhead" style={{ marginTop: 4 }}>{open}</div>
                <div className="fsum">{fns.length} functions and classes. {summary}</div>
                {demo && <p className="dim">Recorded run: function history is only kept for real repos.</p>}
                <div className="rlist">{rows()}</div>
                {cur && (
                  <div className="rinfo">
                    <h4 className="mono" style={{ fontSize: 16 }}>{cur.name}()</h4>
                    <div className="rstatus" style={{ background: curHolder ? `color-mix(in srgb,${color(curHolder)} 12%,#fff)` : changed.has(cur.id) ? 'var(--accent-soft)' : 'var(--line2)' }}>
                      {curHolder ? <><Bot color={color(curHolder)} size={28} /><span><b>{nameOf(curHolder)}</b> is editing this right now. Any other agent that wants it will wait{waits.has(cur.id) ? <>, and <b>{nameOf(waits.get(cur.id)!)}</b> is waiting for it now</> : ''}.</span></>
                        : changed.has(cur.id) ? <span>Changed this run and landed. Nobody holds it now.</span> : <span>Free. Nobody is editing it.</span>}
                    </div>
                    <div className="rsec"><div className="h">Called by · {(callers.get(cur.id) ?? []).length}</div>
                      {(callers.get(cur.id) ?? []).length ? <><div>{mini(callers.get(cur.id)!)}</div><p>If this function’s arguments change, Loom warns whoever owns these and checks every one of them before the change can land.</p></> : <p>Nothing else calls this, so changing it can’t break anyone.</p>}
                    </div>
                    {(callees.get(cur.id) ?? []).length > 0 && <div className="rsec"><div className="h">Calls</div>{mini(callees.get(cur.id)!)}</div>}
                    <div className="rsec"><div className="h">This run</div>
                      {story && story.versions.length ? <ol>{story.versions.map((v) => <li key={v.id}><b>{v.by ?? 'someone'}</b> {v.commit && <code>{v.commit}</code>}{v.decision && <div>Why: {v.decision}</div>}</li>)}</ol> : <p>No recorded changes to this function yet.</p>}
                      {story && story.collisions.length > 0 && <p className="bad">Collided {story.collisions.length}×: {story.collisions.map((c) => c.kind).join(', ')}</p>}
                    </div>
                  </div>)}
              </>)}
          </div>
        </div>)}
    </div>
  );
}
