#!/usr/bin/env node
// Stand-in for `claude -p`: follows a `FAKE: {json}` script in its prompt and fires the worktree's hooks the way Claude does.
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const agent = process.env.LOOM_AGENT ?? basename(process.cwd());   // --blind sets no LOOM_* env; worktrees are named by task
if (process.env.FAKE_LOG) appendFileSync(join(process.env.FAKE_LOG, `${agent}.args`), JSON.stringify(argv) + '\n');
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const resume = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null;
const session = resume ?? `fake-${agent}`;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: session });

const hooks = existsSync('.claude/settings.local.json') ? JSON.parse(readFileSync('.claude/settings.local.json', 'utf8')).hooks ?? {} : {};   // --blind: no hooks
function fire(event, extra = {}) {
  let res = '';
  for (const h of hooks[event] ?? []) {
    if (h.matcher && h.matcher !== '*' && extra.tool_name && !new RegExp(`^(${h.matcher})$`).test(extra.tool_name)) continue;
    for (const x of h.hooks) res += execSync(x.command, { input: JSON.stringify({ hook_event_name: event, session_id: session, cwd: process.cwd(), ...extra }), encoding: 'utf8' });
  }
  if (res) out({ type: 'hook', event, output: res });
  return res;
}

fire('SessionStart');
const m = /FAKE: (\{.*\})/.exec(prompt);
// a resume prompt is Loom's wake text: play the next of the first run's `resumes` scripts
const next = process.env.FAKE_LOG ? join(process.env.FAKE_LOG, `${agent}.resumes`) : '';
let s = m ? JSON.parse(m[1]) : {};
if (m && next) writeFileSync(next, JSON.stringify(s.resumes ?? []));
else if (resume && next && existsSync(next)) { const q = JSON.parse(readFileSync(next, 'utf8')); s = q.shift() ?? {}; writeFileSync(next, JSON.stringify(q)); }
if (s.sleep) await new Promise((r) => setTimeout(r, s.sleep));
if (s.read) fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: resolve(s.read) }, tool_response: {} });
for (const [file, old, now] of s.edits ?? (s.edit ? [s.edit] : [])) {
  const input = { file_path: resolve(file), old_string: old, new_string: now };
  if (fire('PreToolUse', { tool_name: 'Edit', tool_input: input }).includes('"deny"')) out({ type: 'result', subtype: 'edit_denied' });
  else {
    writeFileSync(file, readFileSync(file, 'utf8').replace(old, now));
    fire('PostToolUse', { tool_name: 'Edit', tool_input: input, tool_response: {} });
  }
}
if (s.hold) await new Promise((r) => setTimeout(r, s.hold));   // keep the leases a while after editing
if (s.stop) fire('Stop', { stop_hook_active: false });   // a block is honoured by stopping here; Loom resumes us later
process.exit(s.exit ?? 0);
