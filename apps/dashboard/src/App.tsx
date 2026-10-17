import { useEffect, useState } from 'react';
import { Bench } from './Bench';
import { Home } from './Home';
import { Lead } from './Lead';
import { Plans } from './Plans';
import { Teams } from './Teams';

export const VIEWS = ['home', 'lead', 'plans', 'teams', 'sessions', 'people', 'collisions', 'functions', 'growth', 'bench'] as const;
export type View = typeof VIEWS[number];
const title = (v: string) => v[0].toUpperCase() + v.slice(1);
const initial = (): View => { const v = new URLSearchParams(location.search).get('view') ?? ''; return (VIEWS as readonly string[]).includes(v) ? v as View : 'home'; };

/** Screens not built yet render here, so the rail never links to a blank page. */
const Soon = ({ v }: { v: View }) => <p className="pad dim">{title(v)} is not available yet.</p>;

export function App() {
  const [view, setView] = useState<View>(initial);
  useEffect(() => {
    const q = new URLSearchParams(location.search); q.set('view', view);
    history.replaceState(null, '', `?${q}`);
  }, [view]);
  const go = (v: string) => setView((VIEWS as readonly string[]).includes(v) ? v as View : 'home');
  return (
    <div className="app rail">
      <nav className="side">
        <b className="brand pad">Loom</b>
        {VIEWS.map((v) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{title(v)}</button>)}
      </nav>
      <main>
        {view === 'home' ? <Home go={go} /> : view === 'bench' ? <Bench /> : view === 'lead' ? <Lead /> : view === 'plans' ? <Plans go={go} />
          : view === 'teams' ? <Teams /> : <Soon v={view} />}
      </main>
    </div>
  );
}
