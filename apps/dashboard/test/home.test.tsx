// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Home } from '../src/Home';
import { COMPARE, mockApi } from './mock';

afterEach(cleanup);
const routes = { '/ctx': { cwd: '/r' }, '/bench/compare': COMPARE, '/plans': [{ slug: 'p1', goal: 'G', tasks: 2 }], '/brief': { text: 'Hello team' }, '/teams': [] };

describe('Home', () => {
  it('renders proof numbers from /bench/compare and no "django"', async () => {
    mockApi(routes);
    const { container } = render(<Home go={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Without Loom 12\/12 broke/)).toBeTruthy());
    expect(screen.getByText(/With Loom 0\/12/)).toBeTruthy();
    expect(screen.getByText(/Loom 6\/6 · blind 0\/6/)).toBeTruthy();
    expect(container.textContent!.toLowerCase()).not.toContain('django');
  });

  it('empty /teams shows "No team running"', async () => {
    mockApi(routes);
    render(<Home go={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No agents working yet/)).toBeTruthy());
  });
});
