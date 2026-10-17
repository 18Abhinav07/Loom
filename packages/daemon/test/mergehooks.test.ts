import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { mergeHooks } from '../src/team/setup.js';

test('a stale loom-hook path is replaced, other hooks stay', () => {
  const sp = join(mkdtempSync(join(tmpdir(), 'mh-')), 'settings.json');
  writeFileSync(sp, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /old/loom/packages/hook/dist/loom-hook.cjs claude SessionStart' }] }, { hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  mergeHooks(sp, 'node /new/loom-v2/packages/hook/dist/loom-hook.cjs');
  mergeHooks(sp, 'node /new/loom-v2/packages/hook/dist/loom-hook.cjs');   // idempotent
  const cmds = JSON.parse(readFileSync(sp, 'utf8')).hooks.SessionStart.flatMap((h: any) => h.hooks.map((x: any) => x.command));
  expect(cmds).toEqual(['echo mine', 'node /new/loom-v2/packages/hook/dist/loom-hook.cjs claude SessionStart']);
});
