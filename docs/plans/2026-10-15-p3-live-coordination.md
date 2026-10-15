# P3 — Live Coordination on Regions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Claude Code session in a Loom repo — two interactive terminals or the agents of one `loom run` — coordinates live on **regions** in the repo graph: leases, the §6.5 version check, notices built at delivery, code handover with a dirty worktree, a serialized merge queue, and the RC1–RC6 fixes.

**Architecture:** A new `Live` class (`packages/daemon/src/live/`) works on the repo graph that `resolveRepo` returns. It is the only v2 live path. Interactive sessions and `loom run` agents both reach it through the hook route. v1's `Coordinator` stays as it is, and is reached only for runs registered through `/admin/runs` (frozen E1 reproducibility). It gets no new features. `lease.ts` keeps its CAS query and changes only its target label, from `Symbol` to `Region`. Handover and the merge queue are plain functions, called by the daemon (at the agent's next hook) and by `run.ts` (before a resume).

**Tech Stack:** TypeScript, pnpm, vitest 2.1.8, FalkorDB in docker, git ≥ 2.40 (`merge --autostash`, `merge-file`), `@loom/indexer` region API, `@loom/memory` (P2).

**Spec:** `docs/specs/2026-10-15-loom-v2-design.md` §4.5, §6.2 steps 2–4 and 6, §6.5, §6.6, §10 (L0, S1, STALE core, E5).

## Global Constraints

- Lease TTL is 10 minutes. Every hook call from the holder renews it, and SessionEnd releases it (§4.5).
- Lease modes: `write` conflicts with `write`; `contract` conflicts with `write` and `contract` (§4.5).
- Notices reach regions within **3 hops** (§6.2.3).
- Back-off: a 3rd denial for the same agent and region within **60 s** returns "stop editing R; you will be woken" (§6.6.6).
- Wakes and notices are filtered on `holder ≠ recipient` (§6.6.7).
- Wake and notice text is built **when it is delivered**, and never cached (§6.6.4.5).
- Hooks fail open within 2 s and never return a 500 (§6, P2-9).
- Agent runs use the Claude Code CLI on the subscription only: model Sonnet, all `ANTHROPIC_*` variables stripped. STALE core and E5 each need an explicit go-ahead before they run.
- Gates (L0 coordination, S1) are deterministic and cost $0. Agent benchmarks are reported whatever their result.
- TDD: each test is written first and watched failing. Tests are never tuned to pass.
- Temp files go in the scratchpad: `/private/tmp/claude-501/-Users-18abhinav07-Documents-Brain-10-Projects/50197c36-9a7e-41cf-9454-d11503a74c36/scratchpad`.

## Review Focus

1. **A handover that runs while the agent is mid-edit.** Expected: handover runs only inside that agent's own hook call (the agent is blocked) or before a resume (the agent is stopped), never from another agent's hook. Pinned in Task 6 ("handover runs only at the agent's own hook").
2. **The stash cannot be re-applied after a regionMerge resolve.** Expected: the worktree keeps the markers, the stash stays in `git stash list`, and the wake says so. It never silently drops the agent's edits. Pinned in Task 4 ("stash pop conflict keeps the stash").
3. **The same person in two terminals.** Expected: two sessions by the same person are two agents and contend for leases. The version check is the only place "someone else" is judged by person. Pinned in Task 5 ("same person, two sessions").
4. **An edit to a file that does not parse after the edit** (the shifted map, P1-5). Expected: the touched regions come from the degraded map's `touched`, so the lease still applies. It must not fail open into "no regions touched". Pinned in Task 2.
5. **The daemon restarts during a run.** Expected: leases live in the graph, so they survive, and an expired lease is swept on the first hook after the restart. Pinned in Task 5 ("sweep after restart").

---

## Rulings made while planning

