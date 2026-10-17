import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentProc } from '../src/team/agent.js';

const bin = resolve(__dirname, 'fake-claude.mjs');
const mk = (prompt = 'first') => {
  const d = mkdtempSync(join(tmpdir(), 'agent-'));
  return new AgentProc({ id: 'a', cwd: d, prompt, env: process.env, allowed: ['Read'], traceFile: join(d, 't.jsonl'), bin });
};
const once = <T>(p: AgentProc, ev: string) => new Promise<T>((ok) => p.once(ev, ok as any));

describe('AgentProc', () => {
  it('sends the prompt and a later message over one stdin', async () => {
    const p = mk(); const r1 = once(p, 'result'); p.start(); await r1;
    const rep = once<string>(p, 'reply');
    expect(p.send('hi')).toBe(true);
    expect(await rep).toBe('ack:hi');
    expect(p.running).toBe(true); p.stop();
  });
  it('stop ends the process; send after stop returns false', async () => {
    const p = mk(); const r = once(p, 'result'); p.start(); await r;
    const ex = once(p, 'exit'); p.stop(); await ex;
    expect(p.send('x')).toBe(false); expect(p.running).toBe(false);
  });
  it('a crash emits exit with a nonzero code', async () => {
    const p = mk('CRASH'); const ex = once<number>(p, 'exit'); p.start();
    expect(await ex).toBe(3);
  });
});
