// Drive a live daemon through the e2e story (packages/daemon/test/e2e.test.ts steps 1-13) with 1 s gaps, for looking at the dashboard;
// then three claims (FAIL, UNKNOWN, VERIFIED) and one manual lesson (removed again with `loom lesson rm <id>`).
// Usage: pnpm exec tsx bench/scripts/ui_fixture.mts [gapMs]   (daemon on LOOM_URL, default http://127.0.0.1:4318)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const url = process.env.LOOM_URL ?? 'http://127.0.0.1:4318';
const gap = Number(process.argv[2] ?? 1000);
const run = `fixture:ui:${Date.now().toString(36)}`;
const F = 'django/utils/text.py';
const TEXT = 'def phone2numeric(phone):\n    return phone.upper()\n\n\ndef unpack(s):\n    return phone2numeric(s)\n\n\ndef slugify(v):\n    return unpack(v).lower()\n';
const TEST = 'import unittest\nfrom django.utils import text\n\n\nclass T(unittest.TestCase):\n    def test_phone(self):\n        self.assertEqual(text.phone2numeric(\'ab\'), \'AB\')\n';
const CFG = { command: 'cd tests && PYTHONPATH=.. python3 -m unittest {labels}', label: '{module_dotted}.{Class}.{method}', root: 'tests' };
const DIAL = (call: string) => `${TEXT}\n\ndef dial(n):\n    return ${call}\n`;

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=f@f', '-c', 'user.name=f', ...a], { cwd, encoding: 'utf8' });
function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-ui-'));
  for (const p of [dirname(F), 'tests', '.loom']) mkdirSync(join(d, p), { recursive: true });
  const files: Record<string, string> = { [F]: TEXT, 'django/__init__.py': '', 'django/utils/__init__.py': '', 'tests/__init__.py': '',
    'tests/test_text.py': TEST, '.loom/config.json': JSON.stringify({ run, dirs: ['django'], test: CFG }) };
  for (const [p, t] of Object.entries(files)) writeFileSync(join(d, p), t);
  git(d, 'init', '-q'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  return d;
}
const post = async (path: string, body: unknown, h: Record<string, string> = {}) => {
  const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  return r.text();
};
const wt: Record<string, string> = {};
const hook = (a: string, event: string, extra: Record<string, unknown> = {}) =>
  post(`/hook/claude/${event}`, { hook_event_name: event, cwd: wt[a], session_id: `s-${a}`, ...extra }, { 'x-loom-agent': a, 'x-loom-run': run });
const tool = (a: string, event: 'PreToolUse' | 'PostToolUse', name: string, input: Record<string, unknown>) =>
  hook(a, event, { tool_name: name, tool_input: input, ...(event === 'PostToolUse' ? { tool_response: {} } : {}) });
const write = (a: string, text: string) => writeFileSync(join(wt[a], F), text);
const step = async (label: string, f: () => Promise<unknown>) => { console.log(label); await f(); await new Promise((r) => setTimeout(r, gap)); };

const root = tree();
await post('/admin/runs', { run, root, dirs: ['django'], baseKey: run });
for (const a of ['a', 'b', 'c']) wt[a] = tree();
console.log(await post('/plan', { run, cwd: root, plan: { tasks: [
  { id: 'a', title: 'strict phone2numeric', prompt: 'x', scope: [`${F}::phone2numeric`] },
  { id: 'b', title: 'dial helper', prompt: 'x', scope: [`${F}::phone2numeric`, `${F}::unpack`] },
  { id: 'c', title: 'region support', prompt: 'x', scope: [`${F}::slugify`] }] } }));
console.log(`open http://127.0.0.1:4317/?run=${encodeURIComponent(run)}`);
await new Promise((r) => setTimeout(r, gap * 3));

await step('1 sessions start', async () => { for (const a of ['a', 'b', 'c']) await hook(a, 'SessionStart'); });
await step('2 b reads and writes a caller', async () => {
  await tool('b', 'PostToolUse', 'Read', { file_path: join(wt.b, F) });
  write('b', DIAL('phone2numeric(n)')); await tool('b', 'PostToolUse', 'Edit', { file_path: join(wt.b, F) });
});
await step('3 a takes the signature', () => tool('a', 'PreToolUse', 'Edit', { file_path: join(wt.a, F), old_string: '(phone):', new_string: '(phone, *, strict):' }));
await step('4 a changes the signature', async () => {
  write('a', TEXT.replace('(phone):', '(phone, *, strict):')); await tool('a', 'PostToolUse', 'Edit', { file_path: join(wt.a, F) });
});
await step('5 b gets the notice', () => tool('b', 'PostToolUse', 'Read', { file_path: join(wt.b, 'README') }));
await step('6 c is denied', () => tool('c', 'PreToolUse', 'Edit', { file_path: join(wt.c, F), old_string: '(phone):', new_string: '(phone, region=None):' }));
await step('7 c edits the body', () => tool('c', 'PreToolUse', 'Edit', { file_path: join(wt.c, F), old_string: 'phone.upper()', new_string: 'str(phone).upper()' }));
await step('8 b stop blocked (rule 2)', () => hook('b', 'Stop', { stop_hook_active: false }));
await step('9 b fixes its caller', async () => { write('b', DIAL('phone2numeric(n, strict=False)')); await tool('b', 'PostToolUse', 'Edit', { file_path: join(wt.b, F) }); });
await step('10 b stop at barrier', () => hook('b', 'Stop', { stop_hook_active: false }));
await step('11 b stops', () => hook('b', 'Stop', { stop_hook_active: true }));
await step('12 a commits', async () => { git(wt.a, 'commit', '-qam', 'strict phone2numeric'); await tool('a', 'PostToolUse', 'Bash', { command: 'git commit -am x' }); });
await step('13 b woken', () => hook('b', 'UserPromptSubmit', { prompt: 'continue' }));
await step('14 c changes the body', async () => {
  write('c', TEXT.replace('phone.upper()', 'str(phone).upper()')); await tool('c', 'PostToolUse', 'Edit', { file_path: join(wt.c, F) });
});
await step('15 claims: a FAIL (strict is required), b UNKNOWN (dial untested), c VERIFIED', async () => {
  for (const a of ['a', 'b', 'c']) console.log(a, await post('/mcp/claim_done', { args: { task: a } }, { 'x-loom-agent': a, 'x-loom-run': run }));
});
console.log('lesson', await post('/lessons', { symbols: [`${F}::phone2numeric`], run,
  text: 'Callers of phone2numeric must pass strict= since it became keyword-only; unpack is the caller most often missed.' }));
console.log(`done: ${run}`);
