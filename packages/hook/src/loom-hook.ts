// Harness hook -> daemon. Fails open: never blocks an agent because Loom is down.
import { execFileSync } from 'node:child_process';
const [harness, event] = process.argv.slice(2);

/** The hook's ancestors, 4 levels: the daemon matches one to the `claude` process a channel server reported (B3). */
function ppids(): string {
  const out: number[] = []; let p = process.ppid;
  for (let i = 0; i < 4 && p > 1; i++) {
    out.push(p);
    try { p = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8', timeout: 300 }).trim()); } catch { break; }
  }
  return out.join(',');
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const url = process.env.LOOM_URL ?? 'http://127.0.0.1:4318';
  try {
    const res = await fetch(`${url}/hook/${harness}/${event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-agent': process.env.LOOM_AGENT ?? '', 'x-loom-run': process.env.LOOM_RUN ?? '',
        'x-loom-lead': process.env.LOOM_LEAD ?? '', 'x-loom-ppids': ppids() },
      body: input || '{}',
      // SessionStart builds the briefing (sync + fetch): 10 s. Every other hook sits in the agent's tool loop: 2 s.
      signal: AbortSignal.timeout(Number(event === 'SessionStart' ? (process.env.LOOM_HOOK_TIMEOUT_MS_START ?? 10000) : (process.env.LOOM_HOOK_TIMEOUT_MS ?? 2000))),
    });
    const out = await res.text();
    if (res.ok && out) process.stdout.write(out);
  } catch (e) {
    process.stderr.write(`[loom] daemon unreachable (${String(e)}); continuing without coordination\n`);
  }
}
main().finally(() => process.exit(0));
