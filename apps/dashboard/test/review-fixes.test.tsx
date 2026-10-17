// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Bench } from '../src/Bench';
import { Home } from '../src/Home';
import { Sessions } from '../src/Sessions';
import { Teams } from '../src/Teams';
import { COMPARE, mockApi } from './mock';

afterEach(cleanup);
const ctx = { '/ctx': { cwd: '/r' } };
const team = (id: string, state: string, startedAt: number) => ({ id, plan: `plan-${id}`, goal: 'g', repo: '/r', leadSid: null, person: 'p', landed: 'main', state, startedAt, agents: [] });

it('bench raw records never print the corpus name', async () => {
  mockApi({ ...ctx, '/bench/compare': COMPARE, '/bench': { 'e4-indexer': { file: 'django/utils/text.py', p50: 3 } } });
  const { container } = render(<Bench />);
  await waitFor(() => expect(screen.getByText(/Without Loom 12\/12/)).toBeTruthy());
  expect(container.textContent).not.toMatch(/django/i);
});

it('a missing E5 result is shown as not run, not as 0/0', async () => {
  mockApi({ ...ctx, '/bench/compare': { ...COMPARE, e5: [] }, '/bench': {}, '/plans': [], '/brief': { text: '' }, '/teams': [] });
  const b = render(<Bench />);
  await waitFor(() => expect(screen.getByText(/Without Loom 12\/12/)).toBeTruthy());
  expect(b.container.textContent).not.toContain('0/0');
  expect(b.container.textContent).toMatch(/Real agents: not run/);
});

it('a missing E1 result does not blank the app', async () => {
  mockApi({ ...ctx, '/bench/compare': { e1: {}, e5: [] }, '/bench': {} });
  const { container } = render(<Bench />);
  await waitFor(() => expect(screen.getByText('StaleBench')).toBeTruthy());
  expect(container.textContent).toMatch(/E1.*not run/);
});

it('teams offers a picker when several teams exist, newest running first', async () => {
  mockApi({ ...ctx, '/teams': [team('old', 'done', 1), team('r1', 'running', 2), team('r2', 'running', 3)], '/collisions': [] });
  render(<Teams />);
  const pick = (await screen.findByLabelText('team')) as HTMLSelectElement;
  expect(pick.value).toBe('r2');
  fireEvent.change(pick, { target: { value: 'r1' } });
  expect(screen.getByText('plan-r1')).toBeTruthy();
});

it('a failing API is an error, not an empty state', async () => {
  mockApi({ ...ctx });
  render(<Sessions />);
  await waitFor(() => expect(screen.getByText(/Could not load/)).toBeTruthy());
  expect(screen.queryByText(/No sessions recorded/)).toBeNull();
  cleanup();
  mockApi({ ...ctx });
  render(<Teams />);
  await waitFor(() => expect(screen.getByText(/Could not load/)).toBeTruthy());
  expect(screen.queryByText(/No team running/)).toBeNull();
});
