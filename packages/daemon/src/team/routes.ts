// §3.4 the daemon's teams: one Team per started plan, driven from the dashboard, the CLI and the lead's MCP tools.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Bus } from '../bus.js';
import type { Channels } from '../channels.js';
import type { LiveRoutes } from '../live/routes.js';
import type { Mirror, Live } from '../mirror.js';
import { Team, type TeamView } from './team.js';

type Ok = { ok: boolean; error?: string };
export interface CheckResult { ok: boolean; problems: string[]; top: string | null }
export interface TeamRoutesDeps { routes: LiveRoutes; channels: Channels; mirror: Mirror; bus: Bus; url: string; bin?: string; pollMs?: number;
  hookCmd?: string; mcpPath?: string;
  /** Resolves the Loom repo of `cwd` and checks the plan (a slug in .loom/plans/ or a file) the way `check_plan` does. */
  check(cwd: string, b: { slug?: string; file?: string }): Promise<CheckResult> }

export const TEAM_TOOLS = ['start_team', 'team_status', 'message_agent', 'stop_team', 'stop_agent', 'restart_agent'] as const;
const loomRoot = () => resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');   // packages/daemon/src/team -> repo root
const gitEmail = (top: string) => { try { return execFileSync('git', ['-C', top, 'config', 'user.email'], { encoding: 'utf8' }).trim() || 'unknown'; } catch { return 'unknown'; } };
const snapDir = (repo: string) => join(repo, '.loom', 'teams');
/** Team history survives a daemon restart: each team's view is written to .loom/teams/<id>.json as it changes. */
function snapshot(v: TeamView) { try { mkdirSync(snapDir(v.repo), { recursive: true }); writeFileSync(join(snapDir(v.repo), `${v.id}.json`), JSON.stringify(v)); } catch { /* history is best-effort */ } }
function saved(repo: string): TeamView[] {
  try { return readdirSync(snapDir(repo)).filter((f) => f.endsWith('.json')).map((f) => {
    const v = JSON.parse(readFileSync(join(snapDir(repo), f), 'utf8')) as TeamView;
    const fresh = Date.now() - statSync(join(snapDir(repo), f)).mtimeMs < 20_000;   // an outside runner (the benchmark) rewrites its file while it is alive
    return v.state === 'running' && !fresh ? { ...v, state: 'stopped' as const } : v;   // it was running when the daemon went away
  }); } catch { return []; }
}
const clip = (s: string, n = 1500) => (s.length > n ? s.slice(0, n) + '…' : s);

export class TeamRoutes {
  private teams = new Map<string, Team>();
  private leads = new Map<string, string | null>();
  constructor(private readonly d: TeamRoutesDeps) {}

  /** The lead session to tell: the named one, else the newest session of that repo that has a channel. */
  private lead(repo: string, sid?: string | null): Live | undefined {
    if (sid) return this.d.mirror.bySid(sid);
    return [...this.d.mirror.live.values()].filter((l) => l.repo === repo && l.channel).sort((a, b) => b.last - a.last)[0];
  }

  async start(b: { cwd: string; plan: string; leadSid?: string | null; model?: string; blind?: boolean }): Promise<{ ok: true; team: TeamView } | { ok: false; problems: string[] }> {
    const plan = String(b.plan ?? '');
    if (!plan) return { ok: false, problems: ['need {plan}: a slug in .loom/plans/ or a plan file'] };
    const slug = /^[\w.-]+$/.test(plan) && !plan.endsWith('.md');
    const c = await this.d.check(b.cwd, slug ? { slug: plan } : { file: plan });
    if (!c.ok || !c.top) return { ok: false, problems: c.problems.length ? c.problems : ['not a Loom repo (run loom init)'] };
    const planPath = slug ? join(c.top, '.loom', 'plans', `${plan}.md`) : resolve(b.cwd, plan);
    const lead = this.lead(c.top, b.leadSid);
    const person = lead?.person ?? gitEmail(c.top);
    const me = this;
    let team!: Team;
    const t = await Team.start({ routes: this.d.routes, bin: this.d.bin, url: this.d.url, hookCmd: this.d.hookCmd ?? `node ${join(loomRoot(), 'packages', 'hook', 'dist', 'loom-hook.cjs')}`,
      mcpPath: this.d.mcpPath ?? join(loomRoot(), 'packages', 'mcp', 'dist', 'loom-mcp.cjs'), pollMs: this.d.pollMs,
      onAgentEvent(id, agent, text) {
        const l = me.lead(c.top!, lead?.sid ?? null);
        if (l) void me.d.channels.send(l, `[team ${team?.view().plan ?? id}] ${agent}: ${clip(text)}`, { from: `agent:${agent}` }).catch(() => {});
      },
      onTeam(id, e) { if (team) snapshot(team.view()); me.d.bus.publish({ repo: c.top!, sid: lead?.sid ?? id, kind: 'team', data: { team: id, ...e } }); } },
    { repo: c.top, planPath, leadSid: lead?.sid ?? null, person, model: b.model, blind: b.blind });
    team = t; snapshot(t.view()); void t.done().then(snapshot).catch(() => {});
    this.teams.set(t.id, t); this.leads.set(t.id, lead?.sid ?? null);
    return { ok: true, team: t.view() };
  }

