import { useEffect, useState } from 'react';
import { api, type Team } from './api';
import { ago, person } from './explain';
import { Bot } from './ui';

// The lead chat is the daemon's own page (it holds the machine token and the permission prompts); this screen frames it.
// `say` pre-fills its message box (the Home prompt hands its text over this way).
export function Lead({ say = '' }: { say?: string }) {
  const [teams, setTeams] = useState<Team[]>([]);
  useEffect(() => { api<Team[]>('/teams').then(setTeams).catch(() => {}); }, []);
  const led = teams.filter((t) => t.leadSid).sort((a, b) => b.startedAt - a.startedAt);
  return (
    <section className="screen on page">
      <div className="card sp reveal" style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 14 }}>
        <Bot color="#D97757" size={52} />
        <div style={{ flex: 1 }}>
          <div className="h">The Lead</div>
          <p style={{ margin: '4px 0 0' }}>The Lead is the Claude session that reads this repo, splits your goal into a plan, and starts one agent per task. It runs in your terminal, and its chat shows up below once it is running.</p>
          <p style={{ margin: '6px 0 0' }}><span className="dim">Start it in this repo:</span> <code>loom lead</code></p>
          <p className="dim" style={{ margin: '6px 0 0' }}>{led.length ? `Teams a Lead started here: ${led.map((t) => `${t.plan} (${person(t.person)}, ${ago(t.startedAt)})`).join(' · ')}` : 'No team in this repo was started by a Lead yet. Teams started from a plan file have no Lead session.'}</p>
        </div>
      </div>
      <div className="lead-frame">
        <iframe title="Lead" src={say ? `/lead?say=${encodeURIComponent(say)}` : '/lead'} />
      </div>
    </section>
  );
}
