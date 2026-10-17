import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LoomMcpOpts { url: string; agent: string; run: string; cwd: string }
type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Spec §3.3: the 12 coordination tools (plus B3's check_plan), each a thin POST to the daemon's `/mcp/<tool>` route. */
export function createLoomMcp(o: LoomMcpOpts): McpServer {
  const server = new McpServer({ name: 'loom', version: '0.3.0' }, {
    capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } },
    instructions: 'Messages from the Loom dashboard arrive as <channel source="loom" from="dashboard"> events. '
      + 'They come from the same person as your terminal: answer each one exactly like a user message.',
  });
  const call = async (tool: string, args: Record<string, unknown>): Promise<Result> => {
    try {
      const r = await fetch(`${o.url}/mcp/${tool}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(o.agent ? { 'x-loom-agent': o.agent } : {}), ...(o.run ? { 'x-loom-run': o.run } : {}) },
        body: JSON.stringify({ cwd: o.cwd, args }),
      });
      const j = (await r.json()) as { ok: boolean; result?: unknown; error?: string };
      if (!j.ok) return { isError: true, content: [{ type: 'text', text: j.error ?? `daemon returned ${r.status}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(j.result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `loom daemon unreachable at ${o.url}: ${String(e)}` }] };
    }
  };
  const tool = (name: string, description: string, shape: z.ZodRawShape) =>
    server.registerTool(name, { description, inputSchema: shape }, (args: Record<string, unknown>) => call(name, args));

  const sym = z.string().describe('symbol id like django/utils/text.py::slugify, or a qualified name');
  tool('register', 'Join the Loom run as this agent.', { harness: z.string().optional() });
  tool('claim_task', 'Declare the task you are working on, so changes and decisions link to it.', { id: z.string(), title: z.string() });
  tool('lease', 'Lease symbols before changing them. mode=contract when you will change a signature. Denied leases name the holder.',
    { symbols: z.array(sym), mode: z.enum(['write', 'contract']) });
  tool('release', 'Release your leases (all, or the given symbols).', { symbols: z.array(sym).optional() });
  tool('impact', 'Callers within 3 hops of a symbol and the agents touching them.', { symbol: sym });
  tool('who_is_touching', 'Agents that leased, edited or read a symbol or any symbol in a file.', { path_or_symbol: z.string() });
  tool('notices', 'All coordination notices addressed to you.', {});
  // Optional: notices resolve themselves once your code fits the AFTER version. Loose shapes on purpose: workers send prose.
  tool('ack_notice', 'Optional. Mark a notice handled; `how` is "adapted" (default) or "no-impact", free text is fine.',
    { id: z.string(), how: z.string().optional() });
  tool('record_decision', 'Optional. Record a design decision and the symbols it constrains; `why` will show it.',
    { text: z.string().optional(), decision: z.string().optional(), symbols: z.array(sym).optional() });
  tool('why', 'Decision → task → agent → change → commit path for a symbol (or file.py:line).', { symbol: z.string() });
  // The lead's team tools (daemon refuses them from a team agent). `team` defaults to your repo's newest running team.
  const team = z.string().optional().describe('team id; default: the newest running team of this repo');
  tool('start_team', 'Start a team from a checked plan: a slug in .loom/plans/ or a plan file. Agents report back to you here.', { plan: z.string(), model: z.string().optional() });
  tool('team_status', 'Agents of a team (or all teams of this repo): state, task, landed commit.', { team });
  tool('message_agent', 'Send a message to a running team agent.', { team, agent: z.string(), text: z.string() });
  tool('stop_team', 'Stop every agent of a team.', { team });
  tool('stop_agent', 'Stop one team agent.', { team, agent: z.string() });
  tool('restart_agent', 'Restart a stopped or blocked team agent, optionally with a note.', { team, agent: z.string(), note: z.string().optional() });
  tool('lessons', 'Lessons from earlier runs: about one symbol id (scope), else about what you are working on.', { scope: z.string().optional() });
  server.registerTool('check_plan', { description: 'Check a team plan (.loom/plans/<slug>.md, a file path, or the plan text) before a team starts. '
    + 'Returns ok, problems (which refuse a start) and warnings.', inputSchema: { slug: z.string().optional(), file: z.string().optional(), text: z.string().optional() } },
  async (args: Record<string, unknown>): Promise<Result> => {
    try {
      const r = await fetch(`${o.url}/plans/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: o.cwd, ...args }) });
      const j = await r.json() as any;
      if (!r.ok) return { isError: true, content: [{ type: 'text', text: j.error ?? `daemon returned ${r.status}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: j.ok, problems: j.problems, warnings: j.warnings }) }] };
    } catch (e) { return { isError: true, content: [{ type: 'text', text: `loom daemon unreachable at ${o.url}: ${String(e)}` }] }; }
  });
  tool('claim_done', 'Claim a task done, with evidence (test command and result).', { task: z.string(), evidence: z.string().optional() });
  return server;
}

