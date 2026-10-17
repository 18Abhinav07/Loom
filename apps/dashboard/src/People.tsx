import { useEffect, useState } from 'react';
import { api, couldNot } from './api';
import { Avatar, Empty, Problem, PageHead } from './ui';
import { GraphView } from './GraphView';
import { agentColor } from './stream';
import { person } from './explain';

interface Person { person: string; sessions: number; agents: number; regions: number }
interface Collab { nodes: { person: string }[]; edges: { a: string; b: string; shared: number; collisions: number }[] }

export function People() {
  const [err, setErr] = useState('');
  const [people, setPeople] = useState<Person[] | null>(null);
  const [collab, setCollab] = useState<Collab>({ nodes: [], edges: [] });
  useEffect(() => { api<Person[]>('/people').then(setPeople).catch((e) => setErr(couldNot('people', e))); api<Collab>('/collab').then(setCollab).catch(() => {}); }, []);
  const head = <PageHead title="People" what="Everyone who has worked in this repo with Loom on, how much Claude work they ran, and who works on the same functions." />;
  if (err) return <div className="page">{head}<Problem msg={err} /></div>;
  if (!people) return <div className="page">{head}<p className="dim">loading…</p></div>;
  if (!people.length) return <div className="page">{head}<Empty>No people yet. Everyone who works in this repo with Loom on shows up here.</Empty></div>;
  const active = people.filter((p) => p.sessions || p.agents || p.regions);
  const rest = people.filter((p) => !(p.sessions || p.agents || p.regions));
  const max = Math.max(...people.map((p) => p.regions), 1);
  const card = (p: Person) => (
    <div key={p.person} className="card pcard">
      <Avatar name={person(p.person)} size={40} />
      <div className="pbody"><b>{person(p.person)}</b>
        <div className="pstats"><span><b>{p.sessions}</b> sessions</span><span><b>{p.agents}</b> agents</span><span><b>{p.regions}</b> functions</span></div>
        <div className="gbar"><i style={{ width: `${p.regions / max * 100}%`, background: agentColor(person(p.person)) }} /></div>
      </div>
    </div>);
  const edges = collab.edges.filter((e) => e.shared || e.collisions);
  return (
    <div className="page">
      {head}
      <h3>Working in Loom</h3>
      {active.length ? <div className="pgrid">{active.map(card)}</div> : <p className="dim">Nobody has run a Claude session here with Loom on yet.</p>}
      {rest.length > 0 && <details className="card sp" style={{ marginTop: 14 }}><summary><b>{rest.length} other commit authors</b> <span className="dim">from git history, no Loom activity</span></summary><div className="pgrid" style={{ marginTop: 10 }}>{rest.map(card)}</div></details>}
      <div className="card sp" style={{ marginTop: 14 }}>
        <h3>Who works near whom</h3>
        {edges.length ? <>
          <div className="collab"><GraphView nodes={collab.nodes.map((n) => ({ id: n.person, qname: person(n.person) }))} edges={edges.map((e) => ({ from: e.a, to: e.b }))}
            node={(id) => ({ color: agentColor(person(id)), size: 12, label: person(id) })}
            edge={(a, b) => ({ color: edges.find((e) => e.a === a && e.b === b)?.collisions ? '#C4554D' : '#9A988F', size: 2 })} /></div>
          <p className="dim" style={{ fontSize: 12 }}>A line joins two people who changed the same functions. Red means their changes collided.</p></>
          : <p className="dim">No two people have touched the same functions yet. When they do, a line joins them here, red if they collided.</p>}
      </div>
    </div>
  );
}
