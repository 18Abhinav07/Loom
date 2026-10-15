# Loom v2 — Design Spec

- **Status:** under review (Abhinav) · **Date:** 2026-10-15 · **Deadline:** 2026-10-18 23:59 IST
- **Event:** Graph Hacks (WeMakeDevs × FalkorDB) · **Primary:** Track 02 Agent Memory & Coordination · **Secondary:** Track 01 Agents That Act on Connected Data
- **Supersedes:** vault `graph-hacks-falkordb/spec.md` §1 and §4.4 (per-repo/per-tenant claims the v1 code did not implement)

---

## 0. One paragraph

Loom is a codebase's memory, kept in FalkorDB and carried in git. On one machine, a coordinator's parallel coding agents share it **live**: region leases, version checks before every edit, code handover and a merge queue. Across sessions and collaborators it travels **asynchronously** with the code: append-only `.loom/` records in the repo are replayed into each person's local graph. Every change knows who made it, for which task, why, what it affected, and what the next person needs to know. Every answer Loom gives is a graph path.

### What Loom does not promise

There is no real-time coordination between machines. Each collaborator runs a local daemon and graph, and B sees A's work only after A pushes and B pulls. A shared hosted FalkorDB would make this live, but it is out of scope for the event.

---

## 1. Requirements → features → proof

| Requirement (brief / track) | Feature | Proof |
|---|---|---|
| T2 episodic memory | Session, Message, Handoff and Version history | X1 |
| T2 semantic memory | Region, Version chain, code edges, Decision | X1, L0 |
| T2 procedural memory | Lesson, scoped to region and repo | X1, L0 (C1 regression test) |
| T2 persistent conversation history | Message and Thread nodes, carried in `.loom/` | X1, X2 |
| T2 shared state and handoffs | Leases, version check, handover, merge queue (live); `.loom/` sync and briefing (async) | STALE core, E5, X2 |
| T2 high-concurrency reads/writes | Lease claim as atomic compare-and-set; FalkorDB serializes writes per graph | Stress test S1 |
| T2 separate memory per user/tenant | One graph per tenant and repo: `loom:<tenant>:<repoId>` | Isolation test I1 |
| T1 multi-hop reasoning | `impact`/`why`/`conflict` across CALLS, IMPORTS, TESTS and version chains | L0, STALE |
| T1 graph queries and algorithms as tools | MCP `hotspots` (betweenness), `clusters` (WCC), `path` (shortest path) | L0 |
| T1 tool selection through MCP | 19 MCP tools (§7) | Transcripts in the bench runs |
| T1 actions based on the graph | Deny/wait, caller fixes, merge-queue resolution | STALE, E5 |
| T1 explainable results | Every answer carries `path[]`; Why explorer; conflict explainer | L0, UI |
| Brief: follow connections | Same as T1 multi-hop | — |
| Brief: remember across sessions | Same as T2 memory | X1 |
| Brief: share state between agents | Same as T2 handoffs | STALE, E5, X2 |
| Brief: connect people, projects, decisions | Person → Session → Agent → Task → Decision → Version | X2 |
| Brief: show the path | `path[]` on every response | All |

---

## 2. Architecture

```
 machine of collaborator A                          machine of collaborator B
 ┌──────────────────────────────────────┐          ┌──────────────────────────┐
 │ claude agents ─hooks/MCP─▶ loomd ─▶ FalkorDB │   │   (same stack)           │
 │        ▲                    │                 │   │                          │
 │        └── briefing/notices ┘                 │   │                          │
 │ loomd ⇄ git worktrees (loom run)              │   │                          │
 │ loomd ─export─▶ .loom/ ──git push──▶ remote ──git pull──▶ .loom/ ─import─▶ │
 └──────────────────────────────────────┘          └──────────────────────────┘
```

**Source of truth is git:** code, plus `.loom/regions.lock`, plus `.loom/sessions/*.jsonl`. The FalkorDB graph is a derived, queryable index of that truth, plus live state (leases, waits, unacknowledged notices) that only exists while a run is going. Deleting the graph loses nothing durable; `loom init` rebuilds it.

