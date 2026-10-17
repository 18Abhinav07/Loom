// The repo every screen reads: ?cwd= in the page URL, else the directory the daemon runs in (/ctx).
import { getJson } from './stream';

let cwdP: Promise<string> | null = null;
export const repoCwd = (): Promise<string> =>
  (cwdP ??= new URLSearchParams(location.search).get('cwd') ? Promise.resolve(new URLSearchParams(location.search).get('cwd')!)
    : getJson<{ cwd: string }>('/ctx').then((c) => c.cwd).catch(() => ''));

/** The line a screen shows when the daemon refused or is unreachable (never an empty state). */
export const couldNot = (what: string, e: unknown) => `Could not load ${what}: ${(e as Error)?.message ?? e}`;

/** GET a repo-scoped view: the cwd rides along as ?cwd=. */
export async function api<T>(path: string): Promise<T> {
  return getJson<T>(`${path}${path.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(await repoCwd())}`);
}

/** POST JSON to a repo-scoped route. A refusal throws with the daemon's own message. */
export async function post<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, cwd: await repoCwd() }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? (Array.isArray(j.problems) ? j.problems.join('; ') : `${path}: ${r.status}`));
  return j;
}

export interface Compare {
  e1: { blind: { broke: number; n: number }; loom: { broke: number; n: number } };
  e5: { scenario: string; blind: Cell; loom: Cell }[];
}
export interface Cell { all_pass: number; n: number; broken: number; conflicts: number }
export interface TeamAgent { id: string; title: string; state: string; after: string[]; sid: string; branch: string; lands: string[]; resumed: number; lastReply?: string }
export interface Team { id: string; plan: string; goal: string; state: 'running' | 'done' | 'stopped'; agents: TeamAgent[]; startedAt: number }
export interface PlanRow { slug: string; goal: string; tasks: number }
export interface Collision { id: string; kind: string; region: string[]; parties: { person: string; session: string }[]; outcome: string; at: number; detail: string }
