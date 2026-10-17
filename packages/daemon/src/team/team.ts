// §3.4 the team: one agent per plan task, each in its own worktree with stdin open, landing through LiveRoutes' merge queue.
// Any number of agents: N tasks make N agents; `after` orders them, nothing else caps them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { subscriptionEnv } from '@loom/core';
import { appendEvent, ulid } from '@loom/memory';
import { parseTeamPlan, type TeamPlan, type TeamTask } from '@loom/planner';
import { handover } from '../live/handover.js';
import type { LandResult } from '../live/queue.js';
import type { LiveRoutes } from '../live/routes.js';
import { AgentProc, type AgentState } from './agent.js';
import { allowedTools, MAX_RESUMES, SUFFIX_TEAM } from './prompt.js';
import { exclude, mergeHooks, pyDirs } from './setup.js';

export interface TeamAgentView { id: string; title: string; state: AgentState; after: string[]; sid: string; worktree: string;
  branch: string; lands: string[]; resumed: number; lastReply?: string }
export interface TeamView { id: string; plan: string; goal: string; repo: string; leadSid: string | null; person: string;
  landed: string; state: 'running' | 'done' | 'stopped'; agents: TeamAgentView[]; startedAt: number }
export interface TeamDeps { routes: LiveRoutes; bin?: string; url?: string; hookCmd?: string; mcpPath?: string; pollMs?: number;
  onAgentEvent?(team: string, agent: string, text: string): void;
  onCollision?(team: string, c: unknown): void }

interface A { t: TeamTask; state: AgentState; sid: string; wt: string; branch: string; lands: string[]; resumed: number; lastReply?: string;
  proc?: AgentProc; sessionId?: string }