1. **A new `Live` class, not a retarget of `Coordinator`.** The 682-line v1 `Coordinator` is built on `Symbol`, `indexPython` and the run graph from end to end. Rewriting it in place would put E1's frozen results and its 40-odd tests at risk. `Live` reuses the v1 pieces that still fit (the `lease.ts` CAS, the `notice.ts` scoring, `predict.ts` `applyEdits`) and puts everything new on Regions. *Cost if wrong:* two coordination code paths stay alive until v1 is deleted after submission.
2. **The lease target is the `Region` node in the repo graph.** `lease.ts` gets a `label` parameter, default `'Region'`. v1 passes `'Symbol'`. Only *existing* region ids are leased (updated, tombstoned, renamed-from). Created regions are new code, so they have no lease conflicts (§6.2.2.2). *Cost if wrong:* two agents adding the same new function both get through; the merge queue catches it as a conflict.
3. **Mode:** `contract` when any touched region's `sig` differs between before and after, or when a region is tombstoned or renamed. Otherwise `write`. This is v1's rule with `sig` in place of `sigHash`.
4. **Handover runs only when the agent cannot be editing:** at the start of that agent's own PreToolUse or PostToolUse hook call, or in `run.ts` before a resume. The daemon marks `Agent.syncPending = true`. It never runs git in another agent's worktree from someone else's hook. *Cost if wrong:* a running agent sees landed code one tool call late.
5. **Version check upstream:** an interactive session uses `@{upstream}`, falling back to `origin/<default>`, falling back to none (no remote means no check). A run agent uses `loom/<run8>/landed`. "Someone else" is the Version's `BY` person ≠ this session's person. For a run agent the comparison is by agent id, because all run agents share one person.
6. **`ack_notice` on a stale notice records `(:Agent)-[:ACKED {version}]->(:Region)`.** The check passes while the region's current upstream version equals the acked version, so it stops passing when a *newer* version appears (§6.5).
7. **Back-off state lives in memory in `Live`,** keyed by `agent|region`, holding timestamps from the last 60 s. A daemon restart forgets it. That costs at most two extra denials.
8. **Covering tests for the merge queue:** the TESTS edges into the changed regions → the distinct test file paths → `<testCmd> <paths…>` when `testCmd` is pytest-like (starts with `python -m pytest` or `pytest`). Otherwise the full `testCmd`. If there are no TESTS edges, the full `testCmd`. If there is no `testCmd`, no tests are run, and the landing records `tests: null`.
9. **v2 runs register through `/admin/v2/runs`.** The `x-loom-run` header on a v2 run's hooks names that run, so the agent id comes from the header and the graph comes from `resolveRepo(cwd)`. v1 runs keep `/admin/runs`.
10. **RC4 needs no new code.** P1/P2 `indexRepo` regionizes every tracked file, and `buildEdges` makes TESTS edges from `TEST_PATH`. Task 9 adds the L0 assertion that a `tests/` region is leased like any other.

---

## File map

| File | Responsibility |
|---|---|
| `packages/daemon/src/lease.ts` (modify) | CAS on a `label` parameter (`Region` by default) |
| `packages/daemon/src/live/touch.ts` | before/after text → touched region ids + lease mode |
| `packages/daemon/src/live/stale.ts` | §6.5 version check + ack |
| `packages/daemon/src/live/handover.ts` | `git merge --autostash` → regionMerge → markers + brief |
| `packages/daemon/src/live/render.ts` | deny, notice and wake text, built from the graph at delivery |
| `packages/daemon/src/live/live.ts` | `Live`: register, preEdit, postEdit, unseen writes, notices, back-off, wake, sweep, release, land |
| `packages/daemon/src/live/queue.ts` | merge queue: serialized landing, covering tests, fast-forward |
| `packages/daemon/src/server.ts` (modify) | hook and MCP routing into `Live` |
| `packages/cli/src/run.ts` (modify) | v2 run: landed branch, queue, handover before resume |
| `bench/e5/run.py` (modify) | grader on the full final merge (§6.6.9) |
| `packages/daemon/test/live/*.test.ts` | unit tests per module |
| `packages/daemon/test/l0-coord.test.ts` | L0 coordination gate |
| `bench/s1/s1.ts` | S1 gate → `bench/results/s1.txt` |

---

### Task 1: Lease on Regions + S1 gate

**Files:**
- Modify: `packages/daemon/src/lease.ts`, `packages/daemon/src/coordinator.ts` (pass `'Symbol'`)
- Create: `packages/daemon/test/live/lease-region.test.ts`, `bench/s1/s1.ts`

**Interfaces:**
- Produces: `acquire(g, agent, ids, mode, task, now?, ttl?, label = 'Region')`, `holders(g, agent, ids, mode, now?, label = 'Region')`, `renew(g, agent, now?, ttl?)`, `release(g, agent, ids?, label = 'Region')`, `expired(g, now?, label = 'Region')`. The return shapes are unchanged; `Holder.symbol` keeps its name (it holds a region id).

- [ ] **Step 1: Write the failing test** — `packages/daemon/test/live/lease-region.test.ts`
```ts
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { acquire, expired, holders, release } from '../../src/lease.js';

let db: LoomDb; let g: LoomGraph;
const R = ['a.py::f::definition#0', 'a.py::g::definition#0'];
beforeAll(async () => {
  db = await LoomDb.connect(); g = db.graph(`loom:test:lease-${process.pid}`);
  await g.query('UNWIND $r AS id CREATE (:Region {id: id, path: "a.py"})', { r: R });
  await g.query('UNWIND ["x","y"] AS a CREATE (:Agent {id: a})');
});
afterAll(async () => { await g.drop(); await db.close(); });

test('leases target Region nodes; write blocks write; contract blocks contract; expiry frees', async () => {
  expect(await acquire(g, 'x', [R[0]], 'write', 't1')).toBe(1);
  expect(await acquire(g, 'y', [R[0]], 'write', 't2')).toBe(0);
  expect((await holders(g, 'y', [R[0]], 'write')).map((h) => h.holder)).toEqual(['x']);
  expect(await acquire(g, 'y', [R[1]], 'contract', 't2')).toBe(1);
  expect(await acquire(g, 'x', [R[1]], 'contract', 't1')).toBe(0);
  expect((await expired(g, Date.now() + 11 * 60_000)).map((e) => e.symbol).sort()).toEqual([...R].sort());
  expect(await release(g, 'x')).toEqual([R[0]]);
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/daemon/test/live/lease-region.test.ts`
Expected: FAIL. `acquire` returns 0, because the CAS matches `Symbol`.

