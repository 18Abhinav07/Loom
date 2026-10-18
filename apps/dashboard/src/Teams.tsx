import { Scorecard } from './Score';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, couldNot, post, type Collision, type Team, type TeamAgent } from './api';
import { agentColor, useRun, type LoomEvent, type Snapshot } from './stream';
import { ago, filesText, landText, startedBy } from './explain';
import { Bot, Problem } from './ui';

const WORKING = new Set(['running', 'pending']);
export type Face = 'idle' | 'working' | 'waiting' | 'landing' | 'sentback' | 'landed';
export const FACE_TEXT: Record<Face, string> = { idle: 'Starting', working: 'Working', waiting: 'Waiting', landing: 'Being checked', sentback: 'Sent back', landed: 'Landed' };
export const lastLand = (a: TeamAgent) => a.lands[a.lands.length - 1];
export function face(a: TeamAgent, waiting: boolean): Face {
  if (a.state === 'landed') return 'landed';
  if (a.state === 'failed' || a.state === 'stopped' || a.state === 'blocked') return 'sentback';
  if (waiting) return 'waiting';
  if (a.lands.length && lastLand(a) !== 'landed') return 'sentback';
  if (a.state === 'idle') return 'landing';
  return a.state === 'pending' ? 'idle' : 'working';
}

const KIND: Record<string, [string, string, string]> = {
  lock_wait: ['wait', '⏸', 'Made to wait'], lock_denied: ['wait', '⏸', 'Edit refused'], caller_warning: ['notice', '✉️', 'Warned about a caller'],
  landing_rejected: ['back', '↩️', 'Sent back'], merge_conflict: ['back', '↩️', 'Merge conflict'], out_of_scope: ['back', '↩️', 'Out of scope'],
  divergence: ['notice', '✉️', 'Diverged'], stale_version: ['notice', '✉️', 'Stale version'],
};
const KC: Record<string, string> = { lock: 'var(--accent)', wait: 'var(--wait)', notice: 'var(--blue-d)', land: 'var(--good)', back: 'var(--bad)' };

// ---- the floor: files as boxes, functions as rows, agents sitting on what they hold -----------------------------------------
interface Reg { id: string; n: string; x: number; y: number; w: number; h: number; file: string }
interface FileBox { name: string; x: number; y: number; w: number; h: number }
const nice = (q?: string | null) => `${(q ?? '').split(/[.:]/).pop() || q || 'a function'}()`;

function layout(s: Snapshot, hot: Set<string>) {
  const byFile = new Map<string, Snapshot['nodes']>();
  for (const n of s.nodes) if (n.file) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
  const score = (f: string) => (byFile.get(f) ?? []).filter((n) => hot.has(n.id)).length;
  const files = [...byFile.keys()].sort((a, b) => score(b) - score(a) || a.localeCompare(b)).slice(0, 6);
  const cols = [{ x: 40, w: 300, y: 18 }, { x: 450, w: 320, y: 18 }];
  const boxes: FileBox[] = []; const regs: Record<string, Reg> = {};
  for (const f of files) {
    const all = byFile.get(f)!;
    const nodes = [...all.filter((n) => hot.has(n.id)), ...all.filter((n) => !hot.has(n.id))].slice(0, 6);
    const c = cols[0].y <= cols[1].y ? cols[0] : cols[1];
    const h = 44 + nodes.length * 32;
    boxes.push({ name: f, x: c.x, y: c.y, w: c.w, h });
    nodes.forEach((n, i) => { regs[n.id] = { id: n.id, n: nice(n.qname), x: c.x + 12, y: c.y + 34 + i * 32, w: c.w - 24, h: 26, file: f }; });
    c.y += h + 16;
  }
  return { boxes, regs, height: Math.max(220, Math.max(cols[0].y, cols[1].y) + 6) };
}
const edgePath = (A: Reg, B: Reg) => {
  const ay = A.y + 13, by = B.y + 13;
  if (A.x === B.x) { const x = A.x - 2; return `M${x},${ay} C${x - 34},${ay} ${x - 34},${by} ${x},${by}`; }
  const [sx, ex] = A.x > B.x ? [A.x, B.x + B.w] : [A.x + A.w, B.x]; const mx = (sx + ex) / 2;
  return `M${sx},${ay} C${mx},${ay} ${mx},${by} ${ex},${by}`;
};

interface Co { id: number; x: number; y: number; text: string; kind: string; out: boolean }

