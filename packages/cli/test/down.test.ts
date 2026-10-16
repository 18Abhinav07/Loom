import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

// `loom down` must stop the daemon that is actually answering, not trust a pid file: an orphan (pid file lost or stale)
// otherwise keeps a port, a FalkorDB connection and a tsx process alive forever. Runs in its own HOME and ports.
const ROOT = resolve(__dirname, '../../..');
const LOOM = join(ROOT, 'packages/cli/dist/loom.cjs');
const freePort = () => new Promise<number>((r) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const up = async (url: string) => { try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } };

test.each([['no pid file', null], ['a stale pid file', '999999']])('loom down stops a daemon it did not start, with %s', async (_, pidfile) => {
  const home = mkdtempSync(join(tmpdir(), 'loom-down-'));
  const [port, uiPort] = [await freePort(), await freePort()];
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOME: home, LOOM_PORT: String(port), LOOM_UI_PORT: String(uiPort), LOOM_URL: url };
  delete env.PORT;
  const d = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'packages/daemon/src/server.ts')], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 250));
    expect(await up(url)).toBe(true);
    if (pidfile) { execFileSync('mkdir', ['-p', join(home, '.loom')]); writeFileSync(join(home, '.loom/daemon.pid'), pidfile); }
    const out = execFileSync(process.execPath, [LOOM, 'down'], { env, encoding: 'utf8' });
    expect(out).toMatch(/stopped/);
    expect(await up(url)).toBe(false);
    for (let i = 0; i < 20 && alive(d.pid!); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(d.pid!)).toBe(false);
  } finally { if (alive(d.pid!)) d.kill('SIGKILL'); }
}, 30000);
