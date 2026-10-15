# P4 — Conflict/Diff Engine, Path-based `why`, New MCP Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain any merge region by region (classes A–D, with both sides' version paths, callers and covering tests), diff and log any commit range by person → session → agent, answer `why` with a drawable `path[]`, and expose all 19 MCP tools on the repo graph.

**Architecture:** The engine lives in `@loom/memory` (`diff.ts`, `conflict.ts`, `paths.ts`, `algos.ts`), because it reads the repo graph and git blobs and never the worktree. The daemon's MCP dispatcher and the CLI both call it, so the CLI, MCP and dashboard read one JSON shape. v1's `mergecheck.ts` C-prediction is ported to Region `sig` and `CALLS` edges.

**Tech Stack:** TypeScript, vitest 2.1.8, FalkorDB (`algo.betweenness`, `algo.WCC`, `shortestPath`), git plumbing (`merge-base`, `show`, `diff-tree`), `@loom/indexer` (`regionize`, `diffRegions`, `regionMerge`, `buildEdges`).

**Spec:** `docs/specs/2026-10-15-loom-v2-design.md` §6.8, §6.9, §6.10, §7, §8, §10 (L0 conflict parts, X1, X2).

## Global Constraints

- Every query response is JSON and carries `path: Array<{ node: string; edge: string | null }>` (§7).
- The conflict engine reads blobs with `git show`, **never the worktree**, which may hold conflict markers (§6.8.2).
- Rebase is supported only through the explicit `loom conflict <ours> <theirs>` form (§6.8).
- The C class means: one side changed R's contract (parameters, defaults, return annotation = Region `sig`), and the other side added or changed a region that CALLS R (§6.8.3).
- Every CLI command supports `--json` (§8).
- X1 and X2 are agent benchmarks on the subscription CLI. Each needs a go-ahead, and each is reported whatever its result.
- TDD. Temp files go in the scratchpad.

## Review Focus

1. **A merge where one side renamed a function and the other edited its body.** Expected: class D (delete vs modify), with the rename named, not two unrelated rows. Pinned in Task 2 ("rename vs edit").
2. **A file only one side touched, inside a conflicted merge.** Expected: it is absent from the brief. Only regions changed on at least one side are classified, and a one-sided change is never A or B. Pinned in Task 2.
3. **`loom conflict` run outside a merge with no arguments.** Expected: exit 2 with "not in a merge; use loom conflict <ours> <theirs>". No stack trace. Pinned in Task 2.
4. **`why` on a region with no versions (baseline only).** Expected: `path` holds the region and its baseline commit, and `missing: ['decision', 'session']`. It is not an empty error. Pinned in Task 4.
5. **`path` between two nodes with no route.** Expected: `{ found: false, path: [] }`, not an exception. Pinned in Task 5.

---

## Rulings made while planning

1. **The engine goes in `@loom/memory`, not the daemon.** Both the CLI (no daemon needed for `loom conflict`) and the MCP need it. The daemon already depends on memory.
2. **One output shape** for `diff` and `conflict`: `RegionChange { region, file, qname, kind, sides: { ours?: SideInfo; theirs?: SideInfo }, class?: 'A'|'B'|'C'|'D', callers: string[], tests: string[], path }`. `SideInfo = { versions: Array<{ id, person, session, agent, task, decision, commit }> }`.
3. **Versions per side since base:** these are the Versions whose commits are reachable from that side's tip and not from `base` (`isAncestor`). When a side has no Loom versions (an external commit), Rule P2-6's `ext:<sha>:<region>` versions are created on the fly by `reconcile(g, top, base, tip)` first.
4. **`--verify`** builds the merged tree in a temporary worktree at `ours`, then writes each file's regionMerge result (or theirs' blob for one-sided changes), runs the covering tests (P3 `coveringTests`), and sets `confirmed: true|false` on every C row. A row with no covering tests stays `confirmed: null`.
5. **`path[]` format:** `node` is `<Label>:<id>` and `edge` is the relationship type leading *into* that node (null for the first). It is the same for `why`, `impact`, `history`, `path` and `conflict`. The dashboard's Why explorer draws exactly this.
6. **`define_regions`** is the second item on the cut list (§11). Task 6 does it last, behind a separate test.