**Packages** (existing pnpm monorepo, kept):

| Package | Does |
|---|---|
| `core` | db, schema, types |
| `indexer` | region engine, language packs |
| `daemon` | API, coordinator, memory, sync, conflict engine |
| `hook` | Claude Code hooks and git hooks |
| `mcp` | agent tools |
| `planner` | WCC/betweenness task split |
| `cli` | commands |
| `apps/dashboard` | UI |

---

## 3. Regions

### 3.1 Kinds

| Kind | What it covers | Lease semantics |
|---|---|---|
| `definition` | function, method, class body, top-level assignment | write / contract |
| `container` | class or module header outside its member definitions | write |
| `imports` | the file's import block | none; set-union merge |
| `gap` | bytes between regions (comments, blank lines, module code) | write |
| `key` | a top-level key in structured files (JSON, YAML, TOML) | write |
| `section` | a Markdown heading section, or a marker block | write |
| `file` | the whole-file fallback | write |

### 3.2 Invariants

These are checked by `loom regions check` and by property tests.

1. **Exact cover.** A file's regions, concatenated in order, equal the file's bytes.
2. **No overlap.**
3. **Deterministic.** The same bytes and the same pack version always give the same regions.
4. **Local.** Editing inside region R changes only R's span, plus the offsets of later regions. No other region's ID changes.

### 3.3 Identity

`<path>::<qualified.path>::<kind>#<n>`. `n` tells apart duplicates of the same name (overloads, redefinitions), in source order. Gaps are named `gap@after:<prev-id>` (or `gap@start`). IDs never contain line numbers.

### 3.4 Lifecycle

These rules apply on each reparse of a file, comparing the old and new region sets.

| Change | Result |
|---|---|
| Same ID, body hash differs | **update**: a new Version |
| New ID | **create**: Version v1 |
| ID gone | **tombstone**: a Version with `deleted: true`; the chain is kept |
| ID gone, and a new ID has an *identical* body hash in the same commit | **rename/move**: new Region `-[:RENAMED_FROM]->` old; the chain continues. Exact match only. |
| File created / deleted | creates / tombstones all of its regions |
| File renamed (git rename detection, 100% similarity) | region IDs re-pathed; recorded as RENAMED_FROM |
| Split / merge | delete + create. No guessing. |

### 3.5 Strict parsing

- A parse with any ERROR or MISSING node **never** produces a new map.
- Instead the file keeps its last clean map from the lock. If the new bytes make that map inconsistent, the file falls back to a single conservative `file` region, flagged `degraded: true`.
- `loom status` and the briefing report degraded files.

### 3.6 Language packs

Packs are data, not code. A pack is a tree-sitter grammar (wasm), plus `tags.scm` (definitions and containers), `imports.scm` and `calls.scm`, plus `pack.json` (`{name, version, extensions, grammar}`).

**Tiers, applied per file, first match wins:**
1. marker blocks
2. a language pack query
3. structured keys (JSON/YAML/TOML)
4. Markdown headings
5. regions an agent defined (`define_regions`, validated against the §3.2 invariants)
6. the whole-file fallback

**Always whole-file:** binary files, files over 1 MB, minified files (average line length over 300), lockfiles, and generated files (`linguist-generated` or a `@generated` header).

**Event scope:** Python (port the existing `python.ts` to the pack form) and TypeScript/JavaScript, plus Markdown and JSON. Further packs are post-event.

### 3.7 Markers (opt-in)

```
# loom:region <name>
...
# loom:end
```

- Any comment syntax is accepted.
- Markers must nest properly; an unbalanced marker makes the file degraded.
- `loom regions mark <file> <start-line> <end-line> <name>` inserts them.
- They are never inserted automatically.

### 3.8 `.loom/regions.lock`

One JSON object per line, sorted by path:

```json
{"path":"django/utils/text.py","blob":"<git blob sha>","pack":"python@1","degraded":false,
 "regions":[{"id":"django/utils/text.py::slugify::definition#0","kind":"definition","start":1234,"end":1890,"hash":"<sha1 of bytes>","sig":"slugify(value, allow_unicode=False)"}]}
```