- [ ] **Step 3: Implement**
In `lease.ts`, make `CAS` a function `cas(label)` that returns the query with `MATCH (s:${label} {id: sid})`. Do the same for the `holders`, `release` and `expired` queries. `label` is whitelisted to `'Region' | 'Symbol'` (it is interpolated, so it is never taken from input). In `coordinator.ts`, every call passes `'Symbol'`.

- [ ] **Step 4: Run it to see it pass, and check v1**
Run: `npx vitest run packages/daemon/test/live/lease-region.test.ts packages/daemon/test/lease.test.ts packages/daemon/test/coordinator.test.ts`
Expected: PASS, with v1's lease and coordinator tests unchanged.

- [ ] **Step 5: S1 gate** — `bench/s1/s1.ts`
```ts
// S1: 32 simulated agents × 200 lease ops on one graph, no LLM. Bar: 0 double grants. Reports p50/p99.
import { LoomDb } from '@loom/core';
import { acquire, release } from '../../packages/daemon/src/lease.js';
const AGENTS = 32, OPS = 200, REGIONS = 64;
const db = await LoomDb.connect(); const g = db.graph(`loom:s1:${Date.now()}`);
await g.query('UNWIND range(0, $n - 1) AS i CREATE (:Region {id: "r" + toString(i)})', { n: REGIONS });
await g.query('UNWIND range(0, $n - 1) AS i CREATE (:Agent {id: "a" + toString(i)})', { n: AGENTS });
const lat: number[] = []; let doubles = 0; let grants = 0;
await Promise.all(Array.from({ length: AGENTS }, async (_, i) => {
  for (let k = 0; k < OPS; k++) {
    const r = `r${Math.floor(Math.random() * REGIONS)}`; const t = performance.now();
    const got = await acquire(g, `a${i}`, [r], 'write', 's1'); lat.push(performance.now() - t);
    if (got) {
      grants++;
      const [{ n }] = await g.query<{ n: number }>('MATCH (:Agent)-[l:LEASED]->(:Region {id: $r}) WHERE l.expires > $now RETURN count(l) AS n', { r, now: Date.now() });
      if (n > 1) doubles++;
      await release(g, `a${i}`, [r]);
    }
  }
}));
lat.sort((a, b) => a - b);
const p = (q: number) => lat[Math.floor(q * (lat.length - 1))].toFixed(1);
console.log(`S1 agents=${AGENTS} ops=${AGENTS * OPS} grants=${grants} double_grants=${doubles} p50_ms=${p(0.5)} p99_ms=${p(0.99)}`);
await g.drop(); await db.close(); process.exit(doubles ? 1 : 0);
```
Run: `npx tsx bench/s1/s1.ts | tee bench/results/s1.txt`
Expected: `double_grants=0`, exit 0. The p50 and p99 are recorded whatever they are.

---

### Task 2: Touched regions + lease mode

**Files:**
- Create: `packages/daemon/src/live/touch.ts`, `packages/daemon/test/live/touch.test.ts`

**Interfaces:**
- Consumes: `regionize`, `diffRegions` from `@loom/indexer`; `applyEdits` from `../predict.js`
- Produces: `touched(path: string, before: string | null, after: string | null): Promise<{ ids: string[]; created: string[]; mode: LeaseMode | null }>` and `predictTouched(root: string, it: EditIntent): Promise<… | null>` (null when `applyEdits` cannot apply the edit).

- [ ] **Step 1: Write the failing test**
```ts
import { expect, test } from 'vitest';
import { touched } from '../../src/live/touch.js';
const A = 'def f(x):\n    return x\n\ndef g():\n    return f(1)\n';

test('body edit → write on that region only', async () => {
  expect(await touched('a.py', A, A.replace('return x', 'return x + 1'))).toEqual({ ids: ['a.py::f::definition#0'], created: [], mode: 'write' });
});
test('signature edit → contract', async () => {
  expect((await touched('a.py', A, A.replace('f(x)', 'f(x, y=0)'))).mode).toBe('contract');
});
test('new function → created, nothing to lease; new file → no lease', async () => {
  const r = await touched('a.py', A, `${A}\ndef h():\n    return 2\n`);
  expect(r.ids.filter((i) => i.includes('::h::'))).toEqual([]);
  expect(r.created).toContain('a.py::h::definition#0');
  expect((await touched('b.py', null, 'def z():\n    pass\n')).mode).toBeNull();
});
test('an edit that breaks the parse still names the region (shifted map)', async () => {
  const r = await touched('a.py', A, A.replace('return x', 'return (x'));
  expect(r.ids).toContain('a.py::f::definition#0');
  expect(r.mode).not.toBeNull();
});
test('tests/ files are regions too (RC4)', async () => {
  expect((await touched('tests/test_a.py', 'def test_f():\n    assert 1\n', 'def test_f():\n    assert 2\n')).ids).toEqual(['tests/test_a.py::test_f::definition#0']);
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/daemon/test/live/touch.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `touch.ts`
- `before === null` → `{ ids: [], created: <all after ids>, mode: null }`.
- Otherwise `B = regionize(path, before)` and `A = regionize(path, after ?? '', { lastClean: B.degraded ? undefined : B })`, then `d = diffRegions(B.regions, A.regions)`.
- When `A.degraded`, `ids = A.touched ?? []`, with mode `write`, upgraded to `contract` if any touched id's `sig` changed or is missing in A.
- Otherwise `ids = [...d.updated, ...d.tombstoned, ...d.renamed.map((r) => r.from)]`, deduped and sorted. `mode` is null when `ids` is empty. It is `contract` when a tombstone or rename is present, or when any updated id has `B.sig !== A.sig`. Otherwise it is `write`.
- `gap` and `imports` regions count as touched, because they are code too.
- `predictTouched` reads `join(root, it.file)` (null if missing), runs `applyEdits`, and calls `touched`.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/daemon/test/live/touch.test.ts`
Expected: PASS 5/5.

