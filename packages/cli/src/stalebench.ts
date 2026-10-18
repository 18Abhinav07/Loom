// `loom stalebench`: runs the StaleBench (Django) benchmark yourself. Sizes name what they are:
//   --pairs 12  core set, 12 held-out task pairs   --pairs 36  all 36 real-derived pairs
// Each pair runs once per condition (blind, live; add --oracle for the third): 12 pairs x 2 = 24 runs, 36 x 3 = 108.
import { spawnSync } from 'node:child_process';
import { subscriptionEnv } from '@loom/core';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const flag = (a: string[], name: string) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined; };
const STALE_URL = 'https://github.com/illinoisdata/STALE-bench';
const USAGE = 'usage: loom stalebench [--pairs 12|36] [--oracle] [--model haiku|sonnet] [--trials N] [--check] [--yes]\n  --pairs 12  core set (default): 12 pairs x blind+live = 24 runs\n  --pairs 36  all pairs: 36 x 2 = 72 runs; with --oracle 36 x 3 = 108 runs\n  --check     verify everything is installed, spend nothing';

const sh = (cmd: string, args: string[], cwd: string) => spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status === 0;
const root = () => resolve(dirname(realpathSync(process.argv[1] ?? __filename)), '..', '..', '..');

function python(): string | null {
  for (const p of ['python3.13', 'python3.12', 'python3']) {
    const r = spawnSync(p, ['-c', 'import sys;sys.exit(0 if sys.version_info>=(3,12) else 1)']);
    if (r.status === 0) return p;
  }
  return null;
}

export async function stalebenchCmd(rest: string[]): Promise<number> {
  if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
  const pairs = flag(rest, '--pairs') ?? '12';
  if (!['12', '36'].includes(pairs)) { console.error(USAGE); return 1; }
  const oracle = rest.includes('--oracle');
  const model = flag(rest, '--model') ?? 'haiku';
  const trials = flag(rest, '--trials') ?? '1';
  const conds = oracle ? 'blind,oracle,live' : 'blind,live';
  const runs = Number(pairs) * conds.split(',').length * Number(trials);
  const repo = root();
  const bench = join(repo, 'bench');
  if (!existsSync(join(bench, 'e1', 'run.py'))) { console.error(`loom stalebench needs the Loom source checkout (looked in ${repo}); run it from a clone of the Loom repo install.`); return 1; }

  console.log(`StaleBench (Django): ${pairs} pairs x ${conds.split(',').length} conditions (${conds}) x ${trials} trial(s) = ${runs} agent runs on ${model}`);
  const py = python();
  if (!py) { console.error('need Python 3.12+ (brew install python@3.13)'); return 1; }

  const stale = join(repo, 'third_party', 'STALE-bench');
  if (!existsSync(join(stale, 'instances', 'django.jsonl'))) {
    console.log(`fetching the STALE-bench data (${STALE_URL})…`);
    if (rest.includes('--check')) console.log('  missing: will be cloned on a real run');
    else if (!sh('git', ['clone', '--depth', '1', STALE_URL, stale], repo)) { console.error('could not clone STALE-bench'); return 1; }
  } else console.log('ok  STALE-bench data present');

  const venv = join(bench, '.venv', 'bin', 'python');
  if (!existsSync(venv)) {
    console.log('creating the bench python environment…');
    if (rest.includes('--check')) console.log('  missing: will be created on a real run');
    else if (!sh(py, ['-m', 'venv', '.venv'], bench) || !sh(join(bench, '.venv', 'bin', 'pip'), ['install', '-q', '.'], bench)) { console.error('could not set up bench/.venv'); return 1; }
  } else console.log('ok  bench python environment');

  const claude = spawnSync('claude', ['--version']);
  if (claude.status !== 0) { console.error('need the Claude Code CLI (`claude`) on PATH'); return 1; }
  console.log('ok  claude CLI');
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (docker.status !== 0) { console.error('need Docker running (FalkorDB)'); return 1; }
  console.log('ok  docker');
  if (rest.includes('--check')) { console.log(`\nready. a real run would cost ${runs} Claude sessions. start it with: loom stalebench --pairs ${pairs}${oracle ? ' --oracle' : ''}`); return 0; }

  if (!rest.includes('--yes') && !process.stdin.isTTY) { console.error('this spends tokens; rerun with --yes to confirm'); return 1; }
  if (!rest.includes('--yes')) {
    process.stdout.write(`This spends tokens: ${runs} Claude ${model} sessions. Type yes to start: `);
    const ans = await new Promise<string>((r) => process.stdin.once('data', (d) => r(String(d).trim())));
    if (ans !== 'yes') { console.log('cancelled'); return 1; }
  }
  if (!sh('loom', ['up'], repo)) return 1;
  const runsDir = join(bench, 'runs', 'e1');
  const before = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
  const env = subscriptionEnv(process.env);
  const run = spawnSync(venv, ['-m', 'e1.run', '--set', pairs === '36' ? 'all' : 'core', '--conds', conds, '--trials', trials, '--model', model], { cwd: bench, stdio: 'inherit', env });
  if (run.status !== 0 && !existsSync(runsDir)) { console.error('the benchmark failed before recording anything'); return 1; }
  const fresh = (existsSync(runsDir) ? readdirSync(runsDir) : []).filter((d) => !before.has(d)).sort().pop();
  if (!fresh || !existsSync(join(runsDir, fresh, 'records.jsonl'))) { console.error('the run produced no records'); return 1; }
  console.log(`\nrecords: bench/runs/e1/${fresh}`);
  if (!sh(venv, ['-m', 'e1.report', '--records', `runs/e1/${fresh}`], bench)) return 1;
  console.log('done. open the Benchmark tab of the dashboard (loom ui) to see the result.');
  return run.status === 0 ? 0 : 1;
}