**Updated by:**
- the PostToolUse hook: the edited file, kept in memory and the graph, not written to the lock;
- the git **pre-commit** hook: lock entries for staged files are rewritten and staged;
- post-merge, post-checkout and post-rewrite: changed files.

**Merge conflicts on the lock:**
- `.gitattributes` sets `.loom/regions.lock merge=loom-lock linguist-generated`.
- `loom init` registers the driver (`git config merge.loom-lock.driver "loom lock-merge %O %A %B %P"`). The driver regenerates the entries from the merged code.
- Without the driver installed, `loom sync` regenerates the lock.

**Pack upgrades:** the lock records the pack version. If it differs from the installed pack, `loom reindex` must be run explicitly; it reports every ID change as a rename or delete+create. Nothing changes silently.

---

## 4. The graph

### 4.1 Name

`loom:<tenant>:<repoId>`.

- `repoId` is the sha of the repo's root commit, which is stable across clones.
- `tenant` comes from `~/.loom/config.json` (`{"tenant":"abhinav"}`, default `$USER`).

Runs are no longer separate graphs. A Run is a node.

### 4.2 Nodes

| Label | Key properties |
|---|---|
| `Person` | id (git email), name |
| `Session` | id (ulid), person, started, ended, kind (`run` / `interactive`), base commit |
| `Run` | id, session, plan |
| `Agent` | id `<session>/<name>`, model |
| `Task` | id, title, status (`open` / `claimed` / `done` / `abandoned`), claimed_by |
| `Region` | id, path, kind, qname, current start/end/hash/sig, degraded |
| `Version` | id `<region>@<n>`, n, hash, sig, deleted, commit, at, external |
| `Commit` | sha, author, at, message |
| `Decision` | id, text, at |
| `Evidence` | id, test, result, at |
| `Lesson` | id, text, source (`mined` / `manual`), at |
| `Message` | id, kind (`notice` / `wake` / `ask` / `ack` / `human` / `briefing` / `handoff`), text, at |
| `Thread` | id, topic |
| `Handoff` | id, summary, open leases, unfinished tasks |

Live state only: `Lease` (holder, region, mode, since) and `Change` (in-flight edit).

### 4.3 Edges

- `(Person)-[:STARTED]->(Session)-[:RAN]->(Agent)`
- `(Session)-[:HAS_RUN]->(Run)`
- `(Agent)-[:WORKED_ON]->(Task)`
- `(Region)-[:HEAD]->(Version)`, `(Version)-[:PREV]->(Version)`
- `(Version)-[:OF]->(Region)`
- `(Version)-[:BY]->(Agent|Person)`, `(Version)-[:FOR]->(Task)`, `(Version)-[:IN]->(Commit)`
- `(Decision)-[:ABOUT]->(Region)`, `(Decision)-[:LED_TO]->(Version)`, `(Decision)-[:BY]->(Agent|Person)`
- `(Evidence)-[:VERIFIES]->(Version)`
- `(Lesson)-[:ON]->(Region)`
- `(Message)-[:IN_THREAD]->(Thread)`, `(Message)-[:FROM]->(Agent|Person)`, `(Message)-[:TO]->(Agent|Person)`, `(Message)-[:ABOUT]->(Region|Task|Decision)`
- `(Handoff)-[:FROM]->(Session)`, `(Handoff)-[:LEAVES]->(Task)`
- `(Region)-[:CALLS|IMPORTS|TESTS|CONTAINS]->(Region)`, `(Region)-[:RENAMED_FROM]->(Region)`
- Live: `(Agent)-[:HOLDS]->(Lease)-[:ON]->(Region)`, `(Agent)-[:WAITS_ON]->(Agent)`

### 4.4 External changes

For any commit reachable from HEAD with no `.loom` record, reconcile (§6.3) creates `Version {external: true}` `-[:BY]->(Person from git author)`. Memory therefore never silently misses human edits or edits made without Loom.

---

## 5. `.loom/` in the repo