function Floor({ snap, agents, collisions, goMap }: { snap: Snapshot; agents: TeamAgent[]; collisions: Collision[]; goMap: () => void }) {
  const leased = useMemo(() => new Map(snap.leases.map((l) => [l.symbol, l.agent])), [snap.leases]);
  const changed = useMemo(() => new Set(snap.changed ?? []), [snap.changed]);
  const waits = snap.waits ?? [];
  const hot = useMemo(() => new Set([...leased.keys(), ...changed, ...waits.map((w) => w.symbol)]), [leased, changed, waits]);
  const L = useMemo(() => layout(snap, hot), [snap, hot]);
  const [cos, setCos] = useState<Co[]>([]);
  const seen = useRef<Set<string> | null>(null); const lastLeases = useRef<Map<string, string> | null>(null); const n = useRef(0); const armed = useRef(false);
  const pop = (reg: Reg | undefined, text: string, kind: string) => {
    if (!reg) return;
    const id = ++n.current;
    setCos((c) => [...c.slice(-4), { id, x: reg.x + reg.w / 2, y: reg.y, text, kind, out: false }]);
    setTimeout(() => setCos((c) => c.map((x) => (x.id === id ? { ...x, out: true } : x))), 3600);
    setTimeout(() => setCos((c) => c.filter((x) => x.id !== id)), 4200);
  };
  useEffect(() => {   // a callout for every new lock and every new thing Loom did
    if (armed.current) for (const [sym, who] of leased) if (lastLeases.current?.get(sym) !== who) pop(L.regs[sym], `${who} locked just this function`, 'lock');
    lastLeases.current = new Map(leased);
    if (L.boxes.length) armed.current = true;   // the first picture is the starting state, not news
  }, [leased]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ids = new Set(collisions.map((c) => c.id));
    if (seen.current) for (const c of collisions) if (!seen.current.has(c.id)) {
      const [k, , label] = KIND[c.kind] ?? ['notice', '', c.kind];
      pop(c.region.map((r) => L.regs[r]).find(Boolean), label, k);
    }
    seen.current = ids;
  }, [collisions]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!L.boxes.length) return (
    <div className="empty" style={{ padding: '34px 18px', textAlign: 'center', color: 'var(--ink3)', fontSize: 13 }}>
      Nothing is being edited yet. As soon as an agent takes a function, its file and the code around it appear here.
    </div>);
  const callers = new Set(snap.edges.filter((e) => changed.has(e.to) && !changed.has(e.from) && !leased.has(e.from)).map((e) => e.from + '>' + e.to));
  const pos = new Map<string, [number, number]>();
  const occupied = new Map<string, number>();
  for (const a of agents) {
    const w = waits.find((x) => x.agent === a.id); const held = snap.leases.find((l) => l.agent === a.id);
    const r = L.regs[(held ?? w)?.symbol ?? ''];
    if (!r) continue;
    const k = occupied.get(r.id) ?? 0; occupied.set(r.id, k + 1);
    pos.set(a.id, w && !held ? [r.x + r.w - 70 - k * 44, r.y + 50] : [r.x + r.w - 16 - k * 36, r.y + 13]);
  }
  const H = L.height;
  return (
    <div className="gwrap">
      <svg className="graph" viewBox={`0 0 800 ${H}`} role="img" aria-label="Who is working where">
        {L.boxes.map((f) => <g key={f.name}><rect className="fbox" x={f.x} y={f.y} width={f.w} height={f.h} rx={12} /><text className="fname" x={f.x + 12} y={f.y + 21}>{f.name}</text></g>)}
        <g>{snap.edges.filter((e) => L.regs[e.from] && L.regs[e.to]).map((e) => <path key={e.from + e.to} className={`call ${callers.has(e.from + '>' + e.to) ? 'hot' : ''}`} d={edgePath(L.regs[e.from], L.regs[e.to])} />)}</g>
        {Object.values(L.regs).map((r) => {
          const who = leased.get(r.id); const c = who ? agentColor(who) : '';
          return (
            <g key={r.id} className="pill" transform={`translate(${r.x},${r.y})`} onClick={goMap}>
              <rect width={r.w} height={r.h} rx={7} style={{ fill: who ? c + '26' : changed.has(r.id) ? '#FBF1EC' : '', stroke: who ? c : '' }} />
              <text x={10} y={17}>{r.n}{who ? '  🔒' : ''}</text>
            </g>);
        })}
        <g>{waits.map((w) => { const p = pos.get(w.agent); const r = L.regs[w.symbol]; return p && r ? <path key={w.agent} className="waitl" d={`M${p[0]},${p[1]} L${r.x + r.w - 20},${r.y + 26}`} /> : null; })}</g>
        <g>{agents.map((a) => {
          const p = pos.get(a.id); if (!p) return null; const col = agentColor(a.id);
          return (
            <g key={a.id} className="anode" style={{ transform: `translate(${p[0]}px,${p[1]}px)` }}>
              <line x1={0} y1={-10} x2={0} y2={-15} stroke={col} strokeWidth={1.6} /><circle cy={-16} r={2.2} fill={col} />
              <rect x={-12} y={-10} width={24} height={20} rx={7} fill={col} stroke="#fff" strokeWidth={2} /><rect x={-8} y={-6} width={16} height={11} rx={4} fill="#232220" />
              <circle cx={-3.5} cy={-0.5} r={1.8} fill={col} /><circle cx={3.5} cy={-0.5} r={1.8} fill={col} />
              <text className="ntag" x={-18} y={4} textAnchor="end" fill={col}>{a.id}</text>
            </g>);
        })}</g>
      </svg>
      <div className="callouts">{cos.map((c) => <div key={c.id} className={`co co-${c.kind} ${c.out ? 'out' : ''}`} style={{ left: `${(c.x / 800) * 100}%`, top: `${(c.y / H) * 100}%` }}>{c.text}</div>)}</div>
    </div>);
}

