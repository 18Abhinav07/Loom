// Spec-presentation §7: the Story screen's "Run the bench yourself". One E1 run at a time, blind + live, Claude Code on the subscription.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type BenchRunner = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => { done: Promise<number> };
export interface BenchRunState { state: 'idle' | 'running' | 'done' | 'failed'; set?: string; records?: string; total?: number; error?: string }

/** Default runner: a detached-from-stdio child; the promise settles with its exit code. */
export const spawnRunner: BenchRunner = (cmd, args, o) => {
  const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: 'ignore' });
  return { done: new Promise<number>((r) => { p.on('exit', (c) => r(c ?? 1)); p.on('error', () => r(127)); }) };
};

const SETS: Record<string, { arg: string; pairs: number; confirm?: string }> = { core: { arg: 'core', pairs: 12 }, full: { arg: 'all', pairs: 36, confirm: 'full' } };

export class BenchRun {
  private st: BenchRunState = { state: 'idle' };
  constructor(private root: string, private runner: BenchRunner = spawnRunner) {}

  /** null = started; otherwise [status, message]. */
  start(set: unknown, confirm: unknown): [number, string] | null {
    const s = SETS[String(set)];
    if (!s) return [400, `set must be one of ${Object.keys(SETS).join(', ')}`];
    if (s.confirm && confirm !== s.confirm) return [400, `${set} runs ${s.pairs * 2} Claude Code sessions: send confirm:"${s.confirm}"`];
    if (this.st.state === 'running') return [409, `a ${this.st.set} run is already going`];
    const records = join(this.root, 'runs', 'e1', `ui-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`);
    mkdirSync(records, { recursive: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANTHROPIC_')));   // subscription, never a paid key
    const py = join(this.root, '.venv', 'bin', 'python');
    this.st = { state: 'running', set: String(set), records, total: s.pairs * 2 };
    const run = this.runner(py, ['-m', 'e1.run', '--set', s.arg, '--conds', 'blind,live', '--model', 'sonnet', '--skip-done', records], { cwd: this.root, env });
    void run.done.then(async (code) => {
      // the report runs over whatever finished, so a stopped run still shows its pairs
      const rep = await this.runner(py, ['-m', 'e1.report', '--records', records], { cwd: this.root, env }).done;
      this.st = { ...this.st, state: code === 0 && rep === 0 ? 'done' : 'failed',
        error: code === 3 ? 'usage limit reached: continue later with --skip-done' : code ? `bench exited ${code}` : rep ? `report exited ${rep}` : undefined };
    });
    return null;
  }

  status() {
    const f = this.st.records ? join(this.st.records, 'records.jsonl') : '';
    const recs = f && existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
    const ok = recs.filter((r) => r.b_ok);
    const broke = (c: string) => ok.filter((r) => r.cond === c && !r.merged_pass).length;
    return { ...this.st, done: recs.length, blindBroke: broke('blind'), liveBroke: broke('live') };
  }
}