```
.loom/
  regions.lock            # §3.8
  sessions/<ulid>.jsonl   # one append-only file per session; never edited by anyone else
  config.json             # repo settings: dirs to index, packs, test command
  .gitattributes          # lock merge driver, linguist-generated
```

### 5.1 Session record events

One JSON object per line. Every line has `{"v":1,"type":...,"id":...,"at":...}`.

| Type | Fields |
|---|---|
| `session` | person, kind, base |
| `agent` | name, model |
| `task` | title, status, by |
| `version` | region, n, hash, sig, deleted, by, task, renamed_from |
| `decision` | text, regions[], by, led_to[] |
| `evidence` | test, result, versions[] |
| `lesson` | text, regions[], source |
| `message` | kind, text, from, to, about[], thread |
| `handoff` | summary, open_tasks[], open_leases[] |

**Commit association:** `version` lines are written by the pre-commit hook and staged in the same commit. On import, each line's commit is resolved with `git blame --line-porcelain` on the session file: one call per file, cached by blob.

**Conflict-free by construction:** each session writes only its own file. There is no shared mutable file except the lock, which has its own merge driver.

### 5.2 Import

- Import is idempotent: `MERGE` on the event ID.
- The graph stores `(:Imported {file, blob})` so unchanged files are skipped.

---

## 6. Flows

### 6.1 `loom init`

Run once per clone; safe to repeat.

1. Ensure the daemon and FalkorDB are running (`loom up`).
2. If `.loom/regions.lock` exists, verify each entry's blob against the working tree and reparse only the mismatches. Otherwise index everything and write the lock.
3. Install the Claude Code hooks (project `.claude/settings.json`) and the MCP server entry.
4. Install the git hooks: pre-commit, post-commit, post-merge, post-checkout, post-rewrite. Existing hooks are moved to `<name>.pre-loom` and chained; core.hooksPath setups such as husky are respected.
5. Register the lock merge driver.
6. Import all `.loom/sessions/*` (§5.2), then reconcile (§6.3).
7. Print a summary: regions, versions, people, sessions, degraded files.

### 6.2 Interactive session

One person, one Claude Code session, no `loom run`.

1. **SessionStart hook:**
   - create the Session and Agent and append them to the session file;
   - run `loom sync --quiet`;
   - inject the briefing (§6.4) as `additionalContext`.
2. **PreToolUse on Edit/Write:**
   - map the target span to regions;
   - **version check:** if the graph's HEAD version of a region is newer than the version this agent last read, deny with the newer version's diff summary and its decision;
   - take the lease (auto-lease);
   - deny if another live agent holds it.
3. **PostToolUse:** reparse the file, record the Change, compute notices for other live agents, update in-memory regions.
4. **Bash writes the hooks can't see:** detected at the next hook by diffing worktree blobs, and reported as `unleased_write` notices.
5. **git commit:**
   - pre-commit: write `version` events for the regions the staged changes touch, update the lock, stage both;
   - post-commit: graph `Commit` node, Versions linked to it.
