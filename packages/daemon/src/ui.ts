import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { Coordinator } from './coordinator.js';
import type { EventBus } from './events.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
};

/** An `extra` answer with its own status code (a bare value answers 200). */
export class Reply { constructor(public code: number, public body: unknown) {} }

/** Spec §3.4: the dashboard port. Static UI, snapshot, SSE event stream. */
export async function startUi(opts: { port: number; host?: string; bus: EventBus; runs: Map<string, Coordinator>; distDir: string;
  extra?: (u: URL, req: IncomingMessage) => Promise<unknown | undefined>; serves?: (run: string) => boolean;
  raw?: (u: URL, req: IncomingMessage, res: ServerResponse) => Promise<boolean>; guard?: (req: IncomingMessage) => string | null }) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const json = (code: number, x: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
    try {
      const refused = opts.guard?.(req);
      if (refused) return json(403, { error: refused });
      const u = new URL(req.url ?? '/', 'http://x');
      if (await opts.raw?.(u, req, res)) return;   // a route that writes its own response (HTML, a streamed pass-through)
      const run = u.searchParams.get('run') ?? '';
      if (u.pathname === '/runs') return json(200, [...opts.runs.keys()]);
      if (run && opts.serves && !opts.serves(run)) return json(404, { error: 'run not served' });   // read-only: no reads of other graphs
      if (u.pathname === '/snapshot') {
        const c = opts.runs.get(run);
        return c ? json(200, await c.snapshot()) : json(404, { error: 'run not loaded' });
      }
      if (u.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (e: unknown) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(e)}\n\n`); };
        for (const e of opts.bus.recent(run)) send(e);
        res.write(': ok\n\n');
        const off = opts.bus.on(run, send);
        req.on('close', off);
        return;
      }
      const x = await opts.extra?.(u, req);
      if (x instanceof Reply) return json(x.code, x.body);
      if (x !== undefined) return json(200, x);
      if (!existsSync(opts.distDir)) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('dashboard not built: pnpm build:ui'); }
      let p = normalize(join(opts.distDir, u.pathname));
      if (!p.startsWith(opts.distDir) || !existsSync(p) || statSync(p).isDirectory()) p = join(opts.distDir, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
      res.end(readFileSync(p));
    } catch (e) {
      if (!res.headersSent) json(500, { error: String(e) });
    }
  });
  await new Promise<void>((r) => server.listen(opts.port, opts.host ?? '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