---

### Task 3: Version check (§6.5)

**Files:**
- Create: `packages/daemon/src/live/stale.ts`, `packages/daemon/test/live/stale.test.ts`

**Interfaces:**
- Consumes: `currentVersion`, `isAncestor` from `@loom/memory`
- Produces:
  - `upstreamOf(top: string, runLanded?: string): string | null`
  - `staleRegions(g, top, ids: string[], o: { upstream: string; me: { person: string; agent: string; run: boolean } }): Promise<Stale[]>`, where `Stale = { region: string; version: string; by: string; task: string | null; decision: string | null; summary: string }`
  - `ackStale(g, agent: string, region: string, version: string): Promise<void>`

- [ ] **Step 1: Write the failing test.** It sets up a real git repo with a bare origin and two clones, A and B, via `initRepo` (the same helpers as `l0-memory.test.ts`). A commits a change to `slugify` through the hooks and pushes. B fetches without pulling.
```ts
test('B edits slugify after A pushed a change to it: stale, by A, with the summary', async () => {
  const s = await staleRegions(gb, b, [SLUG], { upstream: 'origin/main', me: { person: 'B@t', agent: 'b1', run: false } });
  expect(s).toHaveLength(1); expect(s[0]).toMatchObject({ region: SLUG, by: 'A@t' });
});
test('after B pulls: not stale', async () => { g(b, 'pull', '-q'); expect(await staleRegions(gb, b, [SLUG], OPTS_B)).toEqual([]); });
test('ack passes until a newer version appears', async () => {
  /* A pushes v2; B fetches; stale → ackStale(v2) → [] → A pushes v3; B fetches → stale again */
});
test('my own pushed version is never stale for me', async () => {
  expect(await staleRegions(ga, a, [SLUG], { upstream: 'origin/main', me: { person: 'A@t', agent: 'a1', run: false } })).toEqual([]);
});
test('no upstream → no check', () => { expect(upstreamOf(noRemoteRepo)).toBeNull(); });
```
Write the ack case's body in full in the test file: three commits, the fetches and the asserts, with no comments left as stubs.

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/daemon/test/live/stale.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `stale.ts`
- `upstreamOf`: if `runLanded` is given, return it. Otherwise `git rev-parse --abbrev-ref @{upstream}`, falling back to `origin/HEAD` resolved to `origin/<default>`, falling back to null.
- `staleRegions`: for each id, `v = currentVersion(g, top, id, upstream)`. Skip if `v` is null, or if any of `v.commits` is an ancestor of `HEAD`. Read `v`'s BY person (or agent, for a run) and skip if it is me. Skip if `(me.agent)-[:ACKED {version: v}]->(region)` exists. Otherwise push `Stale`, with the task and decision from `history()`'s row for `v`, and `summary` = `"<qname> changed on <upstream> by <by>[ (task …)][: decision]"`.
- `ackStale`: `MERGE (a:Agent {id})-[k:ACKED]->(r:Region {id}) SET k.version = $v`.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/daemon/test/live/stale.test.ts`
Expected: PASS 5/5.

---

### Task 4: Handover — autostash, regionMerge, markers (RC1, RC2)

**Files:**
- Create: `packages/daemon/src/live/handover.ts`, `packages/daemon/test/live/handover.test.ts`

**Interfaces:**
- Consumes: `regionMerge` from `@loom/indexer`
- Produces: `handover(wt: string, ref: string): Promise<Handover>`, where `Handover = { status: 'clean' | 'resolved' | 'conflict' | 'noop'; files: string[]; regions: string[]; stashKept: boolean }`

- [ ] **Step 1: Write the failing test.** Each case builds a repo with a base commit, then a `landed` branch commit and a worktree with uncommitted edits.
```ts
test('RC2: dirty edits in the same file but other lines: plain merge refuses, handover is clean, dirty edits kept', async () => {
  /* landed edits f; the worktree has uncommitted edits in g in the same file */
  expect(spawnSync('git', ['merge', '--no-edit', 'landed'], { cwd: wt }).status).not.toBe(0);   // the RC2 bug, reproduced
  const h = await handover(wt, 'landed');
  expect(h.status).toBe('clean');
  expect(read(wt, 'a.py')).toContain(LANDED_F); expect(read(wt, 'a.py')).toContain(DIRTY_G);
});
test('committed edits touching-hunk in different regions: git conflicts, regionMerge resolves', async () => {
  expect((await handover(wt, 'landed')).status).toBe('resolved');
  expect(git(wt, 'diff', '--name-only', '--diff-filter=U')).toBe('');
});
test('same region on both sides: markers left, regions named', async () => {
  const h = await handover(wt, 'landed');
  expect(h).toMatchObject({ status: 'conflict', regions: ['a.py::f::definition#0'] });
  expect(read(wt, 'a.py')).toContain('<<<<<<<');
});
test('stash pop conflict keeps the stash', async () => {
  /* landed edits f's body; the worktree's dirty edit is also in f */
  const h = await handover(wt, 'landed');
  expect(h.stashKept).toBe(true);
  expect(git(wt, 'stash', 'list')).not.toBe('');
});
test('already up to date → noop', async () => { expect((await handover(wt, 'landed')).status).toBe('noop'); });
```
Write each `/* … */` setup out in full in the test file. Each one is 3–6 git and writeFile lines.

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/daemon/test/live/handover.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `handover.ts`
1. If `git merge-base --is-ancestor <ref> HEAD`, return `noop`.
2. Run `git -c user.email=loom@local -c user.name=loom merge --autostash --no-edit <ref>`. On exit 0, return `clean`. `stashKept` is true when `git stash list` grew (autostash pop conflicted).
3. Otherwise list the conflicted files (`diff --name-only --diff-filter=U`). For each, take `base = show :1:f`, `ours = :2:f`, `theirs = :3:f` and call `regionMerge(f, base, ours, theirs)`. On `merged`, write the text and `git add f`. Otherwise collect its regions (if `unsupported`, the whole file's id `f::file`).
4. If every file resolved, `git commit --no-edit`, then status `resolved`. If `MERGE_AUTOSTASH` exists, `git stash pop` and set `stashKept` on failure.
5. Otherwise return `conflict` with the regions, and leave the markers. Git keeps the autostash as a stash entry.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/daemon/test/live/handover.test.ts`
Expected: PASS 5/5.

