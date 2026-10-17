// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Functions } from '../src/Functions';
import { Plans } from '../src/Plans';
import { Teams } from '../src/Teams';
import { files, landText, person, startedBy } from '../src/explain';
import { mockApi } from './mock';

afterEach(cleanup);
const WHO = '1+ada@users.noreply.github.com';
const agent = (id: string, lands: string[]) => ({ id, title: `Task ${id}`, state: 'landed', after: [], sid: id, worktree: '/w', branch: id, lands, resumed: lands.length > 1 ? 1 : 0 });
const TEAM = { id: 't1', plan: 'todoapp', goal: 'Python CLI todo app', repo: '/r', leadSid: null, person: WHO, landed: 'loom/x/landed', state: 'done', startedAt: Date.now() - 60_000, agents: [agent('store', ['landed']), agent('docs', ['tests_failed', 'landed'])] };

it('explain turns codes and ids into plain language', () => {
  expect(person(WHO)).toBe('ada');
  expect(files(['a.py::f::definition#0', 'a.py::g::definition#0', 'b.py::x::gap#0'])).toEqual(['a.py', 'b.py']);
  expect(landText('tests_failed')).toMatch(/tests failed/);
  expect(landText('contract_break')).toMatch(/no longer fits/);
  expect(startedBy(TEAM)).toBe('ada · started from plan todoapp, no Lead session');
  expect(startedBy({ ...TEAM, leadSid: 'abc123456' })).toContain('planned by Lead session 123456');
});

it('plans shows who ran each plan, when, and what landed', async () => {
  mockApi({ '/plans/check': { ok: true, problems: [], warnings: [] }, '/plans/todoapp': { slug: 'todoapp', problems: [], plan: { goal: 'Python CLI todo app', tasks: [{ id: 'store', title: 'Task store', after: [], owns: ['todo/store.py'] }] } }, '/plans': [{ slug: 'todoapp', goal: 'g', tasks: 1 }], '/teams': [TEAM] });
  render(<Plans go={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/Who ran this plan/)).toBeTruthy());
  await waitFor(() => expect(screen.getByText(/ada · started from plan todoapp, no Lead session/)).toBeTruthy());
  expect(screen.getByText(/2 of 2 agents landed/)).toBeTruthy();
  expect(screen.getByText('todo/store.py')).toBeTruthy();
});

it('team explains a sent-back landing in words', async () => {
  mockApi({ '/ctx': { cwd: '/r' }, '/teams': [TEAM], '/collisions': [] });
  render(<Teams />);
  await waitFor(() => expect(screen.getAllByTestId('agent-card').length).toBe(2));
  expect(screen.getByText(/Sent back: the tests failed on the merged result/)).toBeTruthy();
  expect(screen.getByText(/started from plan todoapp, no Lead session/)).toBeTruthy();
});

it('code map says what to do when no code is mapped', async () => {
  mockApi({ '/regions': [] });
  render(<Functions />);
  await waitFor(() => expect(screen.getByText('No code mapped yet.')).toBeTruthy());
  expect(screen.getByText(/loom init/)).toBeTruthy();
});

it('code map lists mapped functions without a search', async () => {
  mockApi({ '/regions': [{ id: 'todo/cli.py::main::definition#0', path: 'todo/cli.py' }] });
  render(<Functions />);
  await waitFor(() => expect(screen.getByText('cli.py')).toBeTruthy());
  expect(screen.getByText('1 function')).toBeTruthy();
  fireEvent.click(screen.getByText('cli.py'));
  await waitFor(() => expect(screen.getByText('main')).toBeTruthy());
});
