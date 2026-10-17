import { vi } from 'vitest';

/** Stub fetch with a route table: the first key the request URL contains answers (a function gets the init). */
export function mockApi(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    const v = key === undefined ? undefined : routes[key];
    const body = typeof v === 'function' ? (v as (i?: RequestInit) => unknown)(init) : v;
    return { ok: key !== undefined, status: key !== undefined ? 200 : 404, json: async () => body ?? {} };
  }));
  return calls;
}

export const COMPARE = {
  e1: { blind: { broke: 12, n: 12 }, loom: { broke: 0, n: 12 } },
  e5: [
    { scenario: 't1_slugpath', blind: { all_pass: 0, n: 3, broken: 3, conflicts: 0 }, loom: { all_pass: 3, n: 3, broken: 0, conflicts: 0 } },
    { scenario: 'x1_textlist', blind: { all_pass: 0, n: 3, broken: 3, conflicts: 0 }, loom: { all_pass: 3, n: 3, broken: 0, conflicts: 0 } },
  ],
};
