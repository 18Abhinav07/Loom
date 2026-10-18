import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, repoCwd, type Team } from './api';
import { Bench } from './Bench';
import { Beta } from './Beta';
import { Blind } from './Blind';
import { Collisions } from './Collisions';
import { Functions } from './Functions';
import { Growth } from './Growth';
import { Home, STALEBENCH_ASK } from './Home';
import { Lead } from './Lead';
import { People } from './People';
import { Plans } from './Plans';
import { Sessions } from './Sessions';
import { Teams } from './Teams';

export const VIEWS = ['home', 'beta', 'lead', 'plans', 'teams', 'sessions', 'people', 'collisions', 'functions', 'growth', 'bench', 'blind'] as const;
export type View = typeof VIEWS[number];

/** The top bar has one tab per job; Code Map and Loom Log each hold several of the real screens. */
const TABS: { id: string; label: string; views: readonly View[] }[] = [
  { id: 'home', label: 'Home', views: ['home'] },
  { id: 'teams', label: 'Team', views: ['teams'] },
  { id: 'blind', label: 'Without Loom', views: ['blind'] },
  { id: 'bench', label: 'Benchmark', views: ['bench'] },
  { id: 'beta', label: 'Beta', views: ['beta', 'plans', 'lead', 'functions', 'growth', 'collisions', 'sessions', 'people'] },
];
const SUB: Record<View, string> = { beta: 'Docs', plans: 'Plans', lead: 'Lead', functions: 'Code Map', growth: 'Growth', collisions: 'Loom Log', sessions: 'Sessions', people: 'People', home: '', teams: '', bench: '', blind: '' };
const initial = (): View => { const v = new URLSearchParams(location.search).get('view') ?? ''; return (VIEWS as readonly string[]).includes(v) ? v as View : 'home'; };
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

export function App() {
  const [view, setView] = useState<View>(initial);
  const [cwd, setCwd] = useState('');
  const [say, setSay] = useState('');
  const [live, setLive] = useState(false);
  const [hasBlind, setHasBlind] = useState(false);
  const [chat, setChat] = useState(false);
  const bar = useRef<HTMLElement>(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });
  useEffect(() => {
    const q = new URLSearchParams(location.search); q.set('view', view); q.delete('demo');
    history.replaceState(null, '', `?${q}`);
  }, [view]);
  useEffect(() => {
    repoCwd().then(setCwd);
    const poll = () => api<Team[]>('/teams').then((t) => { setLive(t.some((x) => x.state === 'running' && !x.blind)); setHasBlind(t.some((x) => x.blind)); }).catch(() => setLive(false));
    poll(); const t = setInterval(poll, 4000); return () => clearInterval(t);
  }, []);
  const go = (v: string, text = '') => { setSay(text); setView((VIEWS as readonly string[]).includes(v) ? v as View : 'home'); };
  const tabs = TABS.filter((t) => t.id !== 'blind' || hasBlind || view === 'blind');   // the Without Loom tab exists only once that team has been started
  const tab = tabs.find((t) => t.views.includes(view))!;
  useLayoutEffect(() => {
    const measure = () => { const el = bar.current?.querySelector<HTMLElement>('.tab.on'); if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth }); };
    measure();
    document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [view, live, hasBlind]);
  const newTeam = () => setChat(true);
  return (
    <>
      <header className="top">
        <div className="brand"><svg width="26" height="26" viewBox="0 0 26 26" fill="none"><path d="M4 7h18M4 13h18M4 19h18" stroke="#D9D6CB" strokeWidth="2" strokeLinecap="round" /><path d="M8 4v18M13 4v18M18 4v18" stroke="#D97757" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 2" /></svg>Loom</div>
        {cwd && <div className="proj" title={cwd}>repo <b>{base(cwd)}</b></div>}
        <nav className="tabs" ref={bar}>
          <div className="tabpill" style={pill} />
          {tabs.map((t) => (
            <button key={t.id} className={`tab ${t.id === tab.id ? 'on' : ''}`} onClick={() => setView(t.views[0])}>
              {t.id === 'teams' && live && <span className="ldot" />}{t.label}
            </button>))}
        </nav>
        <div className="spacer" />
        <button className="btn or" onClick={newTeam}>Plan</button>
      </header>
      <main>
        {tab.views.length > 1 && (
          <div className="subtabs">{tab.views.map((v) => <button key={v} className={`chip ${v === view ? 'on' : ''}`} onClick={() => setView(v)}>{SUB[v]}</button>)}</div>)}
        {view === 'home' ? <Home go={go} plan={newTeam} /> : view === 'beta' ? <Beta go={go} /> : view === 'bench' ? <Bench /> : view === 'blind' ? <Blind go={go} /> : view === 'lead' ? <Lead say={say} /> : view === 'plans' ? <Plans go={go} />
          : view === 'teams' ? <Teams go={go} /> : view === 'sessions' ? <Sessions /> : view === 'people' ? <People /> : view === 'collisions' ? <Collisions go={go as never} newTeam={newTeam} />
          : view === 'functions' ? <Functions demo={false} /> : <Growth />}
      </main>
      {chat && (
        <div className="modalbg" onClick={() => setChat(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 50, display: 'grid', placeItems: 'center' }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: 'min(760px, 94vw)', height: 'min(640px, 88vh)', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
            <div className="row" style={{ padding: '10px 14px', alignItems: 'center', borderBottom: '1px solid var(--line, #ddd)' }}><b>Plan with the Lead</b><span className="spacer" style={{ flex: 1 }} /><button className="btn ghost sm" onClick={() => setChat(false)}>Close</button></div>
            <iframe title="Lead" src={`/lead?cwd=${encodeURIComponent(cwd)}&say=${encodeURIComponent(STALEBENCH_ASK)}`} style={{ flex: 1, border: 0, width: '100%' }} />
          </div>
        </div>)}
    </>
  );
}
