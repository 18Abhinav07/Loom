// A restarted daemon still lists the teams it ran: views are snapshotted under .loom/teams and a team that was running is shown as stopped.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  const r = new TeamRoutes({} as never);
  expect(r.list(repo).map((t) => [t.id, t.state])).toEqual([['b', 'stopped'], ['a', 'done']]);
  expect(r.get('a')?.state).toBe('done');
});
