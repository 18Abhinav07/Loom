// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Bench } from '../src/Bench';
import { COMPARE, mockApi } from './mock';

afterEach(cleanup);
const pair = (i: number) => ({ id: `f${i}__sig`, func: `f${i}`, mech: 'signature', change: 'adds an argument', blind: { broke: true, seconds: 9 }, live: { broke: false, seconds: 12 } });
const BENCH = { 'e1-story': { pairs: Array.from({ length: 12 }, (_, i) => pair(i)) }, e1: { conds: { blind: { n: 12, interference: 12, cost_usd: 9.5, mean_b_seconds: 5 } } } };

it('renders 12/12 vs 0/12 and 0/3 vs 3/3, with no cost or time', async () => {
  mockApi({ '/ctx': { cwd: '/r' }, '/bench/compare': COMPARE, '/bench': BENCH });
  const { container } = render(<Bench />);
  await waitFor(() => expect(screen.getByText(/Without Loom 12\/12 broke/)).toBeTruthy());
  expect(screen.getByText(/With Loom 0\/12/)).toBeTruthy();
  expect(screen.getAllByText('0/3').length).toBe(2);
  expect(screen.getAllByText('3/3').length).toBe(2);
  expect(screen.getByText(/Loom 6\/6 · blind 0\/6/)).toBeTruthy();
  expect(screen.getAllByText('f0').length).toBe(1);
  const t = container.textContent!;
  expect(t).not.toContain('$');
  expect(t.toLowerCase()).not.toMatch(/wall|cost|seconds/);
});
