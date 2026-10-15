// Story view: the first screen. Without Loom vs with Loom, from bench/results/e1-story.json; nothing drawn that is not in it.
import { useEffect, useState } from 'react';
import { getJson } from './stream';
import { scoreboard, steps, type Pair, type StoryData, type Tile } from './story';

const DELAY = 900;

function Tiles({ label, tiles, broke, n, good, sel, pick }: { label: string; tiles: Tile[]; broke: number; n: number; good: boolean;
  sel: string; pick: (id: string) => void }) {
  return (
    <div className={`board ${good ? 'with' : 'without'}`}>
      <div className="board-head"><span>{label}</span><b>{n ? `${broke} of ${n} broke` : 'not run'}</b></div>
      <div className="tiles">
        {tiles.map((t) => (
          <button key={t.id} title={t.id} className={`tile ${t.state} ${sel === t.id ? 'sel' : ''}`} onClick={() => pick(t.id)}>
            <i>{t.state === 'broke' ? '✕' : t.state === 'ok' ? '✓' : '–'}</i><span>{t.func}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LaneView({ p, side, shown }: { p: Pair; side: 'blind' | 'live'; shown: number }) {
  const ss = steps(p, side);
  return (
    <div className={`lane ${side}`}>
      <h3>{side === 'blind' ? 'Without Loom' : 'With Loom'}</h3>
      {!ss.length ? <p className="dim">not run</p>
        : <ol>{ss.map((s, i) => <li key={i} className={`step ${s.tone} ${i < shown ? 'in' : ''}`}>{s.text}</li>)}</ol>}
    </div>
  );
}

function Raw({ p }: { p: Pair }) {
  const row = (side: 'blind' | 'live') => {
    const l = p[side];
    return l ? Object.entries(l).map(([k, v]) => <tr key={side + k}><td className="dim">{side}.{k}</td><td>{v == null ? '–' : String(v)}</td></tr>) : [];
  };
  return <table className="grid raw"><tbody><tr><td className="dim">instance</td><td>{p.id}</td></tr>
    <tr><td className="dim">mechanism</td><td>{p.mech}</td></tr>{row('blind')}{row('live')}</tbody></table>;
}

interface BenchRun { readOnly?: boolean; state: 'idle' | 'running' | 'done' | 'failed'; set?: string; done?: number; total?: number;
  blindBroke?: number; liveBroke?: number; records?: string; error?: string }

const SETS = [
  { set: 'core', name: 'Core', pairs: 12, time: '~45 min', arg: 'core' },
  { set: 'full', name: 'Full', pairs: 36, time: '~2.5 h', arg: 'all' },
];
const cmd = (arg: string) => `cd bench && .venv/bin/python -m e1.run --set ${arg} --conds blind,live --model sonnet`;

function RunIt({ onWatch }: { onWatch: (run: string) => void }) {
  const [br, setBr] = useState<BenchRun | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const load = () => getJson<BenchRun>('/bench/run').then(setBr).catch(() => {});
    load(); const t = setInterval(load, 4000); return () => clearInterval(t);
  }, []);
  const post = async (path: string, body: unknown) => {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `${r.status}`);
    return j;
  };
  const watch = () => { setMsg('starting the replay…'); post('/demo/replay', {}).then((j) => onWatch(j.run)).catch((e) => setMsg(String(e.message))); };
  const start = (set: string) => {
    let confirm: string | undefined;
    if (set === 'full') { confirm = prompt('Full runs 72 Claude Code sessions (~2.5 h on your subscription). Type "full" to start.') ?? ''; if (confirm !== 'full') return; }
    post('/bench/run', { set, confirm }).then(setBr).catch((e) => setMsg(String(e.message)));
  };
  const running = br?.state === 'running';
  return (
    <section className="runit">
      <div className="card">
        <h3>Watch 3 real agents</h3>
        <p>A recorded run: three Claude Code agents build one feature in parallel on Django. Loom replays it on the Live screen.</p>
        <button className="go" onClick={watch}>▶ Watch</button>
      </div>
      {SETS.map((s) => (
        <div className="card" key={s.set}>
          <h3>Run the bench yourself: {s.name}</h3>
          <p>{s.pairs} task pairs, without and with Loom: {s.pairs * 2} Claude Code sessions, {s.time}. Uses the Claude Code CLI on this machine (the only agent Loom hooks today).</p>
          <code className="cmd">{cmd(s.arg)}</code>
          {br && !br.readOnly && <button className="go" disabled={running} onClick={() => start(s.set)}>Start</button>}
        </div>
      ))}
      {br?.readOnly && <p className="dim">This is a read-only demo server: run the command on your own machine.</p>}
      {br && br.state !== 'idle' && !br.readOnly && (
        <p className="progress">{br.set}: {br.state} · {br.done ?? 0} / {br.total ?? '?'} sessions · without Loom broke {br.blindBroke ?? 0} · with Loom broke {br.liveBroke ?? 0}
          {br.error ? ` · ${br.error}` : ''}</p>
      )}
      {msg && <p className="dim">{msg}</p>}
    </section>
  );
}

export function Story({ onWatch, openBench }: { onWatch: (run: string) => void; openBench: () => void }) {
  const [s, setS] = useState<StoryData | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState('');
  const [shown, setShown] = useState(0);
  const [raw, setRaw] = useState(false);
  const [play, setPlay] = useState(0);
  useEffect(() => {
    getJson<Record<string, unknown>>('/bench').then((b) => {
      const st = b['e1-story'] as StoryData | undefined;
      if (!st) return setErr('No bench story yet: run the bench, then bench/regen.sh.');
      setS(st); const both = st.pairs.filter((p) => p.blind && p.live);   // open on the clearest case: a signature break, then any pair with both lanes
      setSel((both.find((p) => p.mech === 'signature') ?? both[0] ?? st.pairs[0])?.id ?? '');
    }).catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {   // reveal the four steps one by one, both lanes together
    setShown(0);
    let i = 0; const t = setInterval(() => { i++; setShown(i); if (i >= 4) clearInterval(t); }, DELAY);
    return () => clearInterval(t);
  }, [sel, play]);
  const pair = s?.pairs.find((p) => p.id === sel);
  const sb = s && scoreboard(s);
  return (
    <div className="scroll story">
      <section className="hero">
        <h1>Parallel AI agents break each other's code. <em>Loom tells them in time.</em></h1>
        <p className="dim">Same {s?.pairs.length ?? 12} tasks, same breaking changes, same model ({s?.model ? `Claude ${s.model[0].toUpperCase()}${s.model.slice(1)}` : 'Claude'}). The only difference is Loom.</p>
      </section>
      {err && <p className="pad dim">{err}</p>}
      {sb && (
        <section className="boards">
          <Tiles label="Without Loom" tiles={sb.blind} broke={sb.blindBroke} n={sb.blindN} good={false} sel={sel} pick={setSel} />
          <Tiles label="With Loom" tiles={sb.live} broke={sb.liveBroke} n={sb.liveN} good sel={sel} pick={setSel} />
          <p className="dim small">Each tile is one task pair: agent A makes a breaking change, agent B writes code that uses it. Pick one to see what happened.
            {' '}<a href="#" onClick={(e) => { e.preventDefault(); openBench(); }}>data →</a></p>
        </section>
      )}
      {pair && (
        <section className="pair">
          <div className="pair-head"><b>{pair.func}</b><span className="dim">{pair.id}</span>
            <button onClick={() => setPlay((n) => n + 1)}>▶ replay</button>
            <button className={raw ? 'on' : ''} onClick={() => setRaw((r) => !r)}>show data</button></div>
          <div className="lanes2"><LaneView p={pair} side="blind" shown={shown} /><LaneView p={pair} side="live" shown={shown} /></div>
          {raw && <><Raw p={pair} /><p className="dim small">records: <code>{s?.records}</code></p></>}
        </section>
      )}
      <section className="how">
        <h2>How Loom does it</h2>
        <div className="cards">
          <div className="card"><h3>Watch</h3><p>Hooks see every read and edit by every agent, as it happens.</p></div>
          <div className="card"><h3>Connect</h3><p>A live FalkorDB graph knows which code calls which.</p></div>
          <div className="card"><h3>Tell</h3><p>When A changes something B depends on, Loom tells B before B finishes.</p></div>
        </div>
        <p className="dim small">Also: leases stop two agents editing the same function; claims of "done" are checked by tests.</p>
      </section>
      <RunIt onWatch={onWatch} />
    </div>
  );
}
