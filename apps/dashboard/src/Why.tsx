// Why view: for a symbol (id, qname or file:line), each change as a hop chain decision → task → agent → change → commit.
import { useState } from 'react';
import { agentColor, getJson } from './stream';

interface Chain {
  decision?: { id: string; text: string }; task?: { id: string; title: string }; agent: string;
  change: { kind: string; before: string; after: string; at: number }; commit?: { sha: string; message: string };
}

export function Why({ run }: { run: string }) {
  const [target, setTarget] = useState(new URLSearchParams(location.search).get('target') ?? '');
  const [r, setR] = useState<{ symbol: string; chains: Chain[]; missing: string[] } | null>(null);
  const [err, setErr] = useState('');
  const go = (e?: React.FormEvent) => {
    e?.preventDefault(); setErr('');
    if (target.trim()) getJson<any>(`/why?run=${encodeURIComponent(run)}&target=${encodeURIComponent(target.trim())}`).then(setR).catch((x) => setErr(String(x)));
  };
  return (
    <div className="scroll pad">
      <form onSubmit={go} className="row"><input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="symbol, e.g. pkg/m.py::f or pkg/m.py:12" /><button>why?</button></form>
      {err && <p className="dim">{err}</p>}
      {r && (r.missing.includes('symbol') ? <p className="dim">No symbol matches <code>{r.symbol}</code>.</p>
        : !r.chains.length ? <p className="dim">No agent changed <code>{r.symbol}</code> in this run.</p>
        : r.chains.map((c, i) => (
          <div key={i} className="chain">
            {c.decision ? <span className="hop">decision <b>{c.decision.text}</b></span> : <span className="hop dim">no decision recorded</span>}
            {c.task && <span className="hop">task <b>{c.task.id}</b> {c.task.title}</span>}
            <span className="hop"><span className="dot" style={{ background: agentColor(c.agent) }} />agent <b>{c.agent}</b></span>
            <span className="hop">{c.change.kind} <code>{c.change.before}</code> → <code>{c.change.after}</code></span>
            {c.commit ? <span className="hop">commit <code>{c.commit.sha.slice(0, 8)}</code> {c.commit.message}</span> : <span className="hop dim">not committed</span>}
          </div>)))}
    </div>
  );
}
