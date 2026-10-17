// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { Teams } from '../src/Teams';
import { COMPARE, mockApi } from './mock';

vi.mock('../src/GraphView', () => ({ GraphView: () => null }));
afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
const NOREPO = { __status: 404, error: 'not a Loom repo (run loom init)' };
const base = { '/ctx': { cwd: '/work/app' }, '/bench/compare': COMPARE, '/bench': {} };

it('a folder that was never set up gets the loom init instruction, not a "Could not load" error', async () => {
  mockApi({ ...base, '/teams': NOREPO, '/collisions': NOREPO });
  render(<Teams />);
  await waitFor(() => expect(screen.getByText('loom init')).toBeTruthy());
  expect(screen.queryByText(/Could not load/)).toBeNull();
});

it('a daemon error keeps its own message instead of a bare status code', async () => {
  mockApi({ ...base, '/teams': { __status: 500, error: 'graph is down' }, '/collisions': [] });
  render(<Teams />);
  await waitFor(() => expect(screen.getByText(/graph is down/)).toBeTruthy());
});

it('the top bar names the repo, has one tab per job, and Code Map holds Functions and Growth', async () => {
  mockApi({ ...base, '/teams': [], '/plans': [], '/brief': { text: '' }, '/growth': [] });
  render(<App />);
  expect((await screen.findByText('app')).tagName).toBe('B');
  for (const t of ['Home', 'Lead', 'Plans', 'Team', 'Code Map', 'Loom Log', 'Benchmark']) expect(screen.getByRole('button', { name: t })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Code Map' }));
  expect(screen.getByRole('button', { name: 'Functions' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Growth' })).toBeTruthy();
});

it('Plan with the Lead hands the typed brief to the lead page', async () => {
  mockApi({ ...base, '/teams': [], '/plans': [], '/brief': { text: '' } });
  const { container } = render(<App />);
  fireEvent.change(await screen.findByLabelText('what to build'), { target: { value: 'make slugify strict' } });
  fireEvent.click(screen.getByRole('button', { name: /Plan with the Lead/ }));
  await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBe('/lead?say=make%20slugify%20strict'));
});

it('the live dot shows on Team only while a team is running', async () => {
  const t = { id: 't', plan: 'p', goal: 'g', state: 'running', startedAt: 1, agents: [] };
  mockApi({ ...base, '/teams': [t], '/plans': [], '/brief': { text: '' } });
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelector('.tab .ldot')).toBeTruthy());
});

it('Home draws each running agent as a robot on the floor with its task and the landed count', async () => {
  const t = { id: 't', plan: 'p', goal: 'g', state: 'running', startedAt: 1, agents: [
    { id: 'slug', title: 'Make slugify strict', state: 'working', after: [], sid: 's', branch: 'b', lands: [] },
    { id: 'caps', title: 'Fix capfirst', state: 'done', after: [], sid: 's2', branch: 'b2', lands: ['c1'] }] };
  mockApi({ ...base, '/teams': [t], '/plans': [], '/brief': { text: '' } });
  const { container } = render(<App />);
  expect(await screen.findByText('Make slugify strict')).toBeTruthy();
  expect(container.querySelectorAll('.floor .agent5').length).toBe(2);
  expect(container.querySelectorAll('.landed5 .slot')[0].textContent).toBe('✓');
});

it('the Demo button replays the recorded run on Home, and Exit demo returns to the real team', async () => {
  mockApi({ ...base, '/teams': [], '/plans': [], '/brief': { text: '' }, '/demo/replay': { run: 'coord:replay:x' } });
  vi.stubGlobal('EventSource', class { onopen = null; onerror = null; onmessage = null; close() {} });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Demo' }));
  expect(await screen.findByText(/recorded run of 3 Claude agents/)).toBeTruthy();
  expect(screen.getByText(/demo · recorded run/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Exit demo' }));
  await waitFor(() => expect(screen.queryByText(/demo · recorded run/)).toBeNull());
  vi.unstubAllGlobals();
});
