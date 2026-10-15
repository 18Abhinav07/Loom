// Harness hook -> daemon. Fails open: never blocks an agent because Loom is down.
const [harness, event] = process.argv.slice(2);

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const url = process.env.LOOM_URL ?? 'http://127.0.0.1:4318';
  try {
    const res = await fetch(`${url}/hook/${harness}/${event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-agent': process.env.LOOM_AGENT ?? '', 'x-loom-run': process.env.LOOM_RUN ?? '' },
      body: input || '{}',
      signal: AbortSignal.timeout(Number(process.env.LOOM_HOOK_TIMEOUT_MS ?? 5000)),
    });
    const out = await res.text();
    if (res.ok && out) process.stdout.write(out);
  } catch (e) {
    process.stderr.write(`[loom] daemon unreachable (${String(e)}); continuing without coordination\n`);
  }
}
main().finally(() => process.exit(0));
