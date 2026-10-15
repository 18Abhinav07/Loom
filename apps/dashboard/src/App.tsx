import { useEffect, useState } from 'react';
import { Story } from './StoryView';
import { Live } from './Live';
import { Plan } from './Plan';
import { Timeline } from './Timeline';
import { Why } from './Why';
import { Verify } from './Verify';
import { Bench } from './Bench';
import { fetchRuns, useRun } from './stream';

const fromUrl = () => new URLSearchParams(location.search);
const DATA = ['plan', 'timeline', 'why', 'verify', 'bench'] as const;
const VIEWS = ['story', 'live', ...DATA] as const;
type View = typeof VIEWS[number];
const title = (v: string) => v[0].toUpperCase() + v.slice(1);

export function App() {
  const [runs, setRuns] = useState<string[]>([]);
  const [run, setRun] = useState<string | null>(fromUrl().get('run'));
  const [view, setView] = useState<View>((VIEWS as readonly string[]).includes(fromUrl().get('view') ?? '') ? fromUrl().get('view') as View : 'story');
  useEffect(() => {
    const load = () => fetchRuns().then((rs) => { setRuns(rs); setRun((r) => r ?? rs[rs.length - 1] ?? null); }).catch(() => {});
    load(); const t = setInterval(load, 5000); return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(); if (run && view !== 'story') q.set('run', run); q.set('view', view);
    history.replaceState(null, '', `?${q}`);
  }, [run, view]);
  const st = useRun(view === 'story' ? null : run);
  const isData = (DATA as readonly string[]).includes(view);
  const watch = (r: string) => { setRuns((rs) => (rs.includes(r) ? rs : [...rs, r])); setRun(r); setView('live'); };
  return (
    <div className="app">
      <header>
        <b className="brand">Loom</b>
        <nav>
          {(['story', 'live'] as const).map((v) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{title(v)}</button>)}
          <select className={`datasel ${isData ? 'on' : ''}`} value={isData ? view : ''} onChange={(e) => e.target.value && setView(e.target.value as View)}>
            <option value="">Data ▾</option>
            {DATA.map((v) => <option key={v} value={v}>{title(v)}</option>)}
          </select>
        </nav>
        {view !== 'story' && (
          <select value={run ?? ''} onChange={(e) => setRun(e.target.value || null)} title="run">
            {!runs.length && <option value="">no runs loaded</option>}
            {runs.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        {view !== 'story' && <span className={`live ${st.live ? 'up' : ''}`}>{st.live ? '● live' : '○ offline'}</span>}
      </header>
      {isData && (
        <div className="banner">Data view: the raw record.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); setView('story'); }}>For the visual story, open Story →</a></div>
      )}
      {view === 'story' ? <Story onWatch={watch} openBench={() => setView('bench')} />
        : view === 'bench' ? <Bench />
        : !run ? <p className="pad dim">No run loaded. Start one with <code>loom up</code> and <code>loom run --plan</code>, or open Story → Watch 3 real agents.</p>
        : view === 'live' ? <Live st={st} /> : view === 'plan' ? <Plan run={run} />
        : view === 'timeline' ? <Timeline run={run} /> : view === 'why' ? <Why run={run} /> : <Verify run={run} />}
    </div>
  );
}
