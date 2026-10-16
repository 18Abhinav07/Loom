// B3: one active Loom session per Claude session id, so the lead and a second terminal in one checkout never share a record.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { activeSession, finishSession, readActive, startSession } from '../src/session.js';
import { closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const gitDir = (r: string) => sh(r, 'rev-parse', '--path-format=absolute', '--git-dir');
const events = (r: string, f: string) => readFileSync(join(r, '.loom/sessions', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('two Claude sessions in one checkout get two active files and two Loom sids; finishing one leaves the other', async () => {
  const r = repo({ 'a.py': 'x = 1\n' }); ensureLoomDir(r, CFG);
  const g = await testGraph();
  const a = await startSession(g, r, { person: 'a@t', kind: 'interactive', claudeSid: 's1' });
  const b = await startSession(g, r, { person: 'a@t', kind: 'interactive', claudeSid: 's2' });
  expect(a.sid).not.toBe(b.sid);
  expect(existsSync(join(gitDir(r), 'loom/sessions/s1.json'))).toBe(true);
  expect(existsSync(join(gitDir(r), 'loom/sessions/s2.json'))).toBe(true);
  expect(activeSession(r, 's1')?.sid).toBe(a.sid);
  expect(activeSession(r, 's2')?.sid).toBe(b.sid);
  await finishSession(g, r, { claudeSid: 's1' });
  expect(activeSession(r, 's1')).toBeNull();
  expect(activeSession(r, 's2')?.sid).toBe(b.sid);
  await g.drop();
});

test('the lead writer names its file <sid>.lead.jsonl; the session event carries surface, claude, parent, team, plan, task', async () => {
  const r = repo({ 'a.py': 'x = 1\n' }); ensureLoomDir(r, CFG);
  const g = await testGraph();
  const { sid } = await startSession(g, r, { person: 'a@t', kind: 'interactive', claudeSid: 'L1', writer: 'lead', surface: 'terminal', team: 'T', plan: 'P', task: 'k', parent: 'p0' });
  expect(readdirSync(join(r, '.loom/sessions'))).toContain(`${sid}.lead.jsonl`);
  expect(events(r, `${sid}.lead.jsonl`)[0]).toMatchObject({ type: 'session', surface: 'terminal', claude: 'L1', parent: 'p0', team: 'T', plan: 'P', task: 'k' });
  await g.drop();
});

test('callers without a Claude sid keep working under default, and readActive without a sid finds the only active session', async () => {
  const r = repo({ 'a.py': 'x = 1\n' }); ensureLoomDir(r, CFG);
  const g = await testGraph();
  const d = await startSession(g, r, { person: 'a@t', kind: 'interactive' });
  expect(existsSync(join(gitDir(r), 'loom/sessions/default.json'))).toBe(true);
  expect(readActive(r)?.sid).toBe(d.sid);
  await finishSession(g, r, {});
  expect(readActive(r)).toBeNull();
  const c = await startSession(g, r, { person: 'a@t', kind: 'interactive', claudeSid: 'c9' });
  expect(readActive(r)?.sid).toBe(c.sid);   // the pre-commit hook has no Claude sid: it records against the latest session
  await g.drop();
});
