import type { IncomingMessage } from 'node:http';

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Local daemon only: a request must name a loopback Host, and a write must come from no origin (curl, hooks, loom-mcp)
 * or a loopback one. Stops DNS rebinding (a web page whose name now points at 127.0.0.1 sends its own Host) and
 * cross-site writes from reaching the token on /lead or the lead's permission prompts.
 */
export function localOnly(req: IncomingMessage): string | null {
  if (!LOOPBACK.test(String(req.headers.host ?? ''))) return 'forbidden host: the local daemon answers only 127.0.0.1, localhost or [::1]';
  const origin = req.headers.origin;
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== undefined) {
    let host = '';
    try { host = new URL(String(origin)).host; } catch { /* "null" or junk */ }
    if (!LOOPBACK.test(host)) return 'forbidden origin';
  }
  return null;
}