---

### Task 5: `Live` — preEdit, postEdit, notices, back-off, wake, sweep, release

**Files:**
- Create: `packages/daemon/src/live/live.ts`, `packages/daemon/src/live/render.ts`, `packages/daemon/test/live/live.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `lessonsFor` from `@loom/memory`; `score` and `THRESHOLD` from `../notice.js`
- Produces:
```ts
export interface LiveAgent { id: string; person: string; worktree: string; top: string; upstream: string | null; run: string | null; task: string | null; scope: string[] }
export class Live {
  constructor(g: LoomGraph, o?: { now?: () => number; backoffMs?: number });
  register(a: LiveAgent): Promise<void>;
  preEdit(agent: string, it: EditIntent): Promise<{ allow: true; context?: string } | { allow: false; reason: string }>;
  postEdit(agent: string, file: string): Promise<{ changed: string[]; notices: number }>;
  unseen(agent: string): Promise<string[]>;                  // blob diff since the last look → unleased_write notices
  takeNotices(agent: string): Promise<Array<{ id: string; kind: string; text: string }>>;   // rendered now
  ack(agent: string, noticeId: string): Promise<void>;
  land(agent: string, regions: string[]): Promise<string[]>;  // release + wake; returns the agents marked syncPending
  sweep(): Promise<void>;
  release(agent: string): Promise<void>;
  syncIfPending(agent: string): Promise<Handover | null>;
}
```

- [ ] **Step 1: Write the failing tests** — `live.test.ts`. They use one repo graph built by `indexRepo` on a fixture repo with `a.py` (`f`, `g` calls `f`) and `tests/test_a.py` (tests `f`), plus three registered agents: x, y and z (z has the same person as x).
```ts
test('lease: x edits f body → allow; y edits f → deny naming x and x\'s task', ...);
test('same person, two sessions: z (same person as x) is denied on f too', ...);
test('created function: y adds h → allow without a lease', ...);
test('lessons on touched regions arrive as context on allow', ...);
test('postEdit on a contract change of f → a notice for the holder of g (1 hop CALLS) and tests/test_a.py (TESTS), none for x itself (RC6)', ...);
test('notice text is built at delivery: f changes twice before y reads → y sees the latest signature (RC3)', ...);
test('RC5: 3rd denial within 60 s → "stop editing R; you will be woken"; the 4th is a bare deny', ...);
test('RC6: x lands f → y (waiting) gets a wake; x gets none', ...);
test('land marks waiters and lease/scope holders syncPending; others not', ...);
test('version check: a stale region denies once with the summary; ack → allow', ...);
test('unseen: a Bash write to g\'s body → unleased_write notice to the holder of f (who calls nothing) is not sent; to g\'s caller holder it is', ...);
test('sweep after restart: a new Live on the same graph frees an expired lease and wakes its waiter', ...);
test('release on SessionEnd frees every lease of that agent', ...);
```
Each test is written out in full with its asserts. Shared setup goes in `beforeEach`, with a fresh graph per test (`loom:test:live-<n>`).

- [ ] **Step 2: Run them to see them fail**
Run: `npx vitest run packages/daemon/test/live/live.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `live.ts` and `render.ts`
- Every public method runs inside one `serial` queue (as in v1). Every method that takes an agent first calls `renew(g, agent)`.
- `register`: `MERGE (a:Agent {id}) SET a += {person, worktree, top, upstream, run, task, scope}`. `scope` is a list of region ids, empty for interactive sessions.
- `preEdit`:
  1. `await this.syncIfPending(agent)`.
  2. `t = predictTouched(worktree, it)`. If it is null or `t.mode` is null, allow (with lessons on `t.created`).
  3. **Back-off gate:** if `agent|r` is blocked (3 denials in 60 s) for any `r ∈ t.ids`, deny with the bare text `[loom] wait for the wake on <qname>.`
  4. **Version check:** `staleRegions`. For a run agent, first mark syncPending and call `syncIfPending`, then deny once with "R changed (by, task, decision); your file now contains it, re-read R". For an interactive session, deny with the summary and "pull, or call ack_notice <id> to proceed". The stale notice is stored as a `Notice {kind:'stale', region, version}` so `ack` can find it.
  5. `acquire(g, agent, t.ids, t.mode, task)`. On a grant, allow with `context` = `lessonsFor(g, t.ids)` rendered (or none). On a refusal: `WAITS_ON` edges, back-off bookkeeping (the 3rd denial in 60 s → the RC5 text, after which the gate is blocked), deny with `renderDeny` (holder, the holder's task, lease age vs the median task duration of finished tasks in the graph, or "unknown").
- `postEdit`: re-regionize the file against the agent's last view (cached per `agent|file`, initially HEAD's text from `git show HEAD:<file>`). `diffRegions` gives the changed ids. Write a `Change {agent, region, kind: contract|body|removed, beforeSig, afterSig, at}` per changed id. Targets are the regions within 3 hops over `CALLS|IMPORTS|TESTS`, in either direction, of the changed ones. Recipients are the agents with a live lease on a target or a scope containing one, with `recipient ≠ agent` (RC6). One `Notice {kind:'change', agent: recipient, change, score}` is written per recipient when `score ≥ THRESHOLD`, at most `MAX_PER_DELIVERY` per delivery. **No text is stored.**
- `takeNotices`: `MATCH` the pending notices, `render.ts` builds each text from the *current* graph (the latest Change of that region by that author, the current holder, the current sig), then they are set delivered. Wakes render the same way: `renderWake(holder, qname, current sig, why)`.
- `land`: release the agent's leases on `regions`. Wake the `WAITS_ON` waiters whose id ≠ agent. Mark `syncPending = true` on the waiters and on every agent whose live leases or scope touch `regions`, again with id ≠ agent. Return those ids.
- `sweep`: `expired(g, now)` → per region, delete the lease, then wake the waiters (≠ the expired holder).
- `unseen`: `git ls-files -m -o --exclude-standard` in the worktree, `hash-object` each file, compared with the last seen map. For a changed file, the regions from `diffRegions` vs the last view → `Change` + notices exactly as `postEdit`, with `kind:'unleased_write'`.
- `syncIfPending`: if `a.syncPending` and `a.upstream`, run `handover(a.worktree, a.upstream)`, clear the flag, and on `conflict` store a `Notice {kind:'conflict', regions}` whose render includes "conflict in R; resolve" and the conflicted regions.