// ---- landing checks ------------------------------------------------------------------------------------------------------------
export function checksOf(a: TeamAgent): { cells: ('ok' | 'no' | 'run' | '')[]; res: string; color: string; why: string; tries: number } {
  const l = lastLand(a); const tries = a.lands.length;
  if (a.state === 'landed' || l === 'landed') return { cells: ['ok', 'ok', 'ok'], res: 'Landed', color: 'var(--good)', why: '', tries };
  if (!l) return { cells: a.state === 'idle' ? ['run', '', ''] : ['', '', ''], res: a.state === 'idle' ? 'Being checked…' : 'Not finished yet', color: 'var(--ink3)', why: '', tries };
  const cells: ('ok' | 'no' | '')[] = l === 'merge_conflict' || l === 'out_of_scope' ? ['no', '', ''] : l === 'contract_break' ? ['ok', 'no', ''] : ['ok', 'ok', 'no'];
  return { cells, res: 'Sent back', color: 'var(--bad)', why: landText(l), tries };
}

// ---- drawer ----------------------------------------------------------------------------------------------------------------------
interface Item { kind: 'say' | 'tool'; text: string }
function Drawer({ team, a, snap, cols, onClose, refresh }: { team: Team; a: TeamAgent | undefined; snap: Snapshot; cols: Collision[]; onClose: () => void; refresh: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState(''); const [note, setNote] = useState(''); const [held, setHeld] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const id = a?.id;
  useEffect(() => {
    if (!id) return;
    let live = true;
    const load = () => api<{ items: Item[] }>(`/teams/${team.id}/history?agent=${encodeURIComponent(id)}`).then((r) => live && setItems(r.items)).catch(() => {});
    load(); const t = setInterval(load, 2000);
    return () => { live = false; clearInterval(t); };
  }, [id, team.id]);
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight }); }, [items.length]);
  const send = async (t: string) => { try { await post(`/teams/${team.id}/message`, { agent: id, text: t }); setNote(''); refresh(); } catch (e) { setNote((e as Error).message); } };
  useEffect(() => { if (held && a && a.state !== 'running') { void send(held); setHeld(null); } }, [a?.state, held]);   // eslint-disable-line react-hooks/exhaustive-deps
  const c = id ? agentColor(id) : '#999';
  const waiting = !!a && (snap.waits ?? []).some((w) => w.agent === a.id);
  const notices = snap.notices.filter((n) => n.agent === id || n.author === id);
  const mine = a ? cols.filter((x) => x.parties.some((p) => p.session === a.sid)) : [];
  const wt = (a as (TeamAgent & { worktree?: string }) | undefined)?.worktree;
  return (
    <>
      <div className={`scrim ${a ? 'on' : ''}`} onClick={onClose} />
      <aside className={`drawer ${a ? 'on' : ''}`} style={{ '--c': c } as never} aria-hidden={!a}>
        {a && <>
          <div className="dhead">
            <Bot color={c} size={46} mode={WORKING.has(a.state) ? 'm-work' : ''} />
            <div style={{ flex: 1 }}><div className="agname">{a.id}</div><div className="agtask">{a.title}</div></div>
            <span className={`state st-${face(a, waiting)}`} style={{ marginLeft: 0 }}>{FACE_TEXT[face(a, waiting)]}</span>
            <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <div className="dbody" ref={body}>
            <div className="lmsg"><div className="k">Task</div>{a.title}{a.after.length > 0 && <> · starts after {a.after.join(', ')}</>}</div>
            {!items.length && <div className="dim" style={{ fontSize: 13 }}>No transcript yet. This fills in as the agent works.</div>}
            {items.map((x, i) => x.kind === 'say'
              ? <div key={i} className="msg agent">{x.text}</div>
              : <div key={i} className="tool"><span className="t">›</span>{x.text}</div>)}
            {notices.map((n) => <div key={n.id} className="lmsg n"><div className="k">Loom warned {n.agent}{n.author && n.author !== n.agent ? ` about ${n.author}'s change` : ''} · {n.status}</div>{n.text}</div>)}
            {mine.map((x) => { const [k, , label] = KIND[x.kind] ?? ['notice', '', x.kind]; return <div key={x.id} className={`lmsg ${k === 'wait' ? 'w' : k === 'back' ? 'b' : 'n'}`}><div className="k">{label} · {ago(x.at)}</div>{filesText(x.region)}{x.detail ? ` — ${x.detail}` : ''}</div>; })}
            {a.lands.map((l, i) => <div key={i} className={`lmsg ${l === 'landed' ? '' : 'b'}`}><div className="k">Attempt {i + 1}</div>{landText(l)}</div>)}
            {held && <div className="lmsg w"><div className="k">Waiting to send</div>“{held}” goes out when {a.id} is idle.</div>}
          </div>
          <div style={{ padding: '12px 22px 18px', borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea aria-label="message to agent" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${a.id}…`} style={{ width: '100%', resize: 'none' }} />
            <div className="cardrow">
              <button className="btn sm" disabled={!text.trim()} onClick={() => { void send(text.trim()); setText(''); }}>Send now · interrupts</button>
              <button className="btn ghost sm" disabled={!text.trim()} onClick={() => { if (a.state === 'running') setHeld(text.trim()); else void send(text.trim()); setText(''); }}>Send when it’s idle</button>
              <span className="spacer" />
              <button className="btn ghost sm" onClick={() => post(`/teams/${team.id}/stop-agent`, { agent: a.id }).then(refresh).catch((e) => setNote(e.message))}>Stop</button>
              <button className="btn ghost sm" onClick={() => post(`/teams/${team.id}/restart-agent`, { agent: a.id }).then(refresh).catch((e) => setNote(e.message))}>Restart</button>
            </div>
            {note && <p className="bad" style={{ margin: 0 }}>{note}</p>}
            {wt && <div className="dim" style={{ fontSize: 11.5, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>cd {wt}</div>}
          </div>
        </>}
      </aside>
    </>);
}


// ---- agent-to-agent messages: what one agent's change told another, as stored in the FalkorDB graph --------------------------
const EVL: Record<string, string> = {
  'notice.created': 'told', 'notice.delivered': 'delivered to', 'notice.resolved': 'resolved by', 'lease.granted': 'locked', 'lease.denied': 'was refused', 'lease.released': 'released',
};
function Messages({ snap, events }: { snap: Snapshot; events: LoomEvent[] }) {
  const notices = [...snap.notices].reverse();
  const flow = events.filter((e) => EVL[e.type]).slice(-12).reverse();
  const sym = (q: string) => nice(snap.nodes.find((n) => n.id === q)?.qname ?? q);
  return (
    <div className="card sp reveal msgs">
      <div className="h">Agent messages <span className="chipr" style={{ '--c': 'var(--accent)' } as never}>FalkorDB</span></div>
      <div className="expl">When one agent changes code another depends on, Loom writes a notice into the shared graph and delivers it to the other agent before it finishes.</div>
      {!notices.length && !flow.length && <div className="emptyfeed">No messages yet. They appear when one agent changes a function another agent calls.</div>}
      {notices.map((n) => (
        <div key={n.id} className={`msg ${n.status}`}>
          <div className="mh"><b>{n.author || 'an agent'}</b><span className="arrow">→</span><b>{n.agent}</b><span className={`mst ${n.status}`}>{n.status}</span></div>
          {n.text && <pre>{n.text.length > 420 ? n.text.slice(0, 420) + '…' : n.text}</pre>}
        </div>))}
      {flow.length > 0 && <div className="flow"><div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', margin: '10px 0 4px' }}>Event stream</div>
        {flow.map((e, i) => <div key={i} className="ev"><span className="dim">{ago(e.at)}</span> <b>{e.agent ?? 'loom'}</b> {EVL[e.type]}{(e.data?.symbols as string[] | undefined)?.length ? <> <code>{(e.data.symbols as string[]).map(sym).join(', ')}</code></> : null}</div>)}</div>}
    </div>);
}

// ---- the screen ------------------------------------------------------------------------------------------------------------------
export function Teams({ go }: { go?: (v: string) => void }) {
  const [raw, setTeams] = useState<Team[] | null>(null);
  const teams = useMemo(() => raw && raw.filter((t) => !t.blind), [raw]);   // this page is the with-Loom side; Home shows the without-Loom team
  const [allCols, setAllCols] = useState<Collision[]>([]);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');
  const [open, setOpen] = useState('');
  const [all, setAll] = useState(''); const [tellOpen, setTellOpen] = useState(false);
  const refresh = () => {
    api<Team[]>('/teams').then((t) => { setErr(''); setTeams(t); }).catch((e) => setErr(couldNot('teams', e)));
    api<Collision[]>('/collisions').then((c) => setAllCols(c)).catch(() => {});
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, []);
  const newest = useMemo(() => [...(teams ?? [])].sort((a, b) => b.startedAt - a.startedAt), [teams]);
  const current = (teams ?? []).find((t) => t.id === pick) ?? newest.find((t) => t.state === 'running') ?? newest[0];
  const cols = useMemo(() => {
    const m = new Map<string, Collision>();
    for (const c of [...allCols.filter((c) => !current || c.at >= current.startedAt), ...(current?.events ?? [])]) m.set(c.id, c);
    return [...m.values()].sort((a, b) => b.at - a.at);
  }, [allCols, current]);   // only what happened during this team's run
  const run = useRun(current?.id ?? null, 1500);
  if (err) return <Problem msg={err} />;
  if (!teams) return <p className="dim">loading…</p>;
  if (!current) return (
    <section className="screen on page"><div className="card onboard reveal"><Bot color="#9A988F" size={56} /><h3>No team running</h3><p>Describe the work to the Lead, review the tasks, then start the team. You will watch every agent here.</p>
      <div className="cardrow" style={{ justifyContent: 'center' }}><button className="btn or" onClick={() => go?.('lead')}>Plan with the Lead</button><button className="btn ghost" onClick={() => go?.('plans')}>Review plans</button></div></div></section>);
  const snap = run.snap;
  const agents = current.agents;
  const waitingIds = new Set((snap.waits ?? []).map((w) => w.agent));
  const landed = agents.filter((a) => a.state === 'landed').length;
  const n = agents.length;
  const rejected = agents.reduce((s, a) => s + a.lands.filter((l) => l !== 'landed').length, 0);
  const warned = Math.max(snap.notices.length, cols.filter((c) => c.kind === 'caller_warning').length);
  const stat = (v: number, k: string) => <div className="stat"><div className="v">{v}</div><div className="k">{k}</div></div>;
  const stop = () => post(`/teams/${current.id}/stop`).then(refresh).catch((e) => setErr(String(e.message ?? e)));
  const tellAll = () => { const t = all.trim(); if (!t) return; Promise.all(agents.map((a) => post(`/teams/${current.id}/message`, { agent: a.id, text: t }).catch(() => null))).then(() => { setAll(''); setTellOpen(false); refresh(); }); };
  const feed = cols.slice(0, 30);
  return (
    <section className="screen on">
      <div className="card tstrip reveal">
        <div className="tname"><b>{current.plan}{current.blind ? ' · without Loom' : ''}</b><small>{landed} of {n} tasks landed</small><div className="prog"><i style={{ width: `${n ? (landed / n) * 100 : 0}%` }} /></div></div>
        {stat(snap.leases.length, 'functions locked now')}
        {stat(waitingIds.size, 'agents waiting')}
        {stat(warned, 'warnings sent')}
        {stat(rejected, 'breaks caught')}
        <div className="spacer" />
        {current.state === 'done' && <div className="done-banner on">{current.result ? (current.result.pass ? `✓ Team finished · tests pass on ${current.landed || 'the shared branch'}` : '✕ Team finished · tests FAIL on the shared branch') : `✓ Team finished · ${landed} of ${n} on the shared branch`}</div>}
        {teams.length > 1 && <select aria-label="team" value={current.id} onChange={(e) => setPick(e.target.value)}>{newest.map((t) => <option key={t.id} value={t.id}>{t.plan}{t.blind ? ' (no Loom)' : ''} · {t.state}</option>)}</select>}
        {current.state === 'running' && <>
          <button className="btn ghost" onClick={() => setTellOpen((o) => !o)}>Message all agents</button>
          <button className="btn ghost" onClick={stop}>Stop team</button>
        </>}
      </div>
      {tellOpen && <div className="card sp reveal" style={{ marginBottom: 16 }}><div className="cardrow"><input autoFocus aria-label="message to all agents" value={all} onChange={(e) => setAll(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && tellAll()} placeholder="Tell every agent…" /><button className="btn sm" disabled={!all.trim()} onClick={tellAll}>Send to all</button></div></div>}
      <p className="pgsub reveal" style={{ marginBottom: 14 }}>{current.goal} <span className="dim">· started {ago(current.startedAt)} by {startedBy(current)}</span></p>
      <Scorecard t={current} extra={current.blind ? [] : [{ k: 'warnings sent', v: warned }, { k: 'functions locked now', v: snap.leases.length }, { k: 'Loom events', v: cols.length }]} />
      <div className="team">
        <div className="agents">
          {agents.map((a) => {
            const f = face(a, waitingIds.has(a.id)); const c = agentColor(a.id);
            const held = snap.leases.filter((l) => l.agent === a.id).map((l) => snap.nodes.find((x) => x.id === l.symbol));
            const w = (snap.waits ?? []).find((x) => x.agent === a.id);
            const wn = w && snap.nodes.find((x) => x.id === w.symbol);
            const holder = w && snap.leases.find((l) => l.symbol === w.symbol)?.agent;
            return (
              <div key={a.id} className={`card ag ${f}`} style={{ '--c': c } as never} data-testid="agent-card" onClick={() => setOpen(a.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(a.id)}>
                <div className="aghead">
                  <div className="botw"><Bot color={c} size={50} mode={f === 'working' ? 'm-work' : ''} /><span className="badge">{f === 'landed' ? '✓' : '!'}</span></div>
                  <div><div className="agname">{a.id}</div><div className="agtask">{a.title}</div></div>
                  <span className={`state st-${f}`}>{FACE_TEXT[f]}</span>
                </div>
                <div className="agbody">
                  <div className="kv2"><span>Now</span><span>{f === 'landed' ? 'Done: its work is on the shared branch' : f === 'sentback' ? (a.lands.length ? landText(lastLand(a)) : `Stopped (${a.state})`) : f === 'waiting' && wn ? <>Wants <code>{nice(wn.qname)}</code> next</> : a.lastReply ? a.lastReply.slice(0, 90) : 'Reading the task'}</span></div>
                  {held.length > 0 && <div className="kv2"><span>Editing</span><span>{held.map((x, i) => x && <span key={i} className="chipr">🔒 {nice(x.qname)}</span>)}</span></div>}
                  {a.after.length > 0 && f === 'idle' && <div className="kv2"><span>After</span><span>{a.after.map((x) => <span key={x} className="chipr chipw">{x}</span>)}</span></div>}
                  {w && wn && <div className="kv2"><span>Waiting</span><span><span className="chipr chipw">{nice(wn.qname)}</span> {holder ? <>held by <b>{holder}</b></> : <b style={{ color: 'var(--good)' }}>free now, resuming next</b>}</span></div>}
                  <div className="term"><span className="p">›</span> {a.lastReply ? a.lastReply.split('\n')[0] : a.state === 'pending' ? 'waiting for its turn' : 'claude -p · working'}{f !== 'landed' && <span className="cur" />}</div>
                  <div className="open"><span>Click to see its full history and chat</span><span>→</span></div>
                </div>
              </div>);
          })}
        </div>
        <div>
          <div className="card graphcard reveal">
            <div className="row"><div className="h">Who is working where</div><span style={{ fontSize: 12, color: 'var(--ink3)' }}>Boxes are files · rows are functions · click one to open the Code Map</span></div>
            <div className="gkey">
              <span><svg width="22" height="16"><rect x="1" y="2" width="20" height="12" rx="4" fill="#F7E4DB" stroke="#D97757" /></svg>an agent is editing it</span>
              <span><svg width="22" height="16"><rect x="1" y="2" width="20" height="12" rx="4" fill="#FBEFE9" stroke="#EBC9B9" /></svg>changed this run</span>
              <span><svg width="26" height="8"><path d="M1 4h24" stroke="#C99619" strokeWidth="2" strokeDasharray="5 4" /></svg>waiting for it</span>
              <span><svg width="26" height="8"><path d="M1 4h24" stroke="#DCD9CE" strokeWidth="1.5" /></svg>calls</span>
              <span><svg width="26" height="8"><path d="M1 4h24" stroke="#C4554D" strokeWidth="2" strokeDasharray="5 4" /></svg>this call would break</span>
            </div>
            {current.blind
              ? <div className="empty" style={{ padding: '34px 18px', textAlign: 'center', color: 'var(--ink3)', fontSize: 13 }}>This team runs <b>without Loom</b>: no code graph, no locks, no warnings. Compare it with the same task on the Loom side.</div>
              : <Floor snap={snap} agents={agents} collisions={cols} goMap={() => go?.('functions')} />}
          </div>
          <div className="card lane reveal">
            <div className="h">Landing checks</div>
            <div className="expl">When an agent says it’s done, Loom checks its work before it joins the shared branch. If a check fails, the agent gets its work back with the reason.</div>
            <div className="lgrid lhd"><div style={{ fontSize: 11, color: 'var(--ink3)', textTransform: 'uppercase', letterSpacing: '.07em' }}>Agent</div><div>Merges cleanly<small>with work already landed</small></div><div>Callers still fit<small>nothing that calls it breaks</small></div><div>Tests pass<small>full test suite</small></div><div style={{ paddingLeft: 14 }}>Result</div></div>
            {agents.map((a) => {
              const k = checksOf(a); const c = agentColor(a.id);
              return (
                <div key={a.id} className="lgrid lrow" style={{ '--c': c } as never}>
                  <div className="who"><Bot color={c} size={24} /><span>{a.id}<br /><small>{k.tries ? `attempt ${k.tries}` : ''}</small></span></div>
                  {k.cells.map((v, i) => <div key={i} className={`cell ${v}`}><span className="ck">{v === 'ok' ? '✓' : v === 'no' ? '✕' : ''}</span></div>)}
                  <div className="res" style={{ color: k.color }}>{k.res}</div>
                  <div className={`why ${k.why ? 'on' : ''}`}>{k.why}</div>
                </div>);
            })}
            {current.result && <div className="expl" style={{ marginTop: 10, paddingBottom: 8 }}>Final tests on the shared branch: <b style={{ color: current.result.pass ? 'var(--good)' : 'var(--bad)' }}>{current.result.pass ? 'pass' : 'fail'}</b>{!current.result.pass && <pre className="term" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', marginTop: 6 }}>{current.result.out.slice(-600)}</pre>}</div>}
          </div>
        </div>
        <div className="side">
        {!current.blind && <Messages snap={snap} events={run.events} />}
        <div className="card feed reveal">
          <div className="h">What Loom just did</div>
          <div className="expl">Newest first. Click one to see it on the code.</div>
          <div className="moves">{!feed.length ? <div className="emptyfeed">{current.blind ? 'Without Loom there is nothing to report: nobody is watching.' : 'Nothing yet. Locks, warnings and send-backs show up here as they happen.'}</div>
            : feed.map((c) => { const [k, ico, label] = KIND[c.kind] ?? ['notice', '✉️', c.kind]; return (
              <div key={c.id} className="mv" style={{ '--kc': KC[k] } as never} onClick={() => go?.('functions')}><div className="t"><span className="ico">{ico}</span><span>{label}</span></div><p>{filesText(c.region)} · {c.outcome}</p>{c.detail && <p>{c.detail}</p>}</div>); })}</div>
        </div>
        </div>
      </div>
      <Drawer team={current} a={agents.find((a) => a.id === open)} snap={snap} cols={cols} onClose={() => setOpen('')} refresh={refresh} />
    </section>
  );
}
