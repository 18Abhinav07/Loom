import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, repoCwd, type Team } from './api';
import { Bench } from './Bench';
import { Collisions } from './Collisions';
import { Functions } from './Functions';
import { Growth } from './Growth';
import { Home } from './Home';
import { Lead } from './Lead';
import { People } from './People';
import { Plans } from './Plans';
import { Sessions } from './Sessions';
import { Teams } from './Teams';

export const VIEWS = ['home', 'lead', 'plans', 'teams', 'sessions', 'people', 'collisions', 'functions', 'growth', 'bench'] as const;
export type View = typeof VIEWS[number];

/** The top bar has one tab per job; Code Map and Loom Log each hold several of the real screens. */
const TABS: { id: string; label: string; views: readonly View[] }[] = [
  { id: 'home', label: 'Home', views: ['home'] },
  { id: 'lead', label: 'Lead', views: ['lead'] },
  { id: 'plans', label: 'Plans', views: ['plans'] },
  { id: 'teams', label: 'Team', views: ['teams'] },
  { id: 'map', label: 'Code Map', views: ['functions', 'growth'] },
  { id: 'log', label: 'Loom Log', views: ['collisions', 'sessions', 'people'] },
  { id: 'bench', label: 'Benchmark', views: ['bench'] },
];
const SUB: Record<View, string> = { functions: 'Functions', growth: 'Growth', collisions: 'Collisions', sessions: 'Sessions', people: 'People', home: '', lead: '', plans: '', teams: '', bench: '' };
const initial = (): View => { const v = new URLSearchParams(location.search).get('view') ?? ''; return (VIEWS as readonly string[]).includes(v) ? v as View : 'home'; };
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

export function App() {
  const [view, setView] = useState<View>(initial);
  const [cwd, setCwd] = useState('');
  const [say, setSay] = useState('');
  const [live, setLive] = useState(false);
  const [demo, setDemo] = useState(() => new URLSearchParams(location.search).get('demo') === '1');
  const bar = useRef<HTMLElement>(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });
  useEffect(() => {
    const q = new URLSearchParams(location.search); q.set('view', view); if (demo) q.set('demo', '1'); else q.delete('demo');
    history.replaceState(null, '', `?${q}`);
  }, [view, demo]);
  useEffect(() => {
    repoCwd().then(setCwd);
    const poll = () => api<Team[]>('/teams').then((t) => setLive(t.some((x) => x.state === 'running'))).catch(() => setLive(false));
    poll(); const t = setInterval(poll, 4000); return () => clearInterval(t);
  }, []);
  const go = (v: string, text = '') => { setSay(text); setView((VIEWS as readonly string[]).includes(v) ? v as View : 'home'); };
  const tab = TABS.find((t) => t.views.includes(view))!;
  useLayoutEffect(() => {
    const measure = () => { const el = bar.current?.querySelector<HTMLElement>('.tab.on'); if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth }); };
    measure();
    document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [view, live]);
  const newTeam = () => { go('home'); setTimeout(() => document.getElementById('askbox')?.focus(), 50); };
  return (
    <>
      <header className="top">
        <div className="brand"><svg width="26" height="26" viewBox="0 0 26 26" fill="none"><path d="M4 7h18M4 13h18M4 19h18" stroke="#D9D6CB" strokeWidth="2" strokeLinecap="round" /><path d="M8 4v18M13 4v18M18 4v18" stroke="#D97757" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 2" /></svg>Loom</div>
        {demo ? <div className="proj" title="a recording, not your repo">demo <b>recorded run</b></div> : cwd && <div className="proj" title={cwd}>repo <b>{base(cwd)}</b></div>}
        <nav className="tabs" ref={bar}>
          <div className="tabpill" style={pill} />
          {TABS.map((t) => (
            <button key={t.id} className={`tab ${t.id === tab.id ? 'on' : ''}`} onClick={() => setView(t.views[0])}>
              {t.id === 'teams' && live && <span className="ldot" />}{t.label}
            </button>))}
        </nav>
        <div className="spacer" />
        <button className={`btn ghost ${demo ? 'on' : ''}`} aria-pressed={demo} onClick={() => { setDemo(!demo); setView('home'); }}>{demo ? 'Exit demo' : 'Demo'}</button>
        <button className="btn or" onClick={newTeam}>+ New team</button>
      </header>
      <main>
        {demo && view !== 'home' && <div className="card sp" style={{ marginBottom: 14 }}><b>Demo is on.</b> Home plays a recorded run on a different codebase. This screen shows the real data of <b>{base(cwd) || 'this repo'}</b>, which is why the agents differ. <button className="btn ghost sm" onClick={() => setDemo(false)}>Exit demo</button></div>}
        {tab.views.length > 1 && (
          <div className="subtabs">{tab.views.map((v) => <button key={v} className={`chip ${v === view ? 'on' : ''}`} onClick={() => setView(v)}>{SUB[v]}</button>)}</div>)}
        {view === 'home' ? <Home go={go} demo={demo} /> : view === 'bench' ? <Bench /> : view === 'lead' ? <Lead say={say} /> : view === 'plans' ? <Plans go={go} />
          : view === 'teams' ? <Teams go={go} /> : view === 'sessions' ? <Sessions /> : view === 'people' ? <People /> : view === 'collisions' ? <Collisions />
          : view === 'functions' ? <Functions /> : <Growth />}
      </main>
    </>
  );
}
