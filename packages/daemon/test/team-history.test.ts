// A restarted daemon still lists the teams it ran: views are snapshotted under .loom/teams and a team that was running is shown as stopped.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { TeamRoutes } from '../src/team/routes.js';

test('past teams are listed after a restart; a running one is shown as stopped', () => {
  const repo = mkdtempSync(join(tmpdir(), 'loom-hist-'));
  mkdirSync(join(repo, '.loom', 'teams'), { recursive: true });
  const v = (id: string, state: string, startedAt: number) => ({ id, plan: 'p', goal: 'g', repo, leadSid: null, person: 'me', landed: 'loom/x/landed', state, startedAt, agents: [] });
  writeFileSync(join(repo, '.loom', 'teams', 'a.json'), JSON.stringify(v('a', 'done', 1)));
  writeFileSync(join(repo, '.loom', 'teams', 'b.json'), JSON.stringify(v('b', 'running', 2)));
  utimesSync(join(repo, '.loom', 'teams', 'b.json'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));   // untouched for a minute: its runner is gone
  const r = new TeamRoutes({} as never);
  expect(r.list(repo).map((t) => [t.id, t.state])).toEqual([['b', 'stopped'], ['a', 'done']]);
  expect(r.get('a')?.state).toBe('done');
});

test('a running snapshot rewritten a moment ago is still running (the benchmark runner keeps its file alive)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'loom-hist-')); mkdirSync(join(repo, '.loom', 'teams'), { recursive: true });
  writeFileSync(join(repo, '.loom', 'teams', 'c.json'), JSON.stringify({ id: 'c', plan: 'p', goal: 'g', repo, leadSid: null, person: 'x', landed: '', state: 'running', agents: [], startedAt: 3 }));
  expect(new TeamRoutes({} as never).list(repo).find((t) => t.id === 'c')?.state).toBe('running');
});
