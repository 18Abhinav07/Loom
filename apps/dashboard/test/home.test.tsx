// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Home } from '../src/Home';
import { COMPARE, mockApi } from './mock';

afterEach(cleanup);
const routes = { '/ctx': { cwd: '/r' }, '/bench/compare': COMPARE, '/plans': [{ slug: 'p1', goal: 'G', tasks: 2 }], '/brief': { text: 'Hello team' }, '/teams': [] };

describe('Home', () => {
  it('is just the hero: one action, no plan grid, no briefing, no corpus name', async () => {
    mockApi(routes);
    const { container } = render(<Home go={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Plan with the Lead/)).toBeTruthy());
    expect(screen.queryByText('Start a team from a plan')).toBeNull();
    expect(screen.queryByText('Briefing')).toBeNull();
    expect(container.textContent!.toLowerCase()).not.toContain('django');
  });

  it('empty /teams shows "No team running"', async () => {
    mockApi(routes);
    render(<Home go={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No agents working yet/)).toBeTruthy());
  });
});