type Ok = { ok: boolean; error?: string };
const ID = ['-c', 'user.email=loom@local', '-c', 'user.name=loom'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', [...ID, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TERMINAL: AgentState[] = ['landed', 'failed', 'stopped', 'blocked'];

export class Team {
  readonly id = ulid();
  private readonly id8 = this.id.slice(-8).toLowerCase();
  private agents = new Map<string, A>();
  private parked = new Map<A, string>();
  private handled = new Set<string>();
  private st: TeamView['state'] = 'running';
  private timer?: NodeJS.Timeout;
  private fin!: () => void;
  private readonly finished = new Promise<void>((r) => { this.fin = r; });
  private plan!: TeamPlan;
  private landed = '';
  private test: string | null = null;
  private compile: string | null = null;
  private slug = '';
  private startedAt = Date.now();
  private settling = false;

  private constructor(private readonly d: TeamDeps, private readonly o: { repo: string; planPath: string; leadSid?: string | null; person: string; model?: string; maxParallel?: number }) {}

  static async start(d: TeamDeps, o: { repo: string; planPath: string; leadSid?: string | null; person: string; model?: string; maxParallel?: number }): Promise<Team> {
    const t = new Team(d, { ...o, repo: resolve(o.repo) });
    await t.init();
    return t;
  }

  private ev(e: Record<string, unknown> & { type: 'team' | 'collision' }) { return appendEvent(this.o.repo, this.id, 'coord', e); }
  private team(action: string, agent?: string, detail = '') { this.ev({ type: 'team', team: this.id, plan: this.slug, action, agent, detail }); }

  private async init() {
    const { repo, planPath } = this.o;
    const { plan, problems } = parseTeamPlan(readFileSync(planPath, 'utf8'));
    if (!plan) throw new Error(`plan: ${problems.join('; ')}`);
    this.plan = plan;
    this.slug = planPath.replace(/^.*\//, '').replace(/\.md$/, '');
    const cfgPath = join(repo, '.loom', 'config.json');
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
    this.test = plan.test ?? cfg.testCmd ?? null; this.compile = plan.compile ?? cfg.compile ?? null;
    const base = git(repo, 'rev-parse', plan.base || 'HEAD');
    exclude(repo, ['.loom/']);
    this.landed = `loom/${this.id8}/landed`;
    git(repo, 'branch', this.landed, base);
    await this.d.routes.addRun({ run: this.id, repo, landed: this.landed, dirs: cfg.dirs ?? pyDirs(repo), test: this.test, compile: this.compile });
    this.team('started', undefined, `${plan.tasks.length} tasks`);
    for (const t of plan.tasks) {
      const wt = join(repo, '.loom', 'wt', this.id8, t.id); const branch = `loom/${this.id8}/${t.id}`;
      git(repo, 'worktree', 'add', '-q', wt, '-b', branch, base);
      if (this.d.hookCmd) mergeHooks(join(wt, '.claude', 'settings.local.json'), this.d.hookCmd);
      if (this.d.mcpPath) writeFileSync(join(wt, '.loom-mcp.json'), JSON.stringify({ mcpServers: { loom: { command: 'node', args: [this.d.mcpPath],
        env: { LOOM_URL: this.d.url ?? '', LOOM_RUN: this.id, LOOM_AGENT: t.id } } } }, null, 2));
      await this.d.routes.addAgent({ run: this.id, agent: t.id, worktree: wt, task: t.id, title: t.title, scope: t.owns });
      const sid = ulid();
      appendEvent(repo, sid, t.id, { type: 'session', kind: 'agent', person: this.o.person, parent: this.o.leadSid ?? null, team: this.id,
        plan: this.slug, task: t.id, surface: 'headless', base, upstream: null });
      appendEvent(repo, sid, t.id, { type: 'agent', name: t.id, model: this.o.model ?? null });
      this.agents.set(t.id, { t, state: 'pending', sid, wt, branch, lands: [], resumed: 0 });
    }
    mkdirSync(join(repo, '.git', 'loom', 'runs', this.id8), { recursive: true });
    this.timer = setInterval(() => void this.settle(), this.d.pollMs ?? 1500); this.timer.unref();
    void this.settle();
  }

  view(): TeamView {
    return { id: this.id, plan: this.slug, goal: this.plan.goal, repo: this.o.repo, leadSid: this.o.leadSid ?? null, person: this.o.person,
      landed: this.landed, state: this.st, startedAt: this.startedAt,
      agents: [...this.agents.values()].map((a) => ({ id: a.t.id, title: a.t.title, state: a.state, after: a.t.after, sid: a.sid, worktree: a.wt,
        branch: a.branch, lands: a.lands, resumed: a.resumed, lastReply: a.lastReply })) };
  }
  done(): Promise<TeamView> { return this.finished.then(() => this.view()); }

  // ---- scheduling -------------------------------------------------------------------------------------------------------------

  private launch(a: A, prompt: string, resume?: string) {
    const trace = join(this.o.repo, '.git', 'loom', 'runs', this.id8, `${a.t.id}.jsonl`);
    const p = new AgentProc({ id: a.t.id, cwd: a.wt, prompt, bin: this.d.bin, model: this.o.model, resume, traceFile: trace,
      allowed: allowedTools({ test: this.test, compile: this.compile }), mcpConfig: this.d.mcpPath ? join(a.wt, '.loom-mcp.json') : undefined,
      env: { ...subscriptionEnv(process.env), LOOM_RUN: this.id, LOOM_AGENT: a.t.id, LOOM_URL: this.d.url ?? '' } });
    a.proc = p; a.state = 'running';
    p.on('reply', (text: string) => { a.lastReply = text; this.d.onAgentEvent?.(this.id, a.t.id, text); });
    p.on('result', (r: { ok: boolean; sessionId?: string }) => {
      a.sessionId = r.sessionId ?? a.sessionId;
      if (a.proc !== p || a.state !== 'running') return;
      if (!r.ok) { a.state = 'failed'; this.team('agent_rejected', a.t.id, 'agent reported an error'); void this.settle(); return; }
      void this.finish(a);
    });
    p.on('exit', (code: number) => {
      if (a.proc !== p) return;
      if (a.state === 'running' || a.state === 'idle') { a.state = 'failed'; this.team('agent_rejected', a.t.id, `exited ${code}`); void this.settle(); }
    });
    p.start();
    this.team('agent_started', a.t.id);
  }

  private async settle() {
    if (this.settling || this.st !== 'running') return;
    this.settling = true;
    try {
      const all = [...this.agents.values()];
      for (const a of all) if (a.state === 'pending' && a.t.after.some((d) => ['failed', 'stopped', 'blocked'].includes(this.agents.get(d)?.state ?? 'blocked'))) {
        a.state = 'blocked'; this.team('agent_rejected', a.t.id, 'a task it waits for did not land');
      }
      const max = Math.max(1, this.o.maxParallel ?? all.length);
      let active = all.filter((a) => a.state === 'running' || a.state === 'idle').length;
      for (const a of all) {
        if (active >= max) break;
        if (a.state !== 'pending' || !a.t.after.every((d) => this.agents.get(d)?.state === 'landed')) continue;
        if (a.t.after.length) { try { await handover(a.wt, this.landed); } catch { /* the agent sees the conflict markers or nothing new */ } }
        active++; this.launch(a, a.t.prompt + SUFFIX_TEAM);
      }
      if (all.every((a) => a.state !== 'running' && a.state !== 'idle' && a.state !== 'pending')) {
        if (this.parked.size) { for (const [p, tail] of [...this.parked]) { this.parked.delete(p); await this.resume(p, 'contract_break', tail); } return; }
        if (await this.checkWakes()) return;
        this.st = 'done'; this.endProcs(); this.fin();
      } else await this.checkWakes();
    } finally { this.settling = false; }
  }

  private endProcs() { clearInterval(this.timer); for (const a of this.agents.values()) a.proc?.stop(); }

  /** An agent holding a pending wake is resumed with it, on a checkout that has the landed work. Returns how many it resumed. */
  private async checkWakes(): Promise<number> {
    const ns = ((await this.d.routes.notices(this.id)) ?? []) as { id: string; agent: string; kind?: string; status: string }[];
    let n = 0;
    for (const x of ns) {
      const a = this.agents.get(x.agent);
      if (x.kind !== 'wake' || x.status !== 'pending' || this.handled.has(x.id) || !a || a.state !== 'landed' || this.parked.has(a)
        || a.resumed >= MAX_RESUMES || !a.proc?.running) continue;
      this.handled.add(x.id); a.state = 'running';
      const { text } = (await this.d.routes.take(this.id, a.t.id)) ?? { text: '' };
      const h = await handover(a.wt, this.landed);
      const clash = h.status === 'conflict' ? `\n\n[loom] the landed work is merged into your checkout; resolve the conflict markers in ${h.files.join(', ')}.` : '';
      a.resumed++; n++;
      a.proc.send((text || '[loom] the code you were waiting on has landed; it is in your checkout now. Continue your task.') + clash);
    }
    return n;
  }

  /** The agent stopped: land its work. Work that cannot land goes back to it, on the landed code, with the reason. */
  private async finish(a: A) {
    a.state = 'idle';
    let r: LandResult | null;
    try { r = await this.d.routes.land(this.id, a.t.id); } catch { r = null; }
    if (!r) { a.state = 'failed'; this.team('agent_rejected', a.t.id, 'landing failed'); return void this.settle(); }
    a.lands.push(r.status);
    if (r.status === 'landed' || r.status === 'empty') {
      a.state = 'landed'; this.team('agent_landed', a.t.id, r.sha ?? 'nothing to land');
      this.d.onAgentEvent?.(this.id, a.t.id, `${a.t.id} landed${r.sha ? ` (${r.sha.slice(0, 7)})` : ''}`);
      for (const p of [...this.parked.keys()]) { this.parked.delete(p); void this.finish(p); }
      return void this.settle();
    }
    this.team('agent_rejected', a.t.id, r.status);
    this.d.onCollision?.(this.id, { agent: a.t.id, result: r });
    // only another agent's landing can supply a callee that is missing: wait for one instead of resuming to no end
    if (r.status === 'contract_break' && r.missing && [...this.agents.values()].some((x) => x !== a && (x.state === 'running' || x.state === 'pending'))) {
      this.parked.set(a, r.tail); return;
    }
    await this.resume(a, r.status, r.tail);
  }

  private async resume(a: A, status: LandResult['status'], tail: string) {
    if (a.resumed >= MAX_RESUMES || !a.proc?.running) { a.state = 'failed'; return void this.settle(); }
    const h = await handover(a.wt, this.landed);
    const why = status === 'tests_failed'
      ? `[loom] your work did not land: the tests failed after merging it with the landed work. Fix it so the tests pass. Output:\n${tail}`
      : status === 'compile_failed'
        ? `[loom] your work did not land: merged with the landed work, the compiler (${this.compile}) reports errors the landed code did not have. Fix them, then finish.\n${tail}`
      : status === 'contract_break'
        ? `[loom] your work did not land: merged with the landed work, some ${tail}\nThe landed work is in your checkout now. Fix every listed call site (or the signature) so they fit, then finish.`
        : `[loom] your work did not land: it conflicts with work another agent landed.`;
    const files = h.status === 'conflict' ? `\nThe landed work is merged into your checkout; resolve the conflict markers in ${h.files.join(', ')}, keeping both changes' intent.` : '';
    a.resumed++; a.state = 'running'; a.proc.send(why + files);
  }

  // ---- control ----------------------------------------------------------------------------------------------------------------

  message(agent: string, text: string): Ok {
    const a = this.agents.get(agent);
    if (!a) return { ok: false, error: `no agent ${agent}` };
    if (!a.proc?.running || this.st !== 'running' || TERMINAL.includes(a.state) && a.state !== 'landed') return { ok: false, error: `agent ${agent} is not running` };
    if (a.state === 'landed') a.state = 'running';
    return a.proc.send(text) ? { ok: true } : { ok: false, error: `agent ${agent} is not running` };
  }
  stopAgent(agent: string): Ok {
    const a = this.agents.get(agent);
    if (!a) return { ok: false, error: `no agent ${agent}` };
    if (!a.proc?.running) return { ok: false, error: `agent ${agent} is not running` };
    a.state = 'stopped'; a.proc.stop(); this.team('agent_rejected', agent, 'stopped'); void this.settle();
    return { ok: true };
  }
  async restartAgent(agent: string, note?: string): Promise<Ok> {
    const a = this.agents.get(agent);
    if (!a) return { ok: false, error: `no agent ${agent}` };
    if (a.state === 'running' || a.state === 'idle') return { ok: false, error: `agent ${agent} is still running` };
    a.proc?.stop(); a.resumed = 0;
    if (this.st !== 'running') { this.st = 'running'; this.timer = setInterval(() => void this.settle(), this.d.pollMs ?? 1500); this.timer.unref(); }
    try { await handover(a.wt, this.landed); } catch { /* conflict markers are the agent's to resolve */ }
    this.launch(a, a.t.prompt + SUFFIX_TEAM + (note ? `\n\n[loom] restarted: ${note}` : ''), a.sessionId);
    return { ok: true };
  }
  async stop() {
    this.st = 'stopped'; this.endProcs();
    for (const a of this.agents.values()) if (!TERMINAL.includes(a.state)) a.state = 'stopped';
    this.team('stopped'); this.fin();
  }
  async merge(into?: string): Promise<Ok & { commit?: string }> {
    try {
      if (into) git(this.o.repo, 'checkout', '-q', into);
      git(this.o.repo, 'merge', '--no-edit', this.landed);
      this.team('merged', undefined, into ?? 'current branch');
      return { ok: true, commit: git(this.o.repo, 'rev-parse', 'HEAD') };
    } catch (e) { return { ok: false, error: String((e as Error).message).split('\n')[0] }; }
  }
}
