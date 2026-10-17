// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Teams } from '../src/Teams';
import { mockApi } from './mock';

afterEach(cleanup);
const agent = (i: number) => ({ id: `a${i}`, title: `Task ${i}`, state: i === 0 ? 'working' : 'waiting', after: i ? [`a${i - 1}`] : [], sid: `s${i}`, worktree: '/w', branch: `b${i}`, lands: [], resumed: 0, lastReply: i === 0 ? 'on it' : undefined });
const TEAM = { id: 't1', plan: 'big', goal: 'ship', repo: '/r', leadSid: null, person: 'p', landed: 'main', state: 'running', startedAt: 1, agents: [0, 1, 2, 3, 4].map(agent) };

it('teams screen renders one card per agent', async () => {
  mockApi({ '/ctx': { cwd: '/r' }, '/teams': [TEAM], '/collisions': [] });
  render(<Teams />);
  await waitFor(() => expect(screen.getAllByTestId('agent-card').length).toBe(5));
  expect(screen.getAllByText('on it').length).toBeGreaterThan(0);
});

it('message box posts to the team message route with agent and text', async () => {
  const calls = mockApi({ '/ctx': { cwd: '/r' }, '/teams/t1/message': { ok: true }, '/teams': [TEAM], '/collisions': [] });
  render(<Teams />);
  await waitFor(() => expect(screen.getAllByTestId('agent-card').length).toBe(5));
  fireEvent.click(screen.getAllByTestId('agent-card')[0]);   // the card opens the agent drawer, which holds the chat
  fireEvent.change(await screen.findByLabelText('message to agent'), { target: { value: 'use pure fns' } });
  fireEvent.click(await screen.findByRole('button', { name: /Send now/ }));
  await waitFor(() => expect(calls.some((c) => c.url === '/teams/t1/message')).toBe(true));
  const c = calls.find((c) => c.url === '/teams/t1/message')!;
  expect(c.init?.method).toBe('POST');
  expect(JSON.parse(String(c.init?.body))).toMatchObject({ agent: 'a0', text: 'use pure fns' });
});

it('empty state when no team has run', async () => {
  mockApi({ '/ctx': { cwd: '/r' }, '/teams': [], '/collisions': [] });
  render(<Teams />);
  await waitFor(() => expect(screen.getByText(/No team running/)).toBeTruthy());
});
