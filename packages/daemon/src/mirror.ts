import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { appendEvent, envValues, redact, sessionFile, turnEvent } from '@loom/memory';
import type { Bus } from './bus.js';

/** One interactive Claude session Loom is mirroring (the lead, or any terminal in a Loom repo). Keyed by Claude session id. */
export interface Live {
  claude: string; sid: string; writer: string; person: string; repo: string;
  busy: boolean; channel: boolean; last: number; started: number;
  tools: Record<string, number>;   // tool counts of the current turn, for the claude turn
}
export type Recover = (cwd: string, claudeSid: string) => Promise<Omit<Live, 'busy' | 'channel' | 'last' | 'tools' | 'started'> | null>;

/** Resolve symlinks (macOS /var → /private/var); a path not yet written resolves through its directory. */
const real = (p: string): string => { try { return realpathSync(p); } catch { return dirname(p) === p ? p : join(real(dirname(p)), basename(p)); } };
const CHANNEL = /^<channel source="loom"[^>]*>\n?([\s\S]*?)\n?<\/channel>\s*$/;

/** §3.2: UserPromptSubmit → turn(user|dashboard), PostToolUse → tool, Stop → turn(claude). Written to the session file and the bus. */
export class Mirror {
  readonly live = new Map<string, Live>();
  private env = new Map<string, string[]>();
  constructor(private bus: Bus, private recover: Recover) {}

  start(s: Omit<Live, 'busy' | 'channel' | 'last' | 'tools' | 'started'>) {
    const prev = this.live.get(s.claude);
    const l: Live = { ...s, busy: false, channel: prev?.channel ?? false, last: Date.now(), started: Date.now(), tools: {} };
    this.live.set(s.claude, l);
    this.state(l);
    return l;
  }
  end(claude: string) {
    const l = this.live.get(claude); if (!l) return;
    this.live.delete(claude); this.bus.publish({ repo: l.repo, sid: l.sid, kind: 'state', data: { ended: true } });
  }
  bySid(sid: string) { for (const l of this.live.values()) if (l.sid === sid) return l; return undefined; }

  async get(cwd: string, claude: string): Promise<Live | undefined> {
    const l = this.live.get(claude); if (l) return l;
    const r = await this.recover(cwd, claude).catch(() => null);   // the daemon restarted under a running session
    return r ? this.start(r) : undefined;
  }

  private envOf(repo: string) { if (!this.env.has(repo)) this.env.set(repo, envValues(repo)); return this.env.get(repo)!; }
  private write(l: Live, ev: Record<string, unknown> & { type: any }) {
    appendEvent(l.repo, l.sid, l.writer, ev); l.last = Date.now();
  }
  state(l: Live) {
    this.bus.publish({ repo: l.repo, sid: l.sid, kind: 'state', data: { claude: l.claude, writer: l.writer, person: l.person, busy: l.busy, channel: l.channel } });
  }

  /** Returns the session after the event, so the caller can flush a held message on Stop (B3 Task 15). */
  async hook(event: string, input: any): Promise<Live | undefined> {
    if (!input?.session_id || !['UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event)) return undefined;
    const l = await this.get(String(input.cwd ?? ''), String(input.session_id));
    if (!l) return undefined;
    const env = this.envOf(l.repo);
    if (event === 'UserPromptSubmit') {
      const p = String(input.prompt ?? ''); const m = CHANNEL.exec(p);
      const t = turnEvent(m ? 'dashboard' : 'user', m ? m[1] : p, undefined, env);
      this.write(l, t); l.busy = true; l.tools = {};
      this.bus.publish({ repo: l.repo, sid: l.sid, kind: 'turn', data: { from: t.from, text: t.text, ...(t.cut ? { cut: true } : {}) } });
      this.state(l);
    } else if (event === 'PostToolUse') {
      const name = String(input.tool_name ?? '');
      const ti = input.tool_input ?? {}; const resp = input.tool_response;
      const file = ti.file_path ?? ti.notebook_path ?? ti.path;
      const target = typeof file === 'string' ? (isAbsolute(file) ? relative(real(l.repo), real(file)) || file : file)
        : typeof ti.command === 'string' ? redact(ti.command, env).slice(0, 200) : typeof ti.pattern === 'string' ? ti.pattern.slice(0, 200) : null;
      const ok = !(resp && typeof resp === 'object' && (resp.is_error === true || resp.success === false || (typeof resp.error === 'string' && resp.error)));
      const ms = typeof input.duration_ms === 'number' ? input.duration_ms : null;
      l.tools[name] = (l.tools[name] ?? 0) + 1;
      this.write(l, { type: 'tool', name, target, ok, ms });
      this.bus.publish({ repo: l.repo, sid: l.sid, kind: 'tool', data: { name, target, ok, ms } });
    } else {
      const t = turnEvent('claude', String(input.last_assistant_message ?? ''), Object.keys(l.tools).length ? l.tools : undefined, env);
      this.write(l, t); l.busy = false;
      this.bus.publish({ repo: l.repo, sid: l.sid, kind: 'turn', data: { from: 'claude', text: t.text, ...(t.tools ? { tools: t.tools } : {}), ...(t.cut ? { cut: true } : {}) } });
      this.state(l);
    }
    return l;
  }

  /** `GET /sessions` row. */
  row(l: Live) { return { sid: l.sid, claude: l.claude, writer: l.writer, person: l.person, repo: l.repo, busy: l.busy, channel: l.channel, last: l.last, started: l.started }; }

  /** `GET /sessions/:sid`: the row plus its turns and tools, read back from the session file. */
  detail(l: Live) {
    const p = join(l.repo, sessionFile(l.repo, l.sid, l.writer));
    const evs = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean) : [];
    return { ...this.row(l), turns: evs.filter((e: any) => e.type === 'turn'), tools: evs.filter((e: any) => e.type === 'tool') };
  }
}
