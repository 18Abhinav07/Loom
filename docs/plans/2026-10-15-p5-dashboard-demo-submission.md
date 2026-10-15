# P5 — Dashboard Views, `loom demo`, README, Video, Submission — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can clone the repo, run `loom demo`, and see the eight views over real data: the repo timeline, a commit diff, a conflict, region history, the why explorer, a live run, people & agents, and the bench. Every number has an ⓘ explainer. A README and video carry the proof ledger to the judges by 20:00 Sun.

**Architecture:** Each view is a **pure view-model function** (`apps/dashboard/src/vm/*.ts`, tested like `test/view.test.ts`) over the same JSON the CLI emits with `--json`. React components only render view-models. The daemon gets read-only `GET /api/repo/*` routes that call `@loom/memory` (P2/P4) on the repo graph of the cwd the daemon was started in. The theme is CSS tokens: light cream/orange by default, dark under `prefers-color-scheme` and a toggle.

**Tech Stack:** React 19, Vite 8, sigma 4 + graphology (already deps), vitest, the P4 `@loom/memory` APIs.

**Spec:** `docs/specs/2026-10-15-loom-v2-design.md` §9, §11 (P5 row, cut order), §10.1 (ledger shown in the Bench view and the README).

## Global Constraints

- "Every view reads the same JSON as the CLI" (§9): a view-model takes **only** a CLI `--json` payload. No view-only query.
- "Every number has an ⓘ explainer" (§9). The explainer text lives in one table (`vm/explain.ts`), and a test fails if a rendered metric key has no entry.
- A missing result is shown as missing, never estimated (the existing Bench rule).
- Cut order if late: Ask bot → `define_regions` → TS pack → regionMerge in handover → **Region-history view**. The Ask bot is not in this plan; it is Task 9, optional.
- Repo private; deploy configs only, no account creation. The video is recorded by Abhinav, using the script from Task 8.
- Submission target 20:00 Sun 18 Oct IST.

## Review Focus

1. **Daemon started outside a git repo, or in a repo without `loom init`.** Every repo view says "not a Loom repo: run `loom init`", and Live/Bench still work. Pinned in Task 1.
2. **A repo with 2 000+ regions in the Why explorer or Commit graph.** It renders at most 200 nodes (closest by path), with a "showing 200 of N" note, and never freezes the tab. Pinned in Task 3.
3. **Dark mode via the OS setting, then a manual toggle to light.** The toggle wins and persists (try/catch localStorage). Pinned in Task 2.
4. **A conflict brief with zero rows (a clean merge).** The view says "no region changed on both sides" and does not show an empty table. Pinned in Task 4.
5. **`loom demo` on a machine without docker running.** It exits 1 with "start docker (FalkorDB) first: `docker run -p 6379:6379 falkordb/falkordb`". No stack trace. Pinned in Task 7.

---

## Rulings made while planning

1. **The story, live, plan, timeline, why, verify and bench views remain as they are for v1 runs.** The new views are grouped under a "Repo" nav, and the "Runs" nav keeps the v1 views. Nothing is deleted.
2. **The API shape is `GET /api/repo/<cmd>?…`.** It returns exactly `loom <cmd> --json` (the same function call), and a test asserts byte equality for `log`, `diff`, `conflict`, `history`, `why` and `people`.
3. **Graph drawing goes through one `PathGraph` component** that takes a `path[]` list (P4 ruling 5) and lays it out with forceatlas2. The Commit, Conflict, Why and Region-history views all use it.
4. **`loom demo`** builds a fixture repo from `demo/repo-seed/` (two people, three sessions, a decision, a real A/B/C/D merge), runs the real hooks and `loom init`, starts the daemon and opens the UI. No API key is needed. The v1 `demo/run-1` replay stays as the Live-run demo.

---

## File map

