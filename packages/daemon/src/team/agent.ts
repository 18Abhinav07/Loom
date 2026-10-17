// One team agent: a headless claude whose stdin stays open, so the daemon can message it while it runs.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';

export type AgentState = 'pending' | 'running' | 'idle' | 'landed' | 'failed' | 'stopped' | 'blocked';
export interface AgentOpts { id: string; cwd: string; prompt: string; env: NodeJS.ProcessEnv; model?: string; allowed: string[];
  traceFile: string; bin?: string; resume?: string; mcpConfig?: string }

export const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

/** events: 'reply'(text) 'result'({ok, sessionId}) 'exit'(code) */
export class AgentProc extends EventEmitter {
  private p?: ChildProcessWithoutNullStreams;
  private trace?: WriteStream;
  private sid?: string;
  constructor(private readonly o: AgentOpts) { super(); }
  get sessionId() { return this.sid; }
  get running() { return !!this.p && this.p.exitCode === null && !this.p.killed && !this.p.stdin.destroyed; }

  start() {
    const o = this.o;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local',
      ...(o.mcpConfig ? ['--mcp-config', o.mcpConfig] : []), '--permission-mode', 'acceptEdits',
      ...(o.resume ? ['--resume', o.resume] : []), ...(o.model ? ['--model', o.model] : []), '--allowedTools', ...o.allowed];
    const bin = o.bin?.includes('/') ? resolve(o.bin) : o.bin ?? 'claude';
    const p = spawn(bin.endsWith('.mjs') ? process.execPath : bin, bin.endsWith('.mjs') ? [bin, ...args] : args, { cwd: o.cwd, env: o.env });
    this.p = p; this.trace = createWriteStream(o.traceFile, { flags: 'a' });
    p.stdin.on('error', () => {});
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      this.trace?.write(d); buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop()!;
      for (const l of lines) this.line(l);
    });
    p.stderr.on('data', (d: Buffer) => this.trace?.write(`{"stderr":${JSON.stringify(d.toString())}}\n`));
    p.on('error', () => this.emit('exit', 1));
    p.on('close', (code) => { this.trace?.end(); this.emit('exit', code ?? 1); });
    this.send(o.prompt);
  }

  private line(l: string) {
    let j: any; try { j = JSON.parse(l); } catch { return; }
    if (j.session_id && !this.sid) this.sid = j.session_id;
    if (j.type === 'assistant') for (const c of j.message?.content ?? []) if (c.type === 'text' && c.text) this.emit('reply', c.text);
    if (j.type === 'result') this.emit('result', { ok: j.is_error !== true, sessionId: this.sid, text: String(j.result ?? '') });
  }

  send(text: string): boolean {
    if (!this.running) return false;
    this.p!.stdin.write(userLine(text)); return true;
  }

  stop() { if (this.p) { this.p.stdin.end(); this.p.kill('SIGTERM'); } }
}
