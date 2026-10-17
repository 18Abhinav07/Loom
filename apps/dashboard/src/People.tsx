import { useEffect, useState } from 'react';
import { api } from './api';
import { GraphView } from './GraphView';
import { agentColor } from './stream';

interface Person { person: string; sessions: number; agents: number; regions: number }
interface Collab { nodes: { person: string }[]; edges: { a: string; b: string; shared: number; collisions: number }[] }

export function People() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [collab, setCollab] = useState<Collab>({ nodes: [], edges: [] });
  useEffect(() => { api<Person[]>('/people').then(setPeople).catch(() => setPeople([])); api<Collab>('/collab').then(setCollab).catch(() => {}); }, []);
  if (!people) return <p className="pad dim">loading…</p>;
  if (!people.length) return <p className="pad dim">No people yet. Everyone who works in this repo with Loom on shows up here.</p>;
  return (
    <div className="pad">
      <table className="grid"><thead><tr><th>Person</th><th>Sessions</th><th>Agents</th><th>Functions touched</th></tr></thead>
        <tbody>{people.map((p) => <tr key={p.person}><td>{p.person}</td><td>{p.sessions}</td><td>{p.agents}</td><td>{p.regions}</td></tr>)}</tbody></table>
      <h3>Who works near whom</h3>
      <div className="collab"><GraphView nodes={collab.nodes.map((n) => ({ id: n.person, qname: n.person }))} edges={collab.edges.map((e) => ({ from: e.a, to: e.b }))}
        node={(id) => ({ color: agentColor(id), size: 12, label: id })}
        edge={(a, b) => ({ color: collab.edges.find((e) => e.a === a && e.b === b)?.collisions ? '#f87171' : '#6b7280', size: 2 })} /></div>
      <p className="dim">A red line means the two have collided on a shared function.</p>
    </div>
  );
}