---

## File map

| File | Responsibility |
|---|---|
| `packages/memory/src/diff.ts` | `diffRange(g, top, a, b)`, `log(g, top, n)` (§6.9) |
| `packages/memory/src/conflict.ts` | `conflictBrief(g, top, ours?, theirs?, o)` classes A–D, `verify` (§6.8) |
| `packages/memory/src/paths.ts` | `whyPath`, `impactPath`, `historyPath` → `path[]` |
| `packages/memory/src/algos.ts` | `hotspots`, `clusters`, `shortest` |
| `packages/memory/src/mine.ts` | mined lessons (§6.10) |
| `packages/daemon/src/server.ts` (modify) | MCP dispatch for the 7 new tools + the path-based `why`/`impact` |
| `packages/mcp/src/loom-mcp.ts` (modify) | register the 19 tools with their schemas |
| `packages/cli/src/loom.ts` (modify) | `conflict`, `diff`, `log`, `history`, `why` (v2) |
| `packages/memory/test/l0-conflict.test.ts` | L0 conflict gate |

---

### Task 1: `loom diff a..b` and `loom log` (§6.9)

**Files:**
- Create: `packages/memory/src/diff.ts`, `packages/memory/test/diff.test.ts`
- Modify: `packages/memory/src/index.ts`, `packages/cli/src/loom.ts`

**Interfaces:**
- Produces:
  - `diffRange(g, top, a: string, b: string): Promise<{ commits: Array<{ sha, subject, person, sessions: Array<{ id, agents: Array<{ id, task, regions: RegionChange[], decisions: string[] }> }> }> }>`
  - `log(g, top, n = 20): Promise<Array<{ sha, subject, person, at, regions: number, decisions: number, sessions: string[] }>>`

- [ ] **Step 1: Write the failing test.** The fixture repo is made with `initRepo`. Two people commit through the hooks: A with a session, a decision and two regions; B with `--no-verify` and one region (external).
```ts
test('diff groups regions by commit → person → session → agent with decisions', async () => {
  const d = await diffRange(g, top, base, 'HEAD');
  expect(d.commits.map((c) => c.person)).toEqual(['A@t', 'B@t']);
  expect(d.commits[0].sessions[0].agents[0].regions.map((r) => r.qname).sort()).toEqual(['slugify', 'title']);
  expect(d.commits[0].sessions[0].agents[0].decisions).toEqual(['strict mode is opt-in']);
  expect(d.commits[1].sessions).toEqual([{ id: 'external', agents: [expect.objectContaining({ id: 'B@t' })] }]);
});
test('every RegionChange carries a path from the region to its person', async () => {
  const r = (await diffRange(g, top, base, 'HEAD')).commits[0].sessions[0].agents[0].regions[0];
  expect(r.path.map((p) => p.node.split(':')[0])).toEqual(['Region', 'Version', 'Agent', 'Session', 'Person']);
});
test('log lists newest first with counts', async () => {
  expect((await log(g, top, 5))[0]).toMatchObject({ person: 'B@t', regions: 1, decisions: 0 });
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/diff.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**
- `git rev-list --reverse a..b`.
- Per commit, `diff-tree --no-commit-id --name-only -r` for the files, then `regionize` the parent and commit blobs (`git show`), then `diffRegions`.
- Match each changed region to the Version whose `commits` contains the sha (or `ext:<sha>:<region>`), and then by graph edges to agent → session → person.
- Decisions come from `(d:Decision)-[:LED_TO]->(v)`.
- CLI: `loom diff <a>..<b> [--json]` prints a tree (commit / person / session / agent / region); `loom log [-n N] [--json]`.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/diff.test.ts`
Expected: PASS 3/3.

---

### Task 2: Conflict brief — classes A–D (§6.8)

**Files:**
- Create: `packages/memory/src/conflict.ts`, `packages/memory/test/conflict.test.ts`
- Modify: `packages/cli/src/loom.ts`

