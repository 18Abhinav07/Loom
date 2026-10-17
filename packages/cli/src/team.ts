// B4 `loom team`: a thin client of the daemon's /teams routes. The daemon owns the agents; this only asks and prints.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const flag = (a: string[], name: string) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USAGE = 'usage: loom team start <plan | file> [--model m] [--blind] [--wait] | status | stop | merge [--into b] | msg <agent> <text> | stop-agent <a> | restart-agent <a> [note]   (--team <id>, default: newest)';

interface Agent { id: string; state: string; lands: string[]; resumed: number; branch: string }
interface View { id: string; plan: string; state: string; landed: string; agents: Agent[] }

async function call(url: string, method: string, path: string, cwd: string, body?: object): Promise<{ status: number; j: any }> {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${url}${method === 'GET' ? `${path}${sep}cwd=${encodeURIComponent(cwd)}` : path}`, { method,
    ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd, ...body }) }) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

const line = (a: Agent) => `  ${a.id.padEnd(16)} ${a.state.padEnd(8)} resumed ${a.resumed}  ${a.branch}`;

/** Prints the team's agents; true when the team finished with every agent landed. */
function report(v: View): boolean {
  console.log(`team ${v.id} (${v.plan}): ${v.state}; landed branch ${v.landed}`);
  v.agents.forEach((a) => console.log(line(a)));
  return v.state === 'done' && v.agents.every((a) => a.state === 'landed');
}

export async function teamCmd(rest: string[], url: string, cwd = process.cwd()): Promise<number> {
  const [sub, ...args] = rest;
  if (!sub) { console.error(USAGE); return 1; }
  try {
    if (sub === 'start') {
      const plan = args[0];
      if (!plan) { console.error(USAGE); return 1; }
      const body = { plan: existsSync(resolve(cwd, plan)) ? resolve(cwd, plan) : plan, model: flag(args, '--model'), blind: args.includes('--blind') };
      const { status, j } = await call(url, 'POST', '/teams', cwd, body);
      if (status !== 200) { (j.problems ?? [j.error ?? `daemon returned ${status}`]).forEach((p: string) => console.error(`problem: ${p}`)); return 1; }
      const id: string = j.team.id;
      if (!args.includes('--wait')) { console.log(`team ${id} started (${j.team.agents.length} agents)`); return 0; }
      for (;;) {
        const g = await call(url, 'GET', `/teams/${id}`, cwd);
        if (g.status !== 200) { console.error(g.j.error ?? `daemon returned ${g.status}`); return 1; }
        if (g.j.state !== 'running') {
          const ok = report(g.j);
          const out = flag(args, '--report');
          if (out) { mkdirSync(dirname(resolve(cwd, out)), { recursive: true }); writeFileSync(resolve(cwd, out), JSON.stringify(g.j, null, 2)); }
          return ok ? 0 : 1;
        }
        await sleep(2000);
      }
    }
    const listed = await call(url, 'GET', '/teams', cwd);
    if (listed.status !== 200) { console.error(listed.j.error ?? `daemon returned ${listed.status}`); return 1; }
    const teams: View[] = listed.j;
    const want = flag(args, '--team');
    const pick = want ? teams.find((t) => t.id === want) : teams.find((t) => t.state === 'running') ?? teams[0];
    if (sub === 'status') {
      if (!teams.length) { console.log('no teams in this repo'); return 0; }
      (want ? [pick!] : teams).forEach((t) => t && report(t));
      return 0;
    }
    if (!pick) { console.error(want ? `no team ${want}` : 'no team in this repo (loom team start <plan>)'); return 1; }
    const act: Record<string, [string, object | null]> = {
      stop: ['stop', {}], merge: ['merge', { into: flag(args, '--into') }],
      msg: ['message', { agent: args[0], text: args.slice(1).filter((x, i, all) => x !== '--team' && all[i - 1] !== '--team').join(' ') }],
      'stop-agent': ['stop-agent', { agent: args[0] }], 'restart-agent': ['restart-agent', { agent: args[0], note: args.slice(1).join(' ') || undefined }],
    };
    const a = act[sub];
    if (!a) { console.error(USAGE); return 1; }
    if (sub !== 'stop' && sub !== 'merge' && !args[0]) { console.error(USAGE); return 1; }
    const { status, j } = await call(url, 'POST', `/teams/${pick.id}/${a[0]}`, cwd, a[1] ?? {});
    if (status !== 200 || j.ok === false) { console.error(j.error ?? `daemon returned ${status}`); return 1; }
    console.log(sub === 'merge' ? JSON.stringify(j) : `${sub}: ok`);
    return 0;
  } catch (e) { console.error(`loom daemon unreachable at ${url}: ${String(e)}`); return 1; }
}