  get(id: string): TeamView | null { return this.teams.get(id)?.view() ?? this.history().find((v) => v.id === id) ?? null; }
  private repos = new Set<string>();
  private history(repo?: string): TeamView[] { return [...(repo ? [repo] : this.repos)].flatMap(saved).filter((v) => !this.teams.has(v.id)); }
  list(repo?: string): TeamView[] {
    if (repo) this.repos.add(repo);
    return [...this.teams.values()].map((t) => t.view()).concat(this.history(repo)).filter((v) => !repo || v.repo === repo).sort((a, b) => b.startedAt - a.startedAt);
  }
  /** What one agent has said and done, read from its stream-json trace: assistant text and tool calls, in order. */
  agentHistory(id: string, agent: string): { ok: true; items: { kind: 'say' | 'tool'; text: string }[] } | Ok {
    const v = this.get(id);
    if (!v) return this.no(id);
    if (!/^[\w.-]+$/.test(agent)) return { ok: false, error: `no agent ${agent}` };
    const f = join(v.repo, '.git', 'loom', 'runs', id.slice(-8).toLowerCase(), `${agent}.jsonl`);
    if (!existsSync(f)) return { ok: true, items: [] };
    const items: { kind: 'say' | 'tool'; text: string }[] = [];
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      let j: any; try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== 'assistant') continue;
      for (const c of j.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) items.push({ kind: 'say', text: clip(c.text, 800) });
        else if (c.type === 'tool_use') {
          const i = c.input ?? {};
          items.push({ kind: 'tool', text: `${String(c.name).replace(/^mcp__loom__/, 'loom · ')} ${clip(String(i.file_path ?? i.command ?? i.pattern ?? i.symbol ?? i.symbols ?? ''), 120)}`.trim() });
        }
      }
    }
    return { ok: true, items: items.slice(-200) };
  }
  private no(id: string): Ok { return { ok: false, error: `no team ${id}` }; }
  async stop(id: string): Promise<Ok> { const t = this.teams.get(id); if (!t) return this.no(id); await t.stop(); return { ok: true }; }
  async merge(id: string, into?: string) { const t = this.teams.get(id); return t ? t.merge(into) : this.no(id); }
  message(id: string, agent: string, text: string): Ok { const t = this.teams.get(id); return t ? t.message(agent, text) : this.no(id); }
  stopAgent(id: string, agent: string): Ok { const t = this.teams.get(id); return t ? t.stopAgent(agent) : this.no(id); }
  async restartAgent(id: string, agent: string, note?: string): Promise<Ok> { const t = this.teams.get(id); return t ? t.restartAgent(agent, note) : this.no(id); }
  async closeAll() { for (const t of this.teams.values()) await t.stop().catch(() => {}); }

  /** The lead's MCP tools. `team` defaults to the newest running team of the caller's repo. */
  async mcp(tool: (typeof TEAM_TOOLS)[number], cwd: string, a: Record<string, unknown>): Promise<unknown> {
    if (tool === 'start_team') return this.start({ cwd, plan: String(a.plan ?? ''), model: a.model ? String(a.model) : undefined, blind: a.blind === true });
    const c = await this.d.check(cwd, {}).catch(() => null);
    const repo = c?.top ?? undefined;
    const mine = this.list(repo);
    const pick = a.team ? this.get(String(a.team)) : mine.find((t) => t.state === 'running') ?? mine[0] ?? null;
    if (tool === 'team_status') return a.team || pick ? (pick ? { ok: true, team: pick } : { ok: false, error: `no team ${String(a.team)}` }) : { ok: true, teams: mine };
    if (!pick) return { ok: false, error: 'no team: start one with start_team' };
    switch (tool) {
      case 'message_agent': return this.message(pick.id, String(a.agent), String(a.text ?? ''));
      case 'stop_team': return this.stop(pick.id);
      case 'stop_agent': return this.stopAgent(pick.id, String(a.agent));
      case 'restart_agent': return this.restartAgent(pick.id, String(a.agent), a.note ? String(a.note) : undefined);
    }
  }
}