- [ ] **Step 4: Run them to see them pass, and check v1**
Run: `npx vitest run packages/daemon`
Expected: PASS. All the new live tests, plus every v1 daemon test unchanged.

---

### Task 6: Hook and MCP routing into `Live`

**Files:**
- Modify: `packages/daemon/src/server.ts`, `packages/daemon/test/server.test.ts`
- Create: `packages/daemon/test/live/route.test.ts`

**Interfaces:**
- Consumes: `Live`, `resolveRepo`, `parsePreToolUse`, `parsePostToolUse`
- Produces:
  - HTTP: `POST /hook/claude/{SessionStart,PreToolUse,PostToolUse,SessionEnd}` on interactive sessions and v2 runs, plus `POST /admin/v2/runs {run, repo}`, `POST /admin/v2/agents {run, agent, worktree, task, scope}` and `POST /admin/v2/landed {run, agent, sha, regions}`.
  - The MCP tools `lease`, `release`, `notices`, `ack_notice`, `who_is_touching` and `impact` go to `Live` when the caller resolves to a repo.

- [ ] **Step 1: Write the failing test** — `route.test.ts`. It starts the daemon on port 0 against a fixture repo (made with `initRepo`) and POSTs real Claude hook payloads.
```ts
test('two interactive sessions: B\'s PreToolUse on A\'s leased region → deny JSON within 2 s', ...);
test('PostToolUse on A → B\'s next hook carries the notice as additionalContext', ...);
test('Bash PostToolUse with a script write → unleased_write notice to the other session', ...);
test('SessionEnd releases A\'s leases; B\'s retry is allowed', ...);
test('handover runs only at the agent\'s own hook: land for a run agent → its worktree unchanged until its next hook', ...);
test('daemon down → the hook script exits 0 with no output (fail-open, reuses P2-9 harness)', ...);
test('MCP who_is_touching names the session holding the region', ...);
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/daemon/test/live/route.test.ts`
Expected: FAIL. PreToolUse on an interactive session returns `''` (no route).