| File | Responsibility |
|---|---|
| `packages/daemon/src/api.ts` | `GET /api/repo/{log,diff,conflict,history,why,people,regions}` → `@loom/memory` |
| `packages/memory/src/people.ts` | `people(g)`: person → sessions → agents → versions/decisions count (for the People view; CLI `loom people --json`) |
| `apps/dashboard/src/vm/{timeline,commit,conflict,history,why,people,explain}.ts` | pure view-models |
| `apps/dashboard/src/repo/{Timeline,Commit,Conflict,History,WhyExplorer,People}.tsx` | renderers |
| `apps/dashboard/src/PathGraph.tsx` | the `path[]` → sigma graph, capped at 200 nodes |
| `apps/dashboard/src/Info.tsx` | the ⓘ popover reading `explain.ts` |
| `apps/dashboard/src/theme.css` | tokens: light cream/orange (default), dark |
| `apps/dashboard/test/vm.test.ts` | view-model tests |
| `packages/cli/src/demo.ts` | `loom demo` |
| `demo/repo-seed/` | demo fixture script + files |
| `README.md`, `docs/SUBMISSION.md`, `docs/video-script.md` | delivery |

---

### Task 1: Repo API routes (`/api/repo/*`) + `loom people`

**Files:**
- Create: `packages/daemon/src/api.ts`, `packages/memory/src/people.ts`, `packages/daemon/test/api.test.ts`
- Modify: `packages/daemon/src/server.ts` (route `/api/repo/` to `api.ts` before the run routes), `packages/cli/src/loom.ts` (`people`)

**Interfaces:**
- Consumes: P4 `diffRange`, `log`, `conflictBrief`, `whyPath`, `historyPath`; P2 `resolveRepo`
- Produces: `repoApi(db, cwd, home, url): Promise<{ status: number; body: unknown }>`; `people(g): Promise<Array<{ person, sessions: Array<{ id, kind, agents: Array<{ id, versions: number, decisions: number }> }> }>>`

- [ ] **Step 1: Write the failing tests**
```ts
test('each /api/repo/<cmd> body equals loom <cmd> --json on the same repo', async () => {
  for (const [route, argv] of [['log?n=5', ['log', '-n', '5', '--json']], ['diff?range=base..HEAD', ['diff', 'base..HEAD', '--json']],
    ['history?region=' + SLUG, ['history', SLUG, '--json']], ['why?target=' + SLUG, ['why', SLUG, '--json']], ['people', ['people', '--json']]] as const)
    expect((await repoApi(db, repo, home, new URL('http://x/api/repo/' + route))).body).toEqual(JSON.parse(await cliJson(repo, argv)));
});
test('people groups person → session → agent with counts', async () => {
  expect(await people(g)).toEqual([{ person: 'A@t', sessions: [{ id: sid, kind: 'interactive', agents: [{ id: 'main', versions: 2, decisions: 1 }] }] }]);
});
test('outside a Loom repo every /api/repo route → 409 { error: "not a Loom repo: run loom init" }', async () => {
  expect(await repoApi(db, tmpNonRepo, home, new URL('http://x/api/repo/log'))).toEqual({ status: 409, body: { error: 'not a Loom repo: run loom init' } });
});
```
`cliJson` runs `main(argv)` with `console.log` captured (the pattern in `memory-cli.test.ts`).
- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run packages/daemon/test/api.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** `api.ts` switches on the last path segment and calls the same function the CLI command calls. The CLI's `--json` printing then becomes `console.log(JSON.stringify(await <fn>(...)))` in both places. `people.ts` is one Cypher query: `MATCH (p:Person)<-[:BY]-(v:Version)-[:FOR]->...`, with the sessions found from `Version.session` and the agent from `Version.agent`.
- [ ] **Step 4: Run them to see them pass.** Run: `npx vitest run packages/daemon packages/memory`. Expected: PASS.

---

### Task 2: Theme (light cream/orange + dark) and the ⓘ explainers

**Files:**
- Modify: `apps/dashboard/src/theme.css`, `apps/dashboard/src/App.tsx`
- Create: `apps/dashboard/src/vm/explain.ts`, `apps/dashboard/src/Info.tsx`, `apps/dashboard/src/vm/theme.ts`, add to `apps/dashboard/test/vm.test.ts`

**Interfaces:**
- Produces:
  - `EXPLAIN: Record<string, { what: string; how: string; source: string }>`
  - `explainFor(key): Explain | undefined`
  - `initialTheme(stored: string | null, prefersDark: boolean): 'light' | 'dark'`