6. **SessionEnd hook** (= `loom finish`):
   - write the `handoff` event (open tasks, open leases, summary from the agent's last message);
   - release the leases;
   - leave the session file staged with a reminder to commit it. If the working tree is otherwise clean, `loom finish --commit` makes a `loom: session <id> records` commit.

### 6.3 `loom sync`

Runs after pull, merge or checkout (git hook), at session start, or by hand.

1. Import new or changed `.loom/sessions/*` files.
2. Reparse files changed between the last synced commit and HEAD; update the lock (left as a local change if it differs).
3. **Reconcile:** for commits in `lastSynced..HEAD` with no session records, create external Versions (§4.4).
4. **News:**
   - select Versions, Decisions, Tasks, Handoffs and Lessons from *other* people and sessions created after this person's watermark;
   - rank them: 3 points if the region is in one of my open tasks, 2 if it's within 2 hops of one, 1 if it's in a file I touched in my last 3 sessions;
   - keep the top 10.
5. Store the result as a `Message {kind: briefing}`, print it, and advance the watermark.

### 6.4 Briefing format

Deterministic template, at most 25 lines:

```
[loom] Since your last sync (abc123 → def456), 2 people, 3 sessions:
- slugify (django/utils/text.py) v3 → v5 by B/S7/agent-a for T4 "strict mode".
  Decision D12: "strict is keyword-only because callers pass positionally". Callers in your tasks: title_slug.
- T9 "unicode filenames" left unfinished by B (handoff H3): Truncator.chars half-done.
- Lesson L2 on slugify: "run test_text.py::SlugifyTests after changing slugify".
Ask: history(region) · why(region) · changes_since(commit)
```

### 6.5 `loom run`: one coordinator, many agents, live

This is v1's run with the RC fixes.

1. Plan (planner: WCC clusters → tasks; betweenness → order). Tasks are written to the graph and to the session file.
2. One worktree per agent and one headless `claude -p` per agent, all sharing the coordinator's Session (`kind: run`).
3. Live: leases, version checks, notices.
4. **Code handover (fixes RC1/RC2/RC3)**, when a holder lands:
   - every agent waiting on it gets a wake;
   - before the wake is delivered, its worktree is synced with `git merge --autostash <landed branch>`;
   - if that conflicts, the splice fallback replaces the region bodies with the landed version from the graph (only when the waiting agent has not edited those regions);
   - otherwise the wake says "conflict in R; resolve" and includes the conflict brief (§6.7).
   - Wake text is generated at delivery time from current graph state, never cached.
5. **Merge queue:**
   - when an agent finishes, it merges everything landed so far into its worktree, runs its tests, then commits and lands;
   - on a conflict or failing test, the agent is resumed with the conflict brief.
   - The final merge order is landing order.
6. **Denial back-off (RC5):** each denial carries the holder, the holder's task and an expected wait. A third denial on the same region within 60 seconds makes the PreToolUse hook return a "wait for wake" instruction instead of another denial.
7. **No self-wakes (RC6):** wakes are filtered with `holder ≠ recipient`, and there's a test for it.
8. **`tests/` indexed (RC4):** TESTS edges come from test functions' calls.

### 6.6 Async collaborators

```
A: loom run / interactive → commits (+ .loom records) → push
B: git pull → post-merge hook → loom sync → briefing next session → B's agents see A's versions/decisions
B edits a region A changed after B's base → version check denies the stale edit and names A's decision
```

**Task claims across collaborators** are async and best-effort:
- `claim_task` writes a `task` event;
- B sees it after pulling;
- the briefing flags it if B is about to start an overlapping task.

The pitch never claims more than this.

### 6.7 `loom conflict`: merge conflict explainer

Runs inside a merge (`MERGE_HEAD` exists), or with `loom conflict <ours> <theirs>`.

1. Find `base = merge-base(ours, theirs)`. Import the `.loom/sessions/*` files from *theirs'* tree (read with `git show`), so both sides' history is in the graph.
2. Compute region diffs base→ours and base→theirs (indexer `diff.ts`).
3. Classify every region:
   - **A** textual conflict: git conflict markers fall inside the region;
   - **B** both sides changed it and git merged it cleanly. Risky, so it's listed.
   - **C** semantic conflict: one side changed R's contract (signature, raised errors, return type), the other added or changed regions that CALL R (v1 `mergecheck` prediction);
   - **D** one side deleted R, the other modified it.
4. For each, attach both sides' version chains since base: person, session, agent, task, decision, evidence. Also attach the affected callers (impact) and the covering tests (TESTS edges).
5. Output:
   - a CLI table;
   - `--json` (the conflict brief used by agents and the merge queue);
   - `--verify`, which runs the covering tests on the merged tree;
   - the same JSON drives the dashboard Conflict view.

### 6.8 `loom diff <a>..<b>` and `loom log`

The same engine as §6.7 without classification. It returns regions changed between commits, grouped by commit → person → session → agent, with decisions and evidence. `loom log` is the per-commit summary list. Both feed the dashboard Timeline and Commit views.

### 6.9 Lessons (procedural)

**Mined lessons:**
- a notice the agent ignored that ended in a failing test (v1 behaviour);
- a version check that denied an edit, when the agent then succeeded after reading the newer version;
- a conflict of kind C caught by `--verify`.

**Manual:** `loom lesson add`.

**Scope:** stored in the repo graph and `.loom/` records, so a lesson never leaves its repo or tenant (fixes C1). They are injected at a PreToolUse edit on the matching region and in the briefing.

---

## 7. MCP tools (19)

Every response is JSON and includes a `path[]` of `{node, edge}` steps.

| Tool | Status | Purpose |
|---|---|---|
| `register` | existing | identify the agent |
| `lease` / `release` | existing | lease regions |
| `notices` / `ack_notice` | existing | read and acknowledge notices |
| `who_is_touching` | existing | live holders and editors |
| `impact` | existing, extended to IMPORTS/TESTS | callers and tests within 3 hops |
| `why` | existing, now returns the path | why a region looks the way it does |
| `record_decision` | existing | write a Decision |
| `lessons` | existing, repo-scoped | lessons for a region |
| `claim_task` / `claim_done` | existing | claim and finish tasks |
| `history` | **new** | a region's version chain with people/agents/tasks/decisions |
| `changes_since` | **new** | the news for a commit or time (§6.3 step 4) |
| `conflict` | **new** | the conflict brief (§6.7) |
| `hotspots` | **new** | betweenness on CALLS within a scope |
| `clusters` | **new** | WCC on CALLS within a scope |
| `path` | **new** | shortest path between two regions or entities |
| `define_regions` | **new** | an agent proposes regions for an unparsed file; validated against §3.2 |

---

## 8. CLI

Every command supports `--json`.

| Command | Status |
|---|---|
| `loom init [--tenant t]` | upgraded (§6.1) |
| `loom up / down / status` | existing; status adds degraded files and the sync watermark |
| `loom sync [--quiet]` | **new** (§6.3) |
| `loom brief [--agent a]` | **new**: print the current briefing |
| `loom finish [--commit]` | **new** (§6.2 step 6) |
| `loom run --plan <file> [--blind]` | upgraded (§6.5) |
| `loom conflict [ours theirs] [--verify]` | **new** (§6.7) |
| `loom diff <a>..<b>` / `loom log [-n]` | **new** (§6.8) |
| `loom history <region>` | **new** |
| `loom why <region\|decision\|version>` | existing, now path-based |
| `loom regions [file] \| check \| mark … \| reindex` | **new** (§3) |
| `loom tasks [list\|claim\|done\|abandon]` | **new** |
| `loom lesson add\|list` | existing, repo-scoped |
| `loom lock-merge %O %A %B %P` | **new**: internal merge driver |
| `loom hook git <name>` | **new**: internal git hook entry |
| `loom merge-check`, `loom replay`, `loom verify`, `loom plan` | existing |
| `loom ui` | existing |
| `loom demo` | **new**: replays the bundled recordings; no API key needed |

---

## 9. Dashboard

Built after the tool works. Light Claude theme (cream/orange), with dark mode. Every view reads the same JSON as the CLI.

| View | Shows |
|---|---|
| **Repo timeline** | commits as rows; lanes per person → session → agent; click through to the commit graph diff |
| **Commit / diff** | the regions a commit or range changed, as a subgraph (region ← version ← agent ← person, plus decision and evidence) |
| **Conflict** | the §6.7 classification; both sides' chains side by side; affected callers highlighted |
| **Region history** | the version chain for one region, with diffs, the why path and lessons |
| **Why explorer** | the `path[]` of any answer drawn as a graph; every node can be queried |
| **Live run** | v1 Live/Timeline: leases, waits, wakes, the merge queue |
| **People & agents** | collaborators → their sessions → agents → work done |
| **Bench** | STALE / E5 / X1 / X2 / S1 / I1 results, raw records linked |

Every number has an ⓘ explainer. The Ask bot (`/ask` through the local Claude Code CLI) is first on the cut list.

---

## 10. Proof plan

All agent runs use the Claude Code CLI on the subscription, model Sonnet, with all `ANTHROPIC_*` environment variables stripped. The extended/full STALE sets never run without explicit approval.

| ID | What | Pass bar | Cost |
|---|---|---|---|
| L−1 | Region engine on the Django corpus (882 files) plus TS fixtures. Property tests of the §3.2 invariants, mutation fuzzing (random edits → locality), golden fixtures per kind. | 100% invariants hold; 0 ERROR-parse maps | $0 |
| L0 | Scripted fake agents for every mechanism: lease, version check, handover, merge queue, back-off, no self-wake, sync/import idempotence, lock merge driver, conflict classes A–D, lessons scoping | all green in CI | $0 |
| STALE core | 12 pairs × blind / oracle / live | live ≥ 11/12 merged-pass, blind stays 0/12 | ~$2.5 |
| E5 team | s1/s2/s3, 4 agents editing the same function; grader fixed to judge `agents_ok` on the full merge | loom 3/3 all_pass vs blind | ~$4 |
| X1 cross-session | 4 pairs: session 1 lands a contract change plus a decision; a fresh session 2 works on a caller. Run with the repo graph and with an empty graph. | correct with the repo graph, and `why` cites D | ~$2 |
| X2 async collaborators | 2 clones, 3 scenarios: B pulls A's work and makes a stale edit (version check); B starts an overlapping task (briefing); a real merge conflict (explainer classifies A–D, `--verify` finds the C-kind conflict). With `.loom/` vs without. | the explainer is correct on every scenario; the agent outcome is better with `.loom/` | ~$2 |
| S1 stress | 32 simulated agents × 200 lease ops on one graph, no LLM | 0 double grants; report p50/p99 | $0 |
| I1 isolation | 2 tenants on the same repo; plus the C1 lesson-leak case | 0 cross-reads | $0 |

Every number reported links to its `records.jsonl`. Failures are reported, not hidden.

---

## 11. Repository and delivery

- **Remote:** GitHub `18Abhinav07/<name>`, created with `gh`. Visibility per Abhinav's decision.
- **Branches:**
  - `main` only receives merges;
  - `docs/<topic>`, `feat/p<N>-<topic>`, `fix/<topic>`, `bench/<id>`;
  - one PR per branch, merged with a merge commit (history kept).
- **Commits:** conventional (`feat:`, `fix:`, `docs:`, `test:`, `bench:`), small, TDD where the code allows it (failing test first).
- **Phases:** each phase is one or more PRs, and a phase merges only when its proofs pass.

| Phase | Day | Content | Gate |
|---|---|---|---|
| P0 | Thu 15 | Repo, README stub, this spec, findings (E1/E5 analysis, RC1–RC6), plan | docs merged |
| P1 | Thu 15–Fri 16 | Region engine: kinds, IDs, lifecycle, strict parse, packs (Python, TS/JS, MD, JSON), markers, lock and merge driver | L−1 green |
| P2 | Fri 16 | Repo graph (§4); `.loom/` sessions, export/import; git hooks; sync, reconcile, briefing; tenant naming; lessons repo-scoped | L0 memory/sync/isolation green; I1 |
| P3 | Fri 16–Sat 17 | Live fixes: version check, handover, merge queue, RC1–RC6, E5 grader fix | L0 coordination green; STALE core; E5; S1 |
| P4 | Sat 17 | Conflict/diff engine, new MCP tools, path-based `why` | L0 conflict green; X1; X2 |
| P5 | Sat 17–Sun 18 | Dashboard views, `loom demo`, README, demo video, submission | review |

- **Cut order if late:** Ask bot → `define_regions` → TS pack (Python only) → splice fallback → Region-history view.
- **Never cut:** L−1, L0, STALE, E5, X1, X2.

---

## 12. Out of scope

- Real-time cross-machine coordination (needs a shared hosted FalkorDB).
- Distributed concurrency.
- Auth and multi-user servers.
- Packs beyond Python/TS/MD/JSON.
- Storing full agent transcripts.
- Track 03 (Company Brain).

---

## 13. Decisions (resolved 2026-10-15)

1. Remote `github.com/18Abhinav07/Loom`, private. It goes public only on Abhinav's go-ahead.
2. The prior prototype code is committed as regular work. The organisers confirmed this is allowed.