- [ ] **Step 3: Implement** — in `server.ts`'s `/hook/claude/` branch, before the v1 `runFor`:
- `v2 = req.headers['x-loom-run'] ? v2runs.get(header) : null`. `repo = v2 ? v2.repo : await resolveRepo(...)`.
- If there is a repo, `live = lives.get(repo.graph.name) ?? new Live(repo.graph)` (one per graph).
- The agent id is the header, or else `claude-<session_id8>`. On the first sight of an agent, `live.register({ … upstream: upstreamOf(top, v2 && landed) })`.
- **SessionStart:** the P2 path, plus `register`.
- **PreToolUse:** if `parsePreToolUse` gives an intent, call `preEdit`. A deny becomes `denyJson(reason)`. An allow with context becomes `contextJson('PreToolUse', context + notices)`. A Bash PreToolUse goes to `unseen` and is allowed.
- **PostToolUse:** `postEdit` on an edit, `unseen` on Bash, then `takeNotices` → `contextJson('PostToolUse', …)` when there is any.
- **SessionEnd:** `release`, then the P2 `finishSession`.
- `sweep()` runs on a 30 s interval per Live and at each hook.
- Wrap all of it in the existing try → `send(200, '')` (fail open).
- MCP: when `resolveRepo(b.cwd)` hits, the six tools above call `Live`. `ack_notice` on a stale notice calls `ackStale`.

- [ ] **Step 4: Run them to see them pass**
Run: `npx vitest run packages/daemon`
Expected: PASS. The new route tests, plus `server.test.ts` (v1 run routes) unchanged.

---

### Task 7: Merge queue + v2 `loom run` (RC1, RC2 in the run)

**Files:**
- Create: `packages/daemon/src/live/queue.ts`, `packages/daemon/test/live/queue.test.ts`
- Modify: `packages/cli/src/run.ts`, `packages/cli/test/run.test.ts` (if present, else create)

**Interfaces:**
- Consumes: `handover`, `Live.land`, the TESTS edges in the repo graph
- Produces:
  - `coveringTests(g, regions: string[], testCmd: string | null): Promise<string | null>` (the shell command)
  - `landOne(o: { repo: string; wt: string; landed: string; agent: string; title: string; testCmd: string | null; g: LoomGraph }): Promise<{ status: 'landed' | 'conflict' | 'tests_failed' | 'empty'; sha?: string; regions: string[]; tail: string }>`
  - `MergeQueue` with `enqueue(job) → Promise<result>`, serialized.

- [ ] **Step 1: Write the failing test** — `queue.test.ts`
```ts
test('two agents land in order; the landed branch fast-forwards; the final merge order is the landing order', ...);
test('second lander conflicts in the same region → status conflict, landed branch unchanged, markers in its worktree', ...);
test('second lander in a different region of the same file → handover resolves, lands', ...);
test('covering tests: a change to f runs only tests/test_a.py; a failing test → tests_failed, landed unchanged', ...);
test('coveringTests: no TESTS edges → the full testCmd; no testCmd → null', ...);
test('concurrent enqueue of 4 → strictly serialized (no two git ops overlap: an op log shows no interleaving)', ...);
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/daemon/test/live/queue.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**
- `landOne`:
  1. `git add -A -- <KEEP_OUT>` + commit in `wt` (if nothing changed, return `empty`).
  2. `handover(wt, landed)`. On conflict, return `conflict`.
  3. The changed regions: `regionize` the files from `git diff --name-only <landed>...HEAD`, then `diffRegions` vs `landed`.
  4. `coveringTests` → run in `wt`. On failure, `tests_failed`.
  5. `git update-ref refs/heads/<landed> HEAD <old>` (compare-and-swap; it cannot fail inside the serialized queue, and a failure throws).
  6. Return `landed`.
- `run.ts` v2 (default; `--v1` keeps the old path verbatim):
  - create `loom/<run8>/landed` at `base`;
  - POST `/admin/v2/runs`, and `/admin/v2/agents` per task, with `scope` = the regions of the task's SCOPE files from the planner;
  - workers spawn as today, with the `x-loom-run` header;
  - `finish(w)` → `queue.enqueue(landOne(...))` → POST `/admin/v2/landed` with the regions. On `conflict` or `tests_failed`, resume the worker (≤ `MAX_RESUMES`) with the brief: the conflict regions or the test tail;
  - before any resume: `handover(w.wt, landed)`. This **replaces** `sync(w)`, the `merge --abort` (RC2);
  - the resume prompt is built at resume time from `GET /runs/<run>/notices` (rendered at delivery, RC3);
  - the final merge = the `landed` branch itself: `merge.branch = loom/<run8>/landed`, with tests run on a worktree of it. `conflict` is non-null when any worker ended with an unlanded commit.

- [ ] **Step 4: Run them to see them pass**
Run: `npx vitest run packages/daemon/test/live/queue.test.ts packages/cli`
Expected: PASS.

- [ ] **Step 5: Bundle smoke**
Run: `pnpm build:cli && node packages/cli/dist/loom.cjs run --help`
Expected: the help lists `--v1`. A fake-claude run (`--claude-bin` set to the `bench/scripts/fake-claude.sh` used by v1 e2e) of 2 tasks on a fixture ends with `landed` holding both commits.

---

### Task 8: E5 grader on the full final merge (§6.6.9)

**Files:**
- Modify: `bench/e5/run.py`
- Create: `bench/tests/test_e5_grade.py`

- [ ] **Step 1: Write the failing test**
```python
from bench.e5.run import verdict