**Interfaces:**
- Consumes: `regionize`, `diffRegions`, `regionMerge`; `reconcile`; `importSessions` (from the theirs ref)
- Produces: `conflictBrief(g, top, o: { ours?: string; theirs?: string }): Promise<{ base: string; ours: string; theirs: string; rows: RegionChange[]; path: PathStep[] }>`. It throws `NotInMerge` when there are no refs and no `MERGE_HEAD`.

- [ ] **Step 1: Write the failing test.** One fixture builder makes a repo where `ours` and `theirs` branch from `base`, with one file per class:
```ts
test('A: both sides change f\'s body on the same line → A', ...);           // regionMerge conflict
test('B: both sides change f in different lines → B (merged, risky)', ...);
test('C: ours changes g\'s signature, theirs adds a call to g → C on g, caller named', ...);
test('D: ours deletes h, theirs edits h → D', ...);
test('rename vs edit: ours renames k→k2, theirs edits k → D, with renamedTo k2', ...);
test('one-sided change is never classified and a file only one side touched is absent', ...);
test('inside a real merge (MERGE_HEAD) with markers in the worktree: same result as the explicit form', ...);
test('outside a merge with no refs → NotInMerge; CLI exits 2 with the hint', ...);
test('each row has both sides\' versions since base, with person, session, task and decision', ...);
test('callers (impact, 3 hops) and covering tests (TESTS) attached', ...);
```
Every test is spelled out with its fixture strings and asserts. The fixture builder writes `pkg/m.py` with `f`, `g`, `h`, `k`, a `caller()` and `tests/test_m.py`.

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/conflict.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**
1. Resolve `ours` (`HEAD`), `theirs` (`MERGE_HEAD`, or the arguments), `base` (`merge-base`). Run `importSessions(g, top, theirs)` and `reconcile` on both sides.
2. Files = the union of `diff --name-only base ours` and `base theirs`. Per file, regionize the three blobs from `git show`.
3. `dO = diffRegions(B, O)` and `dT = diffRegions(B, T)`. Regions changed on both sides → `regionMerge(file, b, o, t)`: a conflict listing that region → A, merged → B. Tombstone (or rename-from) on one side + update on the other → D. C: for each region R with `B.sig ≠ side.sig`, find regions on the other side that are updated or created and whose CALLS (from `buildEdges` on that side's file set) target R → C on R, with `callers`.
4. For each row: versions since base per side (ruling 3), `callers` via `MATCH (c:Region)-[:CALLS*1..3]->(r)`, `tests` via `TESTS`, and `path`.
5. CLI `loom conflict [ours theirs] [--json] [--verify]`. The table columns are: class, region, ours (person/task), theirs (person/task), callers, tests.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/conflict.test.ts`
Expected: PASS 10/10.

---

### Task 3: `loom conflict --verify` (C confirmed or refuted)

**Files:**
- Modify: `packages/memory/src/conflict.ts`, `packages/memory/test/conflict.test.ts`

**Interfaces:**
- Produces: `verifyBrief(top, brief, testCmd): Promise<typeof brief>`. Each C row gets `confirmed: boolean | null` and `testTail`.

- [ ] **Step 1: Write the failing tests**
```ts
test('C where the caller now passes a removed arg → covering test fails → confirmed: true', ...);
test('C where the caller stays compatible (new param has a default) → tests pass → confirmed: false', ...);
test('C with no covering tests → confirmed: null', ...);
test('verify never touches the user\'s worktree (status --porcelain identical before/after)', ...);
```
- [ ] **Step 2: Run them to see them fail**
Run: `npx vitest run packages/memory/test/conflict.test.ts -t verify`
Expected: FAIL.
- [ ] **Step 3: Implement**
- Make a temporary worktree at `ours` (`git worktree add --detach`). For each file, write the regionMerge text (or the side that changed it).
- Run `coveringTests` from P3 Task 7 (import it from `@loom/daemon/live/queue`, or move it to `@loom/memory` and re-export it; ruling: move it, so memory has no daemon dependency).
- Record the result, then remove the worktree in a `finally`.
- [ ] **Step 4: Run them to see them pass**
Run: `npx vitest run packages/memory/test/conflict.test.ts`
Expected: PASS 14/14.

---

### Task 4: Path-based `why`, `impact`, `history`, `changes_since`

**Files:**
- Create: `packages/memory/src/paths.ts`, `packages/memory/test/paths.test.ts`
- Modify: `packages/daemon/src/server.ts` (the `why`, `impact`, `history` and `changes_since` MCP cases on the repo graph), `packages/cli/src/loom.ts` (`why`, `history` v2)

**Interfaces:**
- Produces:
  - `whyPath(g, top, target: string): Promise<{ region: string; chains: Array<{ path: PathStep[]; decision?: string; task?: string; person?: string; commit?: string }>; missing: string[] }>`. `target` is a region id, `file:line`, a qname, `decision:<id>` or `version:<id>`.
  - `impactPath(g, region, hops = 3): Promise<{ callers: Array<{ region, hops, path }>; tests: Array<{ region, path }>; holders: string[] }>`
  - `changesSince(g, top, since: string | number)`: the P2 `news` items, each with a path.

- [ ] **Step 1: Write the failing tests**
```ts
test('why on a region with a decision: Region←Version←Agent←Session←Person and Decision-LED_TO→Version', ...);
test('why file:line resolves the innermost definition region', ...);
test('why on a baseline-only region → one chain to the baseline commit, missing [decision, session]', ...);
test('impact follows CALLS, IMPORTS and TESTS within 3 hops, with a path per hit', ...);
test('history returns the version DAG with people, tasks and decisions, and a path per version', ...);
test('changes_since a sha = the P2 news items for that watermark, each with a path', ...);
```
- [ ] **Step 2: Run them to see them fail**
Run: `npx vitest run packages/memory/test/paths.test.ts`
Expected: FAIL.
- [ ] **Step 3: Implement.** Each function returns the graph traversal as `path[]` steps (ruling 5). `resolveTarget` handles `file:line` with Region `start`/`end` offsets, converted from lines with the file text at HEAD.
- [ ] **Step 4: Run them to see them pass**
Run: `npx vitest run packages/memory/test/paths.test.ts packages/daemon`
Expected: PASS, with v1 `why.test.ts` unchanged (v1 runs still use the v1 `why`).

---

### Task 5: Graph algorithms as tools — `hotspots`, `clusters`, `path`

**Files:**
- Create: `packages/memory/src/algos.ts`, `packages/memory/test/algos.test.ts`

**Interfaces:**
- Produces:
  - `hotspots(g, scope?: string, k = 10): Promise<Array<{ region, score, path }>>` (`algo.betweenness` on `Region`/`CALLS`, filtered by a path prefix)
  - `clusters(g, scope?: string): Promise<Array<{ id: number; regions: string[] }>>` (`algo.WCC`)
  - `shortest(g, from: string, to: string, directed = false): Promise<{ found: boolean; path: PathStep[] }>`

- [ ] **Step 1: Write the failing tests.** The fixture has two disjoint call chains in `pkg/`, plus a hub function called by 4 others.
```ts
test('hotspots ranks the hub first within scope pkg/', ...);
test('clusters returns the two disjoint chains as two components', ...);
test('path finds caller→hub→callee undirected and directed; no route → found:false, path []', ...);
```
- [ ] **Step 2: Run them to see them fail**
Run: `npx vitest run packages/memory/test/algos.test.ts`
Expected: FAIL.
- [ ] **Step 3: Implement.** Use the same procedure-call shapes as the v1 planner's `partition` (already verified on this FalkorDB): `CALL algo.betweenness({nodeLabels: ['Region'], relationshipTypes: ['CALLS']}) YIELD node, score` and `CALL algo.WCC({nodeLabels: ['Region'], relationshipTypes: ['CALLS']}) YIELD node, componentId`. The path uses `MATCH p = shortestPath((a:Region {id:$a})-[:CALLS|IMPORTS|TESTS*..10]-(b:Region {id:$b})) RETURN p`.
- [ ] **Step 4: Run them to see them pass**
Run: `npx vitest run packages/memory/test/algos.test.ts`
Expected: PASS 3/3.

---

### Task 6: MCP — 19 tools on the repo graph (+ `define_regions`, cuttable)

**Files:**
- Modify: `packages/mcp/src/loom-mcp.ts`, `packages/daemon/src/server.ts`
- Create: `packages/daemon/test/live/mcp19.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
const NINETEEN = ['register','lease','release','notices','ack_notice','who_is_touching','impact','why','record_decision','lessons',
  'claim_task','claim_done','history','changes_since','conflict','hotspots','clusters','path','define_regions'];
test('the MCP server lists exactly the 19 tools', async () => { expect((await listTools()).map((t) => t.name).sort()).toEqual([...NINETEEN].sort()); });
test('every query tool response carries path[] (one call each on the fixture repo)', ...);
test('record_decision writes a decision event to the session file and a Decision node, and why then cites it', ...);
test('define_regions on a .txt file: valid exact cover accepted and written as markers; overlapping ranges rejected with the §3.2 rule named', ...);
```
- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/daemon/test/live/mcp19.test.ts`
Expected: FAIL. 12 tools are listed.
- [ ] **Step 3: Implement.** Register the 7 new tools, with zod schemas and the descriptions from §7. In the daemon's MCP dispatch, route by repo (`resolveRepo(b.cwd)`) to `@loom/memory` / `Live`. `define_regions` validates with the §3.2 invariant checks from `@loom/indexer` (exact cover, no overlap, no empties), then writes `# loom:region` markers (§3.8).
- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/daemon packages/mcp`
Expected: PASS.

---

### Task 7: Mined lessons (§6.10)

**Files:**
- Create: `packages/memory/src/mine.ts`, `packages/memory/test/mine.test.ts`
- Modify: `packages/daemon/src/live/live.ts` (call `mineStaleRecovered` when a denied-stale agent later lands a passing edit), `conflict.ts` (after `--verify` confirms a C)

- [ ] **Step 1: Write the failing tests**
```ts
test('stale deny → re-read → landed passing edit → a lesson on that region: "re-read R after <by>\'s change: <decision>"', ...);
test('C confirmed by --verify → a lesson on R naming the contract and the broken caller', ...);
test('mined lessons are in the repo graph and in .loom/ (a lesson event), and never in another tenant\'s graph', ...);
```
- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run packages/memory/test/mine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `addLesson(g, root, act, region, text, 'mined')` (P2).
- [ ] **Step 4: Run them to see them pass.** Expected: PASS 3/3.

---

### Task 8: L0 conflict gate

**Files:**
- Create: `packages/memory/test/l0-conflict.test.ts`

Two clones and two people, through the real hooks (the `l0-memory.test.ts` harness), produce a real `git merge` with a conflict:
```ts
test('1. classes A–D found in one real merge, each on the right region', ...);
test('2. both sides\' paths: A\'s session/task/decision and B\'s, since base', ...);
test('3. --verify confirms the C (covering test fails on the merged tree) and records a mined lesson', ...);
test('4. lesson scoping: the mined lesson is injected at B\'s PreToolUse on R, and never for tenant l0x', ...);
test('5. loom diff base..HEAD after resolving: the resolution commit lists the A/B regions by both people', ...);
test('6. every MCP query response in this scenario carries a non-empty path[]', ...);
```
- [ ] **Step 1:** Write the test in full. Run: `npx vitest run packages/memory/test/l0-conflict.test.ts > bench/results/l0-conflict.txt 2>&1`. Expected: PASS 6/6.
- [ ] **Step 2:** Run the whole suite: `npx vitest run`. Expected: green; record the count.

---

### Task 9: Ledger, then X1 and X2 (each needs a go-ahead)

- [ ] **Step 1:** Add ledger rows P4-1 … P4-8 (diff grouping, classes A–D, verify, path on every response, algos, 19 tools, mined lessons, L0 conflict). Each cites its command and result file.
- [ ] **Step 2:** Ask Abhinav for a go-ahead on **X1** (~$2): 4 pairs; session 1 lands a contract change plus a decision, then a fresh session 2 works on a caller, with the repo graph vs an empty graph. Bar: right with the graph, and `why` cites the decision. Run it, then record the result in the ledger whatever it is.
- [ ] **Step 3:** Ask Abhinav for a go-ahead on **X2** (~$2): 2 clones × 3 scenarios, with `.loom/` vs without. Bar: the explainer is right on every scenario, and the agent outcome is better with `.loom/`. Run it, then record the result.
