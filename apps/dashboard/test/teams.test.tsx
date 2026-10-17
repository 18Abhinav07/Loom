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

it('empty state when no team has run', async () => {
  mockApi({ '/ctx': { cwd: '/r' }, '/teams': [], '/collisions': [] });
  render(<Teams />);
  await waitFor(() => expect(screen.getByText(/No team running/)).toBeTruthy());
});