def test_conflict_marks_every_agent_failed():
    v = verdict(conflict="a.py", tests_passed=None, merged={"a": True, "b": True}, integration=None)
    assert v["agents_ok"] == 0 and v["all_pass"] is False

def test_agent_ok_only_from_the_full_final_merge():
    v = verdict(conflict=None, tests_passed=True, merged={"a": True, "b": False}, integration=None)
    assert v["agents_ok"] == 1 and v["all_pass"] is False
```

- [ ] **Step 2: Run it to see it fail**
Run: `cd bench && python -m pytest -q tests/test_e5_grade.py`
Expected: FAIL, `verdict` not defined.

- [ ] **Step 3: Implement.** Extract `verdict(conflict, tests_passed, merged, integration) → {agents_ok, all_pass, failed}` from `grade()`. With a conflict, every agent counts as failed. `merged_tree` becomes the run's final merge worktree for both v1 (`_merge`) and v2 (a worktree of `loom/<run8>/landed`), read from `rep["merge"]["branch"]`. `summarize` prints `agents_ok` from `verdict`.

- [ ] **Step 4: Run it to see it pass**
Run: `cd bench && python -m pytest -q tests/test_e5_grade.py tests`
Expected: PASS, and the existing bench tests are unchanged.

---

### Task 9: L0 coordination gate

**Files:**
- Create: `packages/daemon/test/l0-coord.test.ts`

Scripted fake agents drive the **real daemon over HTTP**, using real Claude hook payloads, in real git worktrees. No LLM is used. One test per mechanism in §10's L0 list:
```ts
test('1. lease + TTL: two interactive sessions; B denied on A\'s region; after TTL (clock injected) B allowed and gets a wake', ...);
test('2. version check, live: run agent y edits a region x landed → y\'s worktree synced, denied once, retry allowed', ...);
test('3. version check, upstream: clone B edits a region A pushed → deny with A\'s summary; ack → allow; A pushes again → deny', ...);
test('4. handover with a dirty worktree (RC1/RC2): x lands; y has dirty edits in the same file → after y\'s next hook y\'s file has both', ...);
test('5. merge queue: 3 agents land; landed = the 3 commits in landing order; covering tests ran per landing', ...);
test('6. back-off (RC5): 3 denials in 60 s → "stop editing"; the wake arrives on landing', ...);
test('7. no self-wake (RC6): the holder never receives its own wake or notice across a full run', ...);
test('8. notices built at delivery (RC3): two changes before delivery → one notice with the latest signature', ...);
test('9. tests/ indexed (RC4): an edit to tests/test_a.py takes a lease; a second agent is denied', ...);
test('10. Bash write → unleased_write notice', ...);
test('11. fail-open: FalkorDB down → every hook answers 200 within 2 s', ...);
```

- [ ] **Step 1: Write the test file in full.** Every case is spelled out, with its asserts on the HTTP JSON and on the files in the worktrees.
- [ ] **Step 2: Run it.** Before Tasks 1–7 exist, it fails on imports.
Run: `npx vitest run packages/daemon/test/l0-coord.test.ts > bench/results/l0-coord.txt 2>&1; tail -5 bench/results/l0-coord.txt`
Expected after Tasks 1–8: PASS 11/11.
- [ ] **Step 3: Run the whole suite**
Run: `npx vitest run`
Expected: every test green; record the count.

---

### Task 10: Ledger, then the agent benchmarks (each needs a go-ahead)

- [ ] **Step 1:** Add ledger rows P3-1 … P3-11, one per L0 mechanism plus S1. Each cites the command and `bench/results/l0-coord.txt` / `s1.txt`. A failing mechanism is marked `refuted` with what changed. It is not tuned.
- [ ] **Step 2:** Ask Abhinav for a go-ahead on **STALE core** (~$2.5, 12 pairs × blind/oracle/live). Run it only after the yes, then record it in a ledger row with `records.jsonl`. Bar: live ≥ 11/12 merged-pass, blind 0/12.
- [ ] **Step 3:** Ask Abhinav for a go-ahead on **E5** (~$4, s1/s2/s3 × loom/blind, fixed grader), then record it in row E5-v2. Bar: loom 3/3 all_pass vs blind. It is reported whatever the result.
