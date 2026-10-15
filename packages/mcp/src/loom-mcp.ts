import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export interface LoomMcpOpts { url: string; agent: string; run: string; cwd: string }
type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Spec §3.3: the 12 coordination tools, each a thin POST to the daemon's `/mcp/<tool>` route. */
export function createLoomMcp(o: LoomMcpOpts): McpServer {
  const server = new McpServer({ name: 'loom', version: '0.3.0' });
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
  tool('lessons', 'Lessons from earlier runs: about one symbol id (scope), else about what you are working on.', { scope: z.string().optional() });
  tool('claim_done', 'Claim a task done, with evidence (test command and result).', { task: z.string(), evidence: z.string().optional() });
  return server;
}

async function main() {
  const server = createLoomMcp({
    url: process.env.LOOM_URL ?? 'http://127.0.0.1:4318',
    agent: process.env.LOOM_AGENT ?? '', run: process.env.LOOM_RUN ?? '', cwd: process.cwd(),
  });
  await server.connect(new StdioServerTransport());
}

if (typeof require !== 'undefined' && require.main === module) void main();