export interface ChannelOpts { url: string; home: string; cwd: string; pid: number }

/**
 * §3.3: the dashboard → session channel. A push port on 127.0.0.1 (secret-guarded) turns POST /push into
 * notifications/claude/channel and POST /permission into the permission verdict; Claude's permission requests go to the daemon.
 * Registers {pid: claude pid, port, secret, cwd} with the daemon, retries every 5 s, and re-registers when a 15 s ping gets a 404.
 */
export async function startChannel(server: McpServer, o: ChannelOpts) {
  const secret = randomBytes(16).toString('hex');
  const token = () => { try { return readFileSync(join(o.home, 'token'), 'utf8').trim(); } catch { return ''; } };
  const daemon = (path: string, init: RequestInit = {}) => fetch(`${o.url}${path}`, { ...init, signal: AbortSignal.timeout(3000),
    headers: { 'content-type': 'application/json', 'x-loom-token': token() } });
  const http = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const done = (code: number) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: code === 200 })); };
      let b: any; try { b = JSON.parse(raw || '{}'); } catch { return done(400); }
      if (b.secret !== secret) return done(403);
      try {
        if (req.url === '/push' && typeof b.content === 'string')
          await server.server.notification({ method: 'notifications/claude/channel', params: { content: b.content, meta: b.meta ?? {} } });
        else if (req.url === '/permission' && typeof b.request_id === 'string' && (b.behavior === 'allow' || b.behavior === 'deny'))
          await server.server.notification({ method: 'notifications/claude/channel/permission', params: { request_id: b.request_id, behavior: b.behavior } });
        else return done(400);
        done(200);
      } catch { done(500); }
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  http.unref();
  const port = (http.address() as { port: number }).port;
  server.server.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel/permission_request')
      await daemon('/channels/permission', { method: 'POST', body: JSON.stringify({ pid: o.pid, ...(n.params ?? {}) }) }).catch(() => {});
  };
  let registered = false;
  const register = async () => {
    try { registered = (await daemon('/channels', { method: 'POST', body: JSON.stringify({ pid: o.pid, port, secret, cwd: o.cwd }) })).ok; } catch { registered = false; }
  };
  let ticks = 0;
  const tick = setInterval(async () => {   // unregistered: retry every 5 s; registered: ping every 15 s
    if (!registered) return register();
    if (++ticks % 3) return;
    try { if ((await daemon(`/channels/${o.pid}`)).status === 404) await register(); } catch { /* daemon down: ping again */ }
  }, 5000);
  tick.unref();
  await register();
  return { port, secret, close: () => { clearInterval(tick); http.close(); } };
}

/** Only `loom lead` starts claude with the channel flag (and LOOM_LEAD=1); any other session would show "chat" and drop every message. */
export function wantsChannel(env: NodeJS.ProcessEnv): boolean {
  return env.LOOM_LEAD === '1' && !env.LOOM_AGENT && env.LOOM_CHANNEL !== '0';
}

async function main() {
  const url = process.env.LOOM_URL ?? 'http://127.0.0.1:4318';
  const server = createLoomMcp({ url, agent: process.env.LOOM_AGENT ?? '', run: process.env.LOOM_RUN ?? '', cwd: process.cwd() });
  await server.connect(new StdioServerTransport());
  // headless team agents and plain terminals never get dashboard messages; the lead does
  if (wantsChannel(process.env))
    await startChannel(server, { url, home: process.env.LOOM_HOME ?? join(homedir(), '.loom'), cwd: process.cwd(), pid: process.ppid });
}

if (typeof require !== 'undefined' && require.main === module) void main();
