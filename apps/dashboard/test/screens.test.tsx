// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Collisions } from '../src/Collisions';
import { Functions } from '../src/Functions';
import { Growth } from '../src/Growth';
import { People } from '../src/People';
import { Sessions } from '../src/Sessions';
import { mockApi } from './mock';

vi.mock('../src/GraphView', () => ({ GraphView: (p: { nodes: unknown[] }) => <div data-testid="graph">{p.nodes.length} nodes</div> }));
afterEach(cleanup);
const ctx = { '/ctx': { cwd: '/r' } };
const S1 = { sid: 's1', person: 'a@t', kind: 'interactive', parent: null, team: null, task: null, started: 1, turns: 2, handoff: 'slugify done' };

it('sessions lists a row per session and opens its turns', async () => {
  mockApi({ ...ctx, '/sessions/s1': { ...S1, turns: [{ from: 'user', text: 'make slugify safe', at: 1 }], versions: [], children: [] }, '/sessions': [S1] });
  render(<Sessions />);
  await waitFor(() => expect(screen.getByText('a@t')).toBeTruthy());
  fireEvent.click(screen.getByText('a@t'));
  await waitFor(() => expect(screen.getByText('make slugify safe')).toBeTruthy());
});
it('sessions shows an empty state', async () => {
  mockApi({ ...ctx, '/sessions': [] });
  render(<Sessions />);
  await waitFor(() => expect(screen.getByText(/No sessions recorded/)).toBeTruthy());
});

it('people lists everyone and draws the collaboration graph', async () => {
  mockApi({ ...ctx, '/people': [{ person: 'a@t', sessions: 2, agents: 1, regions: 3 }, { person: 'b@t', sessions: 1, agents: 1, regions: 1 }],
    '/collab': { nodes: [{ person: 'a@t' }, { person: 'b@t' }], edges: [{ a: 'a@t', b: 'b@t', shared: 1, collisions: 1 }] } });
  render(<People />);
  await waitFor(() => expect(screen.getByText('b@t')).toBeTruthy());
  expect(screen.getByTestId('graph').textContent).toBe('2 nodes');
});
it('people shows an empty state', async () => {
  mockApi({ ...ctx, '/people': [], '/collab': { nodes: [], edges: [] } });
  render(<People />);
  await waitFor(() => expect(screen.getByText(/No people yet/)).toBeTruthy());
});

it('collisions lists each with its kind and outcome', async () => {
  mockApi({ ...ctx, '/collisions': [{ id: 'c1', kind: 'divergence', region: ['pkg/text.py::slugify::definition#0'], parties: [{ person: 'a@t', session: 's1' }, { person: 'b@t', session: 's2' }], outcome: 'open', at: 1, detail: 'both changed slugify' }] });
  render(<Collisions />);
  await waitFor(() => expect(screen.getByText('divergence', { selector: 'b' })).toBeTruthy());
  expect(screen.getByText(/both changed slugify/)).toBeTruthy();
});
it('collisions shows an empty state', async () => {
  mockApi({ ...ctx, '/collisions': [] });
  render(<Collisions />);
  await waitFor(() => expect(screen.getByText(/No collisions/)).toBeTruthy());
});

it('functions searches regions and shows the function story', async () => {
  const R = 'pkg/text.py::slugify::definition#0';
  mockApi({ ...ctx, [`/regions/${encodeURIComponent(R)}`]: { id: R, path: 'pkg/text.py', versions: [{ id: 'v1', by: 'a@t', task: null, decision: 'keep it pure', commit: 'abc1234', at: 1 }], collisions: [] },
    '/regions?q=::definition': [{ id: R, path: 'pkg/text.py' }] });
  render(<Functions />);
  await waitFor(() => expect(screen.getByText('text.py')).toBeTruthy());
  fireEvent.click(screen.getByText('text.py'));
  await waitFor(() => expect(screen.getByText('slugify')).toBeTruthy());
  fireEvent.click(screen.getByText('slugify'));
  await waitFor(() => expect(screen.getByText(/keep it pure/)).toBeTruthy());
});

it('growth draws a stacked bar per bucket and an empty state', async () => {
  mockApi({ ...ctx, '/growth': [{ bucket: 'abc1234', person: 'a@t', added: 2, changed: 1, removed: 0 }, { bucket: 'abc1234', person: 'b@t', added: 1, changed: 0, removed: 0 }] });
  const { container } = render(<Growth />);
  await waitFor(() => expect(container.querySelectorAll('rect[data-person]').length).toBe(2));
  cleanup();
  mockApi({ ...ctx, '/growth': [] });
  render(<Growth />);
  await waitFor(() => expect(screen.getByText(/No history yet/)).toBeTruthy());
});
