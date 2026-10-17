type Go = (view: string) => void;
const ITEMS: { view: string; name: string; what: string; how: string }[] = [
  { view: 'plans', name: 'Plans', what: 'A plan splits one goal into tasks. Each task owns its files and gets its own agent. Plans are files in .loom/plans/.', how: 'The Lead writes them; “Check plan” verifies that no two tasks own the same code before a team starts.' },
  { view: 'teams', name: 'Team', what: 'The live view of one plan running: every agent, who holds which function, who waits, what landed.', how: 'On the Team page you see the with-Loom run. Agents land onto a shared branch only when the plan’s test passes.' },
  { view: 'lead', name: 'Lead', what: 'A Claude session that reads the repo, writes the plan and starts the team. Its chat is the Plan popup on Home.', how: 'From a terminal: loom lead.' },
  { view: 'functions', name: 'Code Map', what: 'The repo as regions (functions) in a FalkorDB graph: what calls what, and who is editing it now.', how: 'loom init indexes every file once; every agent edit re-indexes that file through a hook; loom sync re-reads edits made outside agents.' },
  { view: 'collisions', name: 'Loom Log', what: 'Every refused edit, wait, warning and send-back, with sessions and people.', how: 'Read from the same graph the agents use.' },
];
export function Beta({ go }: { go: Go }) {
  return (
    <section className="screen on page">
      <h2 className="pgtitle reveal">Beta</h2>
      <p className="pgsub reveal">The StaleBench run is the tested product. Everything below is built and working in our runs, but still under testing on other projects, so it can break.</p>
      <div className="card sp reveal" style={{ marginBottom: 14 }}>
        <div className="h">Using Loom on another project</div>
        <p style={{ margin: '6px 0 0' }}>Run <code>loom init</code> in any folder. It makes a git repo if there is none, indexes the code, installs the hooks and starts the dashboard and the Lead. Empty folders work: regions appear as agents write code. Not benchmarked beyond StaleBench.</p>
      </div>
      <div className="stack">
        {ITEMS.map((i) => (
          <div key={i.name} className="card sp reveal">
            <div className="row" style={{ gap: 10, alignItems: 'center' }}><b>{i.name}</b><span className="chipr chipw">beta</span><span className="sp" /><button className="btn ghost sm" onClick={() => go(i.view)}>Open {i.name} →</button></div>
            <p style={{ margin: '6px 0 0' }}>{i.what}</p><p className="dim" style={{ margin: '4px 0 0' }}>{i.how}</p>
          </div>))}
      </div>
    </section>
  );
}