- [ ] **Step 1: Write the failing tests**
```ts
test('stored theme wins over the OS; no stored value follows the OS', () => {
  expect(initialTheme('light', true)).toBe('light'); expect(initialTheme(null, true)).toBe('dark'); expect(initialTheme(null, false)).toBe('light');
});
test('every metric key that a view-model emits has an explainer', () => {
  const keys = [...timelineVm(LOG).metrics, ...conflictVm(BRIEF).metrics, ...peopleVm(PEOPLE).metrics, ...benchVm(BENCH).metrics].map((m) => m.key);
  expect(keys.filter((k) => !explainFor(k))).toEqual([]);
});
```
(`timelineVm` etc. come from Tasks 3–6. While they don't exist yet, this test is RED, and it closes in Task 6.)
- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run apps/dashboard/test/vm.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Tokens on `:root` (light): `--bg #faf6ef; --panel #fffdf8; --line #eadfcc; --fg #2b2118; --dim #7a6a58; --accent #d97745; --ok #2f7d4f; --bad #b4442f`. The dark set is redefined under `@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) {…} }` and `:root[data-theme=dark] {…}`. The header gets a ◐ toggle that writes `localStorage['loom.theme']` (try/catch). `Info` is a `<button aria-label="what is this">ⓘ</button>` with a popover of what/how/source.
- [ ] **Step 4:** `theme` test PASS. The explainer test stays RED until Task 6 (expected).

---

### Task 3: `PathGraph` + Why explorer

**Files:**
- Create: `apps/dashboard/src/PathGraph.tsx`, `apps/dashboard/src/vm/why.ts`, `apps/dashboard/src/repo/WhyExplorer.tsx`

**Interfaces:**
- Produces:
  - `pathToGraph(paths: PathStep[][], cap = 200): { nodes: Array<{ id, label, kind }>; edges: Array<{ from, to, type }>; shown: number; total: number }`
  - `whyVm(resp): { chains: Array<{ text: string; steps: PathStep[] }>; missing: string[]; graph }`

- [ ] **Step 1: Write the failing tests**
```ts
test('pathToGraph dedupes shared nodes across chains and keeps edge types', () => {
  const g = pathToGraph([[{ node: 'Region:r', edge: null }, { node: 'Version:v1', edge: 'HEAD' }], [{ node: 'Region:r', edge: null }, { node: 'Decision:d', edge: 'LED_TO' }]]);
  expect(g.nodes.map((n) => n.id)).toEqual(['Region:r', 'Version:v1', 'Decision:d']);
  expect(g.edges).toEqual([{ from: 'Region:r', to: 'Version:v1', type: 'HEAD' }, { from: 'Region:r', to: 'Decision:d', type: 'LED_TO' }]);
});
test('pathToGraph caps at 200 nodes, nearest-first, and reports shown/total', () => {
  const long = Array.from({ length: 500 }, (_, i) => [{ node: 'Region:r', edge: null }, { node: `Region:c${i}`, edge: 'CALLS' }]);
  const g = pathToGraph(long); expect([g.shown, g.total, g.nodes.length]).toEqual([200, 501, 200]);
});
test('whyVm renders each chain in plain words and lists missing links', () => {
  expect(whyVm(WHY).chains[0].text).toBe('slugify ← changed by A@t (session s1, agent main) ← decision "strict mode is opt-in"');
  expect(whyVm(WHY_BASELINE).missing).toEqual(['decision', 'session']);
});
```
- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run apps/dashboard/test/vm.test.ts -t "pathToGraph|whyVm"`. Expected: FAIL.
- [ ] **Step 3: Implement.** `PathGraph` uses graphology + forceatlas2 (the same setup as `GraphView.tsx`), with node colours by label from the theme tokens. Clicking a node runs `why`/`history` on it (the "every node can be queried" rule in §9). `WhyExplorer` has a target input (id / `file:line` / qname), and its chains list sits beside the graph.
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.

---

### Task 4: Conflict view + Commit/diff view

**Files:**
- Create: `apps/dashboard/src/vm/conflict.ts`, `apps/dashboard/src/vm/commit.ts`, `apps/dashboard/src/repo/Conflict.tsx`, `apps/dashboard/src/repo/Commit.tsx`

**Interfaces:**
- Produces:
  - `conflictVm(brief): { empty: boolean; rows: Array<{ cls, region, ours: string, theirs: string, callers: string[], tests: string[], confirmed: boolean | null }>; metrics: Metric[]; graph }`
  - `commitVm(diff): { commits: Array<{ sha, subject, person, tree: TreeNode }>; metrics; graph }`

- [ ] **Step 1: Write the failing tests**
```ts
test('conflictVm orders rows A, D, C, B and summarises each side as person · task', () => {
  const v = conflictVm(BRIEF);
  expect(v.rows.map((r) => r.cls)).toEqual(['A', 'D', 'C', 'B']);
  expect(v.rows[0].ours).toBe('A@t · task 2 "strict slugify"');
  expect(v.metrics.map((m) => m.key)).toEqual(['conflict.A', 'conflict.B', 'conflict.C', 'conflict.D']);
});
test('a clean merge brief → empty:true and the sentence, no rows', () => {
  expect(conflictVm({ ...BRIEF, rows: [] })).toMatchObject({ empty: true, rows: [] });
});
test('commitVm nests commit → person → session → agent → regions', () => {
  expect(commitVm(DIFF).commits[0].tree).toEqual({ label: 'A@t', children: [{ label: 'session s1', children: [{ label: 'main', children: [{ label: 'slugify' }, { label: 'title' }] }] }] });
});
```
The fixtures `BRIEF` and `DIFF` are **recorded outputs** of `loom conflict --json` / `loom diff --json` from the P4 L0 conflict scenario, saved to `apps/dashboard/test/fixtures/` by P4 Task 8's run. They are not hand-written.
- [ ] **Step 2: Run them to see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The Conflict view puts the two sides side by side (ours | theirs paths through `PathGraph`, with callers highlighted in `--bad`), and the class chip has an ⓘ. The Commit view takes a range input and shows the tree on the left and the subgraph on the right.
- [ ] **Step 4: Run them to see them pass.** Expected: PASS.

---

### Task 5: Repo timeline + People & agents

**Files:**
- Create: `apps/dashboard/src/vm/timeline.ts`, `apps/dashboard/src/vm/people.ts`, `apps/dashboard/src/repo/Timeline.tsx`, `apps/dashboard/src/repo/People.tsx`

**Interfaces:**
- Produces:
  - `timelineVm(log): { lanes: Array<{ key: string; person; session?; agent? }>; rows: Array<{ sha, subject, at, lane: number, regions, decisions }>; metrics }`
  - `peopleVm(people): { cards: Array<{ person, sessions: number, agents: number, versions: number, decisions: number }>; metrics }`

- [ ] **Step 1: Write the failing tests**
```ts
test('timelineVm gives one lane per person→session→agent, in first-seen order; external commits get the person lane', () => {
  const v = timelineVm(LOG);
  expect(v.lanes.map((l) => l.key)).toEqual(['A@t/s1/main', 'B@t']);
  expect(v.rows.map((r) => r.lane)).toEqual([0, 1, 0]);
});
test('peopleVm sums across sessions', () => {
  expect(peopleVm(PEOPLE).cards[0]).toEqual({ person: 'A@t', sessions: 2, agents: 3, versions: 7, decisions: 2 });
});
```
- [ ] **Step 2: Run them to see them fail.** Then **Step 3: Implement** (clicking a timeline row opens the Commit view for `sha^..sha`), and **Step 4: Run them to see them pass.**

---

### Task 6: Region history (5th on the cut list) + Bench with the ledger

**Files:**
- Create: `apps/dashboard/src/vm/history.ts`, `apps/dashboard/src/vm/bench.ts`, `apps/dashboard/src/repo/History.tsx`
- Modify: `apps/dashboard/src/Bench.tsx`, `packages/daemon/src/server.ts` (`/bench` also returns `ledger`, parsed from `docs/proofs/LEDGER.md` rows)

**Interfaces:**
- Produces:
  - `historyVm(h): { dag: { nodes, edges }; versions: Array<{ id, by, task, decision?, diff: string }> ; lessons: string[] }`
  - `benchVm(b): { sections: Array<{ id, title, status: 'proven'|'refuted'|'partial'|'open', rows, raw: string }>; metrics }`

- [ ] **Step 1: Write the failing tests**
```ts
test('historyVm draws the version DAG with merge parents and attaches decisions', ...);   // fixture = recorded `loom history --json`
test('benchVm takes each section\'s status from the ledger row, never from the JSON alone; a result with no ledger row is "open"', ...);
test('benchVm shows S1, I1, STALE, E5, X1, X2, T1–T5 and links each to its raw file', ...);
```
- [ ] **Step 2: Run them to see them fail.** Then **Step 3: Implement**, and **Step 4: Run them to see them pass.** Then run the Task 2 explainer test: it must be GREEN now (every metric key has an explainer).

---

### Task 7: `loom demo`

**Files:**
- Create: `packages/cli/src/demo.ts`, `demo/repo-seed/seed.sh`, `demo/repo-seed/pkg/*.py`, `packages/cli/test/demo.test.ts`
- Modify: `packages/cli/src/loom.ts`

**Interfaces:**
- Produces: `buildDemoRepo(dir, loomCmd): Promise<{ repo: string; mergeSha: string }>`; CLI `loom demo [--dir D] [--no-open]`

- [ ] **Step 1: Write the failing tests**
```ts
test('buildDemoRepo: 2 people, 3 sessions, 1 decision, and a merge whose brief has A, B, C and D', async () => {
  const { repo } = await buildDemoRepo(tmp, LOOM);
  const brief = JSON.parse(cliJson(repo, ['conflict', 'demo/ours', 'demo/theirs', '--json']));
  expect(new Set(brief.rows.map((r: any) => r.class))).toEqual(new Set(['A', 'B', 'C', 'D']));
  expect(JSON.parse(cliJson(repo, ['people', '--json'])).length).toBe(2);
});
test('loom demo without FalkorDB exits 1 with the docker hint', async () => {
  expect(await runCli(['demo', '--no-open'], { FALKORDB_URL: 'redis://127.0.0.1:1' })).toMatchObject({ code: 1, stderr: expect.stringMatching(/start docker \(FalkorDB\) first/) });
});
```
- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run packages/cli/test/demo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `seed.sh` commits as two git identities through the installed hooks, writes session events with `appendEvent` (the same path the real hooks use), and leaves `demo/ours` and `demo/theirs` unmerged. `loom demo` then runs `buildDemoRepo` → `loom up` in that repo → `loom replay demo/run-1` (Live view) → opens `UI/?view=repo-timeline`.
- [ ] **Step 4: Run them to see them pass.** Then do a bundle smoke: `pnpm build:cli && node packages/cli/dist/loom.cjs demo --dir $SCRATCH/demo --no-open`, and `curl -s localhost:<ui>/api/repo/conflict?ours=demo/ours&theirs=demo/theirs | head -c 300`. Expected: JSON with 4 classes.

---

### Task 8: README, video script, submission

**Files:**
- Modify: `README.md`
- Create: `docs/SUBMISSION.md`, `docs/video-script.md`

- [ ] **Step 1: README.** Sections: what Loom is (one paragraph, §0); Try it (`loom demo`, no API key); Use it on your repo (`loom init`); How it works (regions → repo graph → `.loom/` → live → conflicts; one diagram); **Results**, generated from `docs/proofs/LEDGER.md` by `bench/ledger-table.ts`, with every row's status as it is, refuted rows included; FalkorDB features used (graph per repo per tenant, Cypher, `algo.betweenness`, `algo.WCC`, `shortestPath`); Limits (§12).
- [ ] **Step 2: Ledger → README test.** `bench/test/ledger-table.test.ts` asserts that the README table rows equal the parsed ledger rows (statuses included), so the README cannot drift from the ledger.
- [ ] **Step 3: Video script** (≤ 3 min): the problem in one sentence (agents and people edit the same code blind) → `loom demo` → the timeline → a conflict brief A–D with both sides' paths → `--verify` confirms C → why explorer → the live run with leases/wakes → the bench and ledger, with the refuted rows said out loud. Abhinav records it.
- [ ] **Step 4: `docs/SUBMISSION.md`.** This holds the form fields (title, one-liner, track, repo link, video link, FalkorDB usage, team), each one filled from the README. Before submitting, Abhinav confirms the repo visibility switch to public himself.
- [ ] **Step 5: Whole suite + build.** Run: `npx vitest run && pnpm -r build`. Expected: green, recorded in the ledger as P5-1.

---

### Task 9 (optional, first on the cut list): Ask bot

Only if Tasks 1–8 are done before Sun 14:00. `POST /api/ask {q}` runs `claude -p --model sonnet` (subscription CLI, `ANTHROPIC_*` stripped), with the MCP config pointed at this daemon, so it answers from the graph through the tools with `path[]`. The test stubs the CLI binary with a script that echoes its argv and asserts that the env has no `ANTHROPIC_API_KEY` and that `--mcp-config` is passed.
