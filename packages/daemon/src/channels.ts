import type { Bus } from './bus.js';
import type { Live, Mirror } from './mirror.js';

/** A loom-mcp push port, registered by the MCP server Claude spawned (its ppid is the claude pid). */
export interface Reg { pid: number; port: number; secret: string; cwd: string }
export interface Pending { rid: string; tool: string; description: string; preview: string; at: number }
export type SendStatus = 'sent' | 'held' | 'no-channel';

/**
 * §3.3: dashboard → session. A Claude session is bound to the channel whose pid is in its hook's ppid chain.
 * A message to a busy session is held and the next Stop flushes one. A permission request is answered once.
 */
export class Channels {
  private regs = new Map<number, Reg>();
  private bound = new Map<string, number>();        // claude session id → channel pid
  private waiting = new Map<string, number[]>();    // claude session id → ppids, until its channel registers
  private held = new Map<string, string[]>();
  private perms = new Map<string, Pending & { claude: string; answered: boolean }>();
  constructor(private bus: Bus, private mirror: Mirror) {}

  register(r: Reg) {
    this.regs.set(r.pid, r);
    for (const [claude, pp] of this.waiting) if (pp.includes(r.pid)) this.link(claude, r.pid);
  }
  known(pid: number) { return this.regs.has(pid); }

  /** On any interactive hook: bind the session to a registered pid in its ppid chain, or wait for one. */
  bind(claude: string, ppids: number[]) {
    if (this.bound.has(claude) || !ppids.length) return;
    const pid = ppids.find((p) => this.regs.has(p));
    if (pid) this.link(claude, pid); else this.waiting.set(claude, ppids);
  }
  private link(claude: string, pid: number) {
    this.waiting.delete(claude); this.bound.set(claude, pid);
    const l = this.mirror.live.get(claude);
    if (l && !l.channel) { l.channel = true; this.mirror.state(l); }
  }
  drop(claude: string) {
    this.bound.delete(claude); this.waiting.delete(claude); this.held.delete(claude);
    for (const [rid, p] of this.perms) if (p.claude === claude) this.perms.delete(rid);
  }

  private async post(claude: string, path: string, b: object): Promise<boolean> {
    const r = this.regs.get(this.bound.get(claude) ?? -1); if (!r) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${r.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: r.secret, ...b }), signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {   // the channel is gone (claude exited): forget it
      this.regs.delete(r.pid); this.bound.delete(claude);
      const l = this.mirror.live.get(claude); if (l) { l.channel = false; this.mirror.state(l); }
      return false;
    }
  }
  private async push(l: Live, text: string) {
    const ok = await this.post(l.claude, '/push', { content: text, meta: { from: 'dashboard' } });
    if (ok) { l.busy = true; this.bus.publish({ repo: l.repo, sid: l.sid, kind: 'channel', data: { sent: text } }); }   // busy until its Stop: a second message holds
    return ok;
  }

  async send(l: Live, text: string): Promise<SendStatus> {
    if (!this.bound.has(l.claude)) return 'no-channel';
    if (l.busy) {
      const q = this.held.get(l.claude) ?? []; q.push(text); this.held.set(l.claude, q);
      this.bus.publish({ repo: l.repo, sid: l.sid, kind: 'channel', data: { held: text, queue: q.length } });
      return 'held';
    }
    return (await this.push(l, text)) ? 'sent' : 'no-channel';
  }

  /** After a Stop: the session is idle; deliver the oldest held message. */
  async onStop(l: Live) {
    const q = this.held.get(l.claude); const next = q?.shift();
    if (next === undefined) return;
    if (!(await this.push(l, next))) q!.unshift(next);
  }

  permission(pid: number, p: { request_id?: string; tool_name?: string; description?: string; input_preview?: string }): Live | undefined {
    const claude = [...this.bound].find(([, v]) => v === pid)?.[0];
    const l = claude ? this.mirror.live.get(claude) : undefined;
    if (!l || !p.request_id) return undefined;
    const rec = { rid: p.request_id, tool: p.tool_name ?? '', description: p.description ?? '', preview: p.input_preview ?? '', at: Date.now() };
    this.perms.set(rec.rid, { ...rec, claude: l.claude, answered: false });
    this.bus.publish({ repo: l.repo, sid: l.sid, kind: 'permission', data: { rid: rec.rid, tool: rec.tool, description: rec.description, preview: rec.preview } });
    return l;
  }

  /** The first answer wins; unknown, answered or another session's rid → false. */
  async answer(l: Live, rid: string, behavior: 'allow' | 'deny'): Promise<boolean> {
    const p = this.perms.get(rid);
    if (!p || p.answered || p.claude !== l.claude) return false;
    p.answered = true;
    if (!(await this.post(l.claude, '/permission', { request_id: rid, behavior }))) { p.answered = false; return false; }
    this.bus.publish({ repo: l.repo, sid: l.sid, kind: 'permission', data: { rid, behavior } });
    return true;
  }
  pending(l: Live): Pending[] {
    return [...this.perms.values()].filter((p) => p.claude === l.claude && !p.answered).map(({ claude: _c, answered: _a, ...p }) => p);
  }
  queue(l: Live) { return this.held.get(l.claude)?.length ?? 0; }
}
