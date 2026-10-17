import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * §3.3 the thin chat page: talk to the lead (or any live session with a channel) from the browser.
 * Served on the UI port with the machine token inside; everything it calls goes through /lead/api, which needs that token.
 */
export function leadPage(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loom lead</title>
<style>
:root { --bg:#faf9f5; --fg:#1f1e1d; --mut:#7a766c; --line:#e6e2d6; --card:#fff; --acc:#d97757; --warn:#9a5b13; color-scheme:light }
* { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--fg); font:14.5px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif }
main { display:grid; grid-template-columns:210px minmax(0,1fr); height:100vh } @media (max-width:620px) { main { grid-template-columns:1fr; height:auto } }
aside { border-right:1px solid var(--line); padding:14px; overflow:auto; background:#f4f1e8 } section { display:flex; flex-direction:column; min-height:0; padding:14px 18px; min-width:0 }
h1 { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--mut); margin:0 0 10px }
.s { display:block; width:100%; text-align:left; border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:10px; padding:8px 10px; margin-bottom:8px; cursor:pointer; min-width:0 }
.s > div { overflow:hidden; text-overflow:ellipsis; white-space:nowrap } .s.on { border-color:var(--acc); box-shadow:0 0 0 2px #d9775722 }
.m { color:var(--mut); font-size:12px } #head { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-bottom:8px }
#turns { flex:1; overflow:auto; display:flex; flex-direction:column; gap:10px; padding:4px 0 12px }
.t { border:1px solid var(--line); background:var(--card); border-radius:14px; padding:9px 13px; white-space:pre-wrap; overflow-wrap:anywhere; max-width:min(80ch,92%) }
.t.user, .t.dashboard { align-self:flex-end; background:#f1ede2; border-color:#e6e2d6 }
.tool { color:var(--mut); font:12px ui-monospace,monospace; overflow-wrap:anywhere } #perms .p { border:1px solid var(--warn); border-radius:10px; padding:10px; margin-bottom:8px; background:#fff8ee }
pre { margin:6px 0; white-space:pre-wrap; overflow-wrap:anywhere; font:12px ui-monospace,monospace }
form { display:flex; gap:8px; align-items:flex-end; flex:none; padding-top:6px } textarea { flex:1; min-height:46px; max-height:180px; overflow-y:auto; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:var(--card); color:var(--fg); font:inherit; resize:none; display:block }
textarea:focus { outline:2px solid #d9775744; border-color:var(--acc) }
button.b { border:0; border-radius:10px; padding:11px 18px; background:var(--acc); color:#fff; font-weight:600; cursor:pointer } button.b:hover { filter:brightness(.95) } button.d { background:#8a4b2a } #status { min-height:18px }
</style></head><body><main>
<aside><h1>Live sessions</h1><div id="sessions"></div></aside>
<section><div id="head" class="m">Pick a session.</div><div id="turns"></div><div id="perms"></div><div id="status" class="m"></div>
<form id="form"><textarea id="text" placeholder="Message the session"></textarea><button class="b" id="send" type="submit">Send</button></form></section>
</main><script>
const T = ${JSON.stringify(token)};
const api = (p, o = {}) => fetch('/lead/api' + p, { ...o, headers: { 'x-loom-token': T, 'content-type': 'application/json' } });
const $ = (id) => document.getElementById(id);
let cur = null, rows = [];
const fit = () => { const t = $('text'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 180) + 'px'; };
$('text').value = new URLSearchParams(location.search).get('say') ?? '';
$('text').addEventListener('input', fit);
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('form').requestSubmit(); } });
fit();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
function turn(t) { const e = el('div', 't ' + t.from, t.text); $('turns').append(e); e.scrollIntoView({ block: 'end' }); }
function tool(t) { $('turns').append(el('div', 'tool', (t.ok === false ? '✗ ' : '· ') + t.name + (t.target ? ' ' + t.target : ''))); }
function perm(p) {
  if (document.querySelector('[data-rid="' + p.rid + '"]')) return;
  const box = el('div', 'p'); box.dataset.rid = p.rid;
  box.append(el('div', '', p.tool + ': ' + p.description), el('pre', '', p.preview));
  for (const [label, b] of [['Allow', 'allow'], ['Deny', 'deny']]) {
    const k = el('button', 'b' + (b === 'deny' ? ' d' : ''), label); k.style.marginRight = '8px';
    k.onclick = async () => { const r = await api('/sessions/' + cur + '/permissions/' + p.rid, { method: 'POST', body: JSON.stringify({ behavior: b }) });
      $('status').textContent = r.ok ? label + ' sent' : (await r.json()).error; if (r.ok) box.remove(); };
    box.append(k);
  }
  $('perms').append(box);
}
async function sessions() {
  rows = await (await api('/sessions')).json();
  $('sessions').replaceChildren(...rows.map((s) => { const b = el('button', 's' + (s.sid === cur ? ' on' : ''));
    b.append(el('div', '', s.writer === 'lead' ? 'Lead' : s.writer), el('div', 'm', (s.busy ? 'busy' : 'idle') + ' · ' + (s.channel ? 'chat' : 'read-only') + ' · ' + s.sid.slice(-8)));
    b.onclick = () => open(s.sid); return b; }));
  if (!cur && rows.length) open((rows.find((s) => s.writer === 'lead') ?? rows[0]).sid);
  if (!rows.length) $('sessions').textContent = 'No live sessions. Start one with loom lead.';
}
async function open(sid) {
  cur = sid; const d = await (await api('/sessions/' + sid)).json();
  $('head').textContent = d.writer + ' · ' + d.person + ' · ' + (d.channel ? 'chat' : 'read-only: restart the lead with loom lead to chat here') + (d.queued ? ' · ' + d.queued + ' queued' : '');
  $('turns').replaceChildren(); $('perms').replaceChildren(); d.turns.forEach(turn); d.pending.forEach(perm); sessions();
}
$('form').onsubmit = async (ev) => { ev.preventDefault(); const text = $('text').value.trim(); if (!cur || !text) return;
  const r = await api('/sessions/' + cur + '/messages', { method: 'POST', body: JSON.stringify({ text }) }); const j = await r.json();
  $('status').textContent = r.ok ? (j.status === 'held' ? 'held: the session is busy; it goes in after this turn' : 'sent') : j.error; if (r.ok) { $('text').value = ''; fit(); } };
const es = new EventSource('/lead/api/events?token=' + T);
es.onmessage = (m) => { const e = JSON.parse(m.data);
  if (e.kind === 'state') return void sessions();
  if (e.sid !== cur) return;
  if (e.kind === 'turn') turn(e.data); else if (e.kind === 'tool') tool(e.data);
  else if (e.kind === 'permission' && e.data.tool !== undefined) perm(e.data);
  else if (e.kind === 'permission') document.querySelector('[data-rid="' + e.data.rid + '"]')?.remove();
  else if (e.kind === 'channel' && e.data.held) $('status').textContent = 'held (' + e.data.queue + ' queued)'; };
sessions();
</script></body></html>
`;
}

/** /lead/api/<path> → the API port's /<path>: method, query, body, content-type and x-loom-token pass through; the answer streams back (SSE too). */
export async function passThrough(req: IncomingMessage, res: ServerResponse, apiPort: number, path: string, search: string) {
  const chunks: Buffer[] = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') for await (const c of req) chunks.push(c as Buffer);
  const ac = new AbortController(); req.on('close', () => ac.abort());
  const headers: Record<string, string> = {};
  for (const h of ['content-type', 'x-loom-token']) if (req.headers[h]) headers[h] = String(req.headers[h]);
  try {
    const r = await fetch(`http://127.0.0.1:${apiPort}${path}${search}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, signal: ac.signal });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-cache' });
    if (!r.body) return void res.end();
    for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) res.write(c);
    res.end();
  } catch {
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"daemon API unreachable"}'); } else res.end();
  }
}
