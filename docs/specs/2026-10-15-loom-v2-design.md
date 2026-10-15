# Loom v2 — Design Spec

- **Status:** APPROVED (Abhinav, 2026-10-15), refined after the technical review in §14 · **Deadline:** 2026-10-18 23:59 IST
- **Event:** Graph Hacks (WeMakeDevs × FalkorDB) · **Primary:** Track 02 Agent Memory & Coordination · **Secondary:** Track 01 Agents That Act on Connected Data
- **Supersedes:** vault `graph-hacks-falkordb/spec.md` §1 and §4.4 (per-repo/per-tenant claims the v1 code did not implement)

---

## 0. One paragraph

Loom is a codebase's memory, kept in FalkorDB and carried in git. On one machine, every agent session shares it **live**: region leases, version checks before every edit, code handover and a merge queue. Across sessions, branches and collaborators it travels **asynchronously** with the code: append-only `.loom/` records in the repo are replayed into each person's local graph, and `loom sync` reads the upstream branch before you pull. Every change knows who made it, for which task, why, what it affected, and what the next person needs to know. Every answer Loom gives is a graph path.

### What Loom does not promise

- **No real-time coordination between machines.** Each collaborator runs a local daemon and graph. B learns of A's work once A has pushed and B's `loom sync` has fetched it. B does not have to pull or merge first (§6.3). A shared hosted FalkorDB would make this live, but it is out of scope for the event.
- **No full transcripts.** Loom stores the messages that pass between agents and people (notices, wakes, briefings, handoffs, decisions). It does not store raw model conversations.
- **No history before `loom init`.** Region history starts at the init baseline (§6.1).

---

## 1. Requirements → features → proof

| Requirement (brief / track) | Feature | Proof |
|---|---|---|
| T2 episodic memory | Session, Message, Handoff and Version history | X1 |
| T2 semantic memory | Region, Version DAG, code edges, Decision | X1, L0 |
| T2 procedural memory | Lesson, scoped to region and repo | X1, L0 (C1 regression test) |
| T2 persistent conversation history | Message and Thread nodes (inter-agent and human messages), carried in `.loom/` | X1, X2 |
| T2 shared state and handoffs | Leases, version check, handover, merge queue (live); `.loom/` sync, upstream read, briefing (async) | STALE core, E5, X2 |
| T2 high-concurrency reads/writes | Lease claim as one atomic compare-and-set query; FalkorDB serializes writes per graph | S1 |
| T2 separate memory per user/tenant | One graph per tenant and repo: `loom:<tenant>:<repoId>`; the daemon derives the graph from the registered session, never from the request | I1 |
| T1 multi-hop reasoning | `impact`/`why`/`conflict` across CALLS, IMPORTS, TESTS and version DAGs | L0, STALE |
| T1 graph queries and algorithms as tools | MCP `hotspots` (`algo.betweenness`), `clusters` (`algo.WCC`), `path` (`shortestPath`) | L0 |
| T1 tool selection through MCP | 19 MCP tools (§7) | Transcripts in the bench runs |
| T1 actions based on the graph | Deny/wait, caller fixes, region merge in handover and the merge queue | STALE, E5 |
| T1 explainable results | Every query response carries `path[]`; Why explorer; conflict explainer | L0, UI |
| Brief: follow connections | Same as T1 multi-hop | — |
| Brief: remember across sessions | Same as T2 memory | X1 |
| Brief: share state between agents | Same as T2 handoffs | STALE, E5, X2 |
| Brief: connect people, projects, decisions | Person → Session → Agent → Task → Decision → Version → Commit | X2 |
| Brief: show the path | `path[]` on every query response | All |

---

## 2. Architecture

```
 machine of collaborator A                                   machine of collaborator B
 ┌──────────────────────────────────────────────┐            ┌──────────────────────────┐
 │ claude sessions ─hooks/MCP─▶ loomd ─▶ FalkorDB │          │   (same stack)           │
 │        ▲                      │                │          │                          │
 │        └── briefing / notices ┘                │          │                          │
 │ loomd ⇄ git worktrees (loom run)               │          │                          │
 │ git pre-commit ─▶ .loom/ ──git push──▶ remote ──git fetch──▶ loom sync (git show) ─▶ │
 └──────────────────────────────────────────────┘            └──────────────────────────┘
```

**Git is the source of truth.** The durable state is the code, `.loom/regions.lock` and `.loom/sessions/*.jsonl`. The FalkorDB graph is a derived, queryable index of that truth. It also holds live state that only exists on one machine: leases, waits, unacknowledged notices and the sync watermark. Deleting the graph loses nothing durable, because `loom init` rebuilds it.

**Daemon.**
- Binds `127.0.0.1` only.
- Every hook **fails open**: if the daemon is down or a call takes longer than 2 s, the tool call is allowed and a one-line warning is printed. Loom must never stop someone from editing their own code.

**Packages** (existing pnpm monorepo, kept):

| Package | Does |
|---|---|
| `core` | db, schema, types |
| `indexer` | region engine, language packs, region diff and region merge |
| `daemon` | API, coordinator, memory, sync, conflict engine |
| `hook` | Claude Code hooks and git hooks |
| `mcp` | agent tools |
| `planner` | WCC/betweenness task split |
| `cli` | commands |
| `apps/dashboard` | UI |

---

## 3. Regions

A **region** is a contiguous span of a file that Loom tracks, leases and versions. Regions replace v1's "symbols".

### 3.1 Kinds

| Kind | What it covers | Lease |
|---|---|---|
| `definition` | A function, a method, a class body *without* its members (see `container`), or a top-level assignment. Decorators, plus comment lines directly above with no blank line between, belong to the definition. | write / contract |
| `container` | A class's header: from its first decorator or comment line to the start of its first member. A class with no members is one `definition`. | write |
| `imports` | A maximal contiguous run of import statements at module top level | none (union-merged, §3.10) |
| `gap` | Any bytes not covered by another region: blank lines, free comments, module-level statements | write |
| `key` | A top-level key in a JSON file, value included | write |
| `section` | A Markdown heading and its body down to the next heading of *any* level (flat; the qname is the heading path, e.g. `Install/Linux`), or a marker block | write |
| `file` | The whole file (fallback) | write |

**Nesting:**
- Regions form a flat partition of the file.
- Classes recurse: a nested class gives a container plus member definitions.
- A function's body is never split. Nested functions and lambdas belong to the enclosing definition.

### 3.2 Invariants

These are checked by `loom regions check` and by property tests.

1. **Exact cover.** A file's regions, concatenated in order, equal the file's text.
2. **No overlap**, and no empty regions.
3. **Deterministic.** The same text with the same pack version always gives the same regions.
4. **Local.** A *body-only* edit inside definition R, meaning one that adds, removes or renames no definition, changes only R's hash, plus the offsets of later regions. No region ID changes.

### 3.3 Identity

`<path>::<qualified.name>::<kind>#<n>`.
- `qualified.name` is the dotted path through classes, for example `Truncator.chars`.
- `n` tells apart duplicates of the same qualified name and kind (redefinitions), counted in source order from 0.
- Imports are named `imports#<n>`.
- A gap is named after the region before it: `gap@after:<prev-qualified-name>`, or `gap@start`. When that region is renamed, the gap is renamed with it (RENAMED_FROM).
- IDs never contain line numbers or offsets.

### 3.4 Offsets and hashes

- Internally the engine works on JS strings. web-tree-sitter reports UTF-16 code-unit indices; this was verified, and they are **not** bytes.
- `regions.lock` stores **UTF-8 byte** offsets, converted at the boundary, so the lock does not depend on the language that reads it.
- `hash` is the sha1 of the region's UTF-8 bytes.
- A file that is not valid UTF-8 is treated as binary and becomes a single `file` region.

### 3.5 Lifecycle

These rules apply on each reparse of a file, comparing the old and new region sets.

| Change | Result |
|---|---|
| Same ID, hash differs | **update**: a new Version |
| New ID | **create**: a first Version |
| ID gone | **tombstone**: a Version with `deleted: true`; the history is kept |
| An ID is gone and a new ID in the same reparse has an *identical* hash, with only the name changed (one-to-one) | **rename/move**: new Region `-[:RENAMED_FROM]->` old; history continues. Exact match only. |
| File created / deleted | creates / tombstones all of its regions |
| File renamed (git rename detection at 100% similarity) | region IDs re-pathed and recorded as RENAMED_FROM |
| Split / merge | delete + create. No guessing. |

The hash covers the bytes, and a definition's bytes include its name. So "identical hash" is checked on the body with the defining name token masked. Two candidates with the same masked hash means no rename: both are treated as delete + create.

### 3.6 Strict parsing and the shifted map

- A parse that contains any ERROR or MISSING node never produces a new map. Agents leave files half-edited all the time, so this case is common.
- **With a last clean map** (in memory or in the lock):
  - translate every region boundary through a line diff, old clean text → new text;
  - a boundary inside a deleted range moves to the deletion point;
  - this keeps all IDs and keeps exact cover, because boundaries stay monotonic;
  - regions whose lines changed are marked *touched*;
  - regions that end up empty are dropped from the map until the next clean parse;
  - the file is flagged `degraded: true`, and leases keep working by ID.
- **Without a last clean map** (a new file that has errors): one `file` region, `degraded: true`.
- **Versions are never written from a degraded map.** If a commit contains a degraded file, its touched regions get one `file`-level Version, `degraded: true`. The next clean parse resumes per-region history.
- `loom status` and the briefing list degraded files.

### 3.7 Language packs

Packs are data, not code. A pack is a tree-sitter grammar (wasm, from `tree-sitter-wasms`), plus `tags.scm` (definitions and containers), `imports.scm`, `calls.scm` and `pack.json` (`{name, version, extensions, grammar}`).

**Tiers, applied per file, first match wins:**
1. marker blocks (§3.8)
2. a language pack
3. JSON keys
4. Markdown headings (a line scanner: ATX `#` headings outside fenced code; there is no wasm grammar)
5. regions an agent defined (`define_regions`, validated against §3.2)
6. the whole-file fallback

**Always whole-file:**
- binary or non-UTF-8 files;
- files over 1 MB;
- minified files (average line length over 300);
- lockfiles (`*.lock`, `package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`);
- generated files (`linguist-generated` or a `@generated` header in the first 5 lines).

**Event scope:**
- Python: port the existing `python.ts` to the pack form.
- TypeScript, TSX and JavaScript. The grammars are verified to load under web-tree-sitter 0.22.6.
- Markdown and JSON.
- YAML, TOML and further languages are post-event. Their grammars ship, but they are whole-file for now.

### 3.8 Markers (opt-in)

```
# loom:region <name>
...
# loom:end
```

- Any line comment syntax is accepted: `#`, `//`, `--`, `<!-- -->`.
- A marker block becomes a `section` region named `<name>`, and overrides the pack inside its span.
- Markers do not nest, and a block may not cut through a definition, container or imports region (gaps may be split).
- Invalid markers (unbalanced, nested, or cutting a region) are ignored and reported as a warning in `loom status`. The pack map stays in force; the file is not degraded, because its parse is clean.
- `loom regions mark <file> <start-line> <end-line> <name>` inserts them. They are never inserted automatically.

### 3.9 Code edges

**Edge kinds:**
- `CALLS`: from `calls.scm`.
- `IMPORTS`: region → imported region, at file level.
- `TESTS`: a test definition (in `tests/`, `test_*.py`, `*_test.py`, `*.test.ts` or `*.spec.ts`) → every region it CALLS.
- `CONTAINS`: container → member.

**How a call name is resolved, first match wins:**
1. the same qualified name in the same file;
2. a name bound by an import, through `imports.scm`;
3. a unique definition with that name anywhere in the repo;
4. otherwise unresolved: no edge, but counted in `loom status`.

Every edge carries `via: same_file | import | unique_name`.

### 3.10 Region merge

`regionMerge(base, ours, theirs)` is one function in `indexer`. Handover, the merge queue and `loom conflict` all use it.

1. Parse all three sides. If any side is degraded, return `unsupported`.
2. For each region ID in the union of the three:
   - changed on one side only → take that side;
   - changed on both sides, identically → take it;
   - changed on both sides, differently:
     - `imports` → a set union of import statements: ours first, then theirs' new ones;
     - anything else → `git merge-file` on the three region texts, and a conflict if that fails;
   - deleted on one side, modified on the other → conflict (kind D);
   - added on one side → inserted after its predecessor in that side's order.
3. If the region order differs between sides in a way the predecessor rule can't place, return `unsupported`.

The result is `merged text` or a list of conflicted region IDs. It complements git's line merge rather than replacing it: it is tried only when git's merge conflicts. Git conflicts on *adjacent* edits in different functions; regionMerge resolves those exactly.

### 3.11 `.loom/regions.lock`

One JSON object per line, sorted by path:

```json
{"path":"django/utils/text.py","blob":"<git blob sha>","pack":"python@1","degraded":false,
 "regions":[{"id":"django/utils/text.py::slugify::definition#0","kind":"definition","start":1234,"end":1890,"hash":"<sha1>","sig":"slugify(value, allow_unicode=False)"}]}
```

**What it is.** A cache and a pin:
- it makes reparsing incremental;
- it holds the last clean map for degraded files;
- it records the pack version.

Correctness never depends on it. Every entry is checked against the file's current git blob, and a mismatch means reparse.

**Updated by:**
- the git **pre-commit** hook: entries for the staged files, computed from the **index** blob rather than the worktree, so partial staging is right;
- `loom init` and `loom sync`: entries for changed files.

Edits between commits live only in memory and in the graph.

**Merges.**
- `.loom/.gitattributes` contains `regions.lock merge=union` and `sessions/*.jsonl merge=union`.
- `union` is built into git, so it needs no setup on a collaborator's machine.
- After a union merge, the lock can hold two entries for one path. The loader keeps the entry whose blob matches the file and drops the rest. If neither matches, the file is reparsed.
- The next pre-commit rewrites the lock sorted, with one entry per path.
- *Verified:* nested `.gitattributes` with `merge=union` merges a conflicting lock without markers.
- There is no custom merge driver.

**Pack upgrades.** If a lock entry's pack version differs from the installed pack:
- that file keeps the IDs from its lock entry;
- `loom reindex` must be run explicitly, and reports every ID change as a rename or as delete + create.

Nothing changes silently.

---

## 4. The graph

### 4.1 Name

`loom:<tenant>:<repoId>`.

- `repoId`: the sha of the repo's root commit, computed **once** by `loom init` and stored in `.loom/config.json`. Shallow clones don't have the real root. If there are several roots, the lexicographically smallest is used. `loom init` refuses to run in a repo with no commits.
- `tenant`: from `~/.loom/config.json` (`{"tenant":"abhinav"}`), defaulting to `$USER`.
- The daemon resolves the graph from the session's registration. API calls never name a graph. That is what makes I1 hold.

Runs are no longer separate graphs. A Run is a node.

### 4.2 Nodes

| Label | Key properties |
|---|---|
| `Person` | id (git email), name |
| `Session` | id (ulid), person, started, ended, kind (`run` / `interactive`), base commit, upstream ref |
| `Run` | id, session, plan, integration branch |
| `Agent` | id `<session>/<name>`, model, worktree |
| `Task` | id, title, status (`open` / `claimed` / `done` / `abandoned`), claimed_by |
| `Region` | id, path, kind, qname, current start/end/hash/sig, degraded, tombstoned |
| `Version` | id (event id), region, ord, hash, sig, deleted, degraded, commit, at, external |
| `Change` | id, region, agent, at, sig_changed. One per edit, live only, never exported (Versions are per commit) |
| `Commit` | sha, author, at, message |
| `Decision` | id, text, at |
| `Evidence` | id, test, result, at |
| `Lesson` | id, text, source (`mined` / `manual`), at |
| `Message` | id, kind (`notice` / `wake` / `ask` / `ack` / `human` / `briefing` / `handoff` / `summary`), text, at |
| `Thread` | id, topic |
| `Handoff` | id, summary, open leases, unfinished tasks |
| `Watermark` | person, commit, at (local only, never exported) |

### 4.3 Versions form a DAG, not a chain

Git branches diverge, so a region can have two different "third versions".

- A Version's id is its event id: a ulid, or `ext:<commit>:<region>` for external versions.
- `PREV` points at the version or versions it was derived from. A merge commit gives two PREVs.
- `ord` = max(prev.ord) + 1. It is a display number only.
- **"Current" is per ref, not global.** The current version of R on ref X is the newest Version of R whose commit is an ancestor of X. When X's region text matches no Version yet (uncommitted work), current is `null`.
- `Region.HEAD` is the current version on the local `HEAD`, refreshed by `loom sync` and by the post-commit and post-checkout hooks.

### 4.4 Edges

- `(Person)-[:STARTED]->(Session)-[:RAN]->(Agent)`, `(Session)-[:HAS_RUN]->(Run)`
- `(Agent)-[:WORKED_ON]->(Task)`, `(Task)-[:SCOPE]->(Region)`
  - `SCOPE` comes from the planner, or from the regions edited while the task was claimed.
- `(Region)-[:HEAD]->(Version)`, `(Version)-[:PREV]->(Version)`, `(Version)-[:OF]->(Region)`
- `(Version)-[:BY]->(Agent|Person)`, `(Version)-[:FOR]->(Task)`, `(Version)-[:IN]->(Commit)`
- `(Decision)-[:ABOUT]->(Region)`, `(Decision)-[:LED_TO]->(Version)`, `(Decision)-[:BY]->(Agent|Person)`
- `(Evidence)-[:VERIFIES]->(Version)`
- `(Lesson)-[:ON]->(Region)`
- `(Message)-[:IN_THREAD]->(Thread)`, `(Message)-[:FROM|TO]->(Agent|Person)`, `(Message)-[:ABOUT]->(Region|Task|Decision|Version)`
- `(Handoff)-[:FROM]->(Session)`, `(Handoff)-[:LEAVES]->(Task)`
- `(Region)-[:CALLS|IMPORTS|TESTS|CONTAINS {via}]->(Region)`, `(Region)-[:RENAMED_FROM]->(Region)`
- **Live:**
  - `(Agent)-[:LEASED {mode, contract, task, expires}]->(Region)`: v1's lease edge, re-targeted from Symbol to Region;
  - `(Agent)-[:WAITS_ON]->(Agent)`.

### 4.5 Leases (live)

- The lease is v1's atomic compare-and-set query (`lease.ts`), kept unchanged except for its target. The modes are kept too: `write` conflicts with `write`, and `contract` conflicts with both `write` and `contract`.
- **TTL:** 10 minutes. Every hook call from the holder renews it, and SessionEnd releases it.
- **Expiry:** an expired lease frees the region, and a notice goes to anyone who was waiting on it.
- **Scope:** leases live in the repo graph, so **every session on the same machine** coordinates live. That includes two interactive terminals, not only agents spawned by `loom run`.

### 4.6 External changes

`loom sync` reconciles commits with no `.loom` record. For each region a commit changed without a matching `version` event in that commit, it creates `Version {external: true}` `-[:BY]->(Person from the git author)`. `git commit --no-verify`, which skips Loom's hook, is handled the same way.

Memory never silently misses human edits or edits made outside Loom.

---

## 5. `.loom/` in the repo

```
.loom/
  .gitattributes                       # union merge for the lock and the session files
  config.json                          # repoId, dirs to index, excludes, test command, share
  regions.lock                         # §3.11
  sessions/<session-ulid>.<writer>.jsonl
```

**Writers:**
- `<writer>` is `main` for an interactive session, the agent's name for a `loom run` agent, and `coord` for the coordinator.
- **Each file has exactly one writer in exactly one worktree.** Parallel agents never append to the same file, so their branches merge without touching each other's records.
- If one session commits on two branches, the files are still merged by `union`, and import is idempotent.

**Opting out.** `config.json` `"share": false` keeps `sessions/` out of git (Loom writes it to `.git/info/exclude`). Memory stays local and the lock is still shared.

### 5.1 Session record events

One JSON object per line. Every line has `{"v":1,"type":...,"id":<ulid>,"at":...}`.

| Type | Fields |
|---|---|
| `session` | person, kind, base, upstream |
| `agent` | name, model |
| `task` | title, status, by, scope[] |
| `version` | region, hash, sig, deleted, degraded, prev[], by, task, renamed_from |
| `decision` | text, regions[], by, led_to[] |
| `evidence` | test, result, versions[] |
| `lesson` | text, regions[], source |
| `message` | kind, text, from, to, about[], thread |
| `handoff` | summary, open_tasks[], open_leases[] |

**Commit association.**
- `version` lines are written by the pre-commit hook and staged in the same commit. The commit sha doesn't exist yet at that point.
- On import, each line's commit comes from `git blame --line-porcelain` on the session file. This is one call per file, cached by blob.
- It survives rebase and squash, because blame reports the rewritten commit.
- Lines that aren't committed yet have `commit: null`.

### 5.2 Import

- Import is idempotent: `MERGE` on the event id.
- `(:Imported {file, blob})` records what has been read, so unchanged files are skipped.
- Import can read from the working tree, or from any ref through `git show <ref>:.loom/sessions/<f>`. That is how `sync` and `conflict` read the other side's records without checking it out.

---

## 6. Flows

### 6.1 `loom init`

Run once per clone; safe to repeat.

1. Refuse to run if the repo has no commits. Ensure the daemon and FalkorDB are running (`loom up`).
2. Create `.loom/config.json` if it is missing: repoId (§4.1), default excludes (`node_modules`, `.venv`, `dist`, `build`, `.git`), and the test command, detected from `pyproject.toml`/`package.json` or set by flag.
3. If `regions.lock` exists, check each entry's blob and reparse only the mismatches. Otherwise index everything and write the lock.
4. Create the **baseline**: one Version per region with `external: true`, commit = HEAD. History before init is not reconstructed.
5. Install the Claude Code hooks (project `.claude/settings.json`: SessionStart, PreToolUse, PostToolUse, SessionEnd) and the MCP server entry.
6. Install the git hooks: pre-commit, post-commit, post-merge, post-checkout, post-rewrite.
   - An existing hook is renamed `<name>.pre-loom` and called first.
   - When `core.hooksPath` is set (husky and similar), Loom adds its lines to the hooks in that directory instead.
7. Import every `.loom/sessions/*` file (§5.2), then reconcile from the baseline.
8. Print a summary: files, regions, degraded files, unresolved calls, sessions, people.

### 6.2 Interactive session

One person, one Claude Code session, without `loom run`.

1. **SessionStart hook:**
   - create the Session and Agent and write their events;
   - run `loom sync --quiet` (§6.3);
   - inject the briefing (§6.4) as `additionalContext`.
2. **PreToolUse on Edit, MultiEdit, Write or NotebookEdit:**
   1. Predict the file after the edit. This is v1's `predict.ts`, which applies `old_string`/`new_string` or the `Write` content.
   2. Find the *touched* regions by diffing the regions before and after. A new file has no lease conflicts.
   3. **Version check (§6.5)**: deny if a touched region is stale against the session's upstream.
   4. Take the leases on the touched regions. Deny if another live agent holds one.
   5. Inject the lessons on the touched regions.
3. **PostToolUse:**
   - reparse the file;
   - record a `Change`;
   - send notices to other live agents whose task SCOPE or leases reach the changed regions within 3 hops;
   - renew the leases.
4. **Writes the hooks can't see** (Bash, scripts, an editor): at each hook call, worktree blobs are diffed against the last ones seen. Changed regions are reported as `unleased_write` notices and reparsed.
5. **git commit:**
   - **pre-commit:** for each staged file, parse the **index** version, write `version` events for the regions that changed since HEAD, rewrite their lock entries, and stage the session file and the lock;
   - **post-commit:** create the graph `Commit`, link the Versions to it, and move `Region.HEAD`.
6. **SessionEnd hook** (= `loom finish`):
   - write the `handoff` event: open tasks, open leases, and a summary taken from the last assistant message in `transcript_path`;
   - release the leases;
   - if the session file has events that aren't committed, print a reminder to commit it. `loom finish --commit` makes a `loom: session <id> records` commit, and only touches `.loom/`.

### 6.3 `loom sync`

Runs at session start, from the post-merge, post-checkout and post-rewrite hooks, or by hand.

1. **Fetch.** A best-effort `git fetch` of the upstream: 5 s timeout, with a warning if it fails.
   - The upstream is `@{upstream}`, or else `origin/<default branch>`.
   - Sessions that are offline still sync locally.
2. **Import** new or changed session files from the working tree **and** from the upstream ref (`git show`). B therefore learns of A's pushed work before pulling.
3. **Reparse** files changed between the last synced commit and HEAD, and between HEAD and upstream, using blobs from `git show`.
4. **Reconcile** external versions (§4.6) for commits in `watermark..HEAD` and `HEAD..upstream`.
   - Capped at 200 commits per ref.
   - Past the cap, each region gets one external Version spanning the range, attributed to "N authors".
5. **News:**
   - select Versions, Decisions, Tasks, Handoffs and Lessons from *other* people or sessions, newer than this person's local watermark;
   - score each one: 3 if its region is in the SCOPE of one of my open tasks, 2 if it is within 2 CALLS/IMPORTS hops of one, 1 if it is in a file I touched in my last 3 sessions;
   - break ties by recency, and keep the top 10;
   - after a fresh init, the news is the latest handoff from each other person, nothing more.
6. Store a `Message {kind: briefing}`, print it, and move the watermark.

### 6.4 Briefing format

A deterministic template, at most 25 lines:

```
[loom] Since your last sync (abc123 → def456; upstream origin/main +3), 2 people, 3 sessions:
- slugify (django/utils/text.py) changed on origin/main by B/S7/agent-a for T4 "strict mode" — not in your branch yet.
  Decision D12: "strict is keyword-only because callers pass positionally". Callers in your tasks: title_slug.
- T9 "unicode filenames" left unfinished by B (handoff H3): Truncator.chars half-done.
- Lesson L2 on slugify: "run test_text.py::SlugifyTests after changing slugify".
- Degraded: none.
Ask: history(region) · why(region) · changes_since(commit)
```

### 6.5 Version check

This is one rule for both live and async work.

**Definitions:**
- Each session has an **upstream ref**:
  - an interactive session: `@{upstream}`, or `origin/<default>`;
  - a `loom run` agent: the run's integration branch (`loom/<run>/landed`).
- Region R is **stale** for a session when R has a Version on the upstream whose commit is **not** an ancestor of the session's HEAD (`git merge-base --is-ancestor`), and that Version is by someone else.

**What happens on a stale edit:**
- **Run agent:** the coordinator first syncs the agent's worktree (handover, §6.6 step 4). Then it denies once with "R changed (by, task, decision); your file now contains it, re-read R". The retry passes.
- **Interactive session:** deny with the newer version's summary and its decision. The agent or person can pull, or call `ack_notice` on that stale notice, and then the retry passes until a *newer* version appears. This is intentional: divergence must stay possible.

### 6.6 `loom run`: one coordinator, many agents, live

This is v1's run with the RC fixes from `docs/findings`.

1. **Plan.** The planner splits the work with WCC clusters into tasks and orders it by betweenness. Tasks and their SCOPE are written to the graph and to `<session>.coord.jsonl`.
2. **Worktrees.** One worktree and one headless `claude -p` per agent. All agents share the coordinator's Session (`kind: run`) and have the integration branch `loom/<run>/landed` as their upstream.
3. **Live:** leases, version checks, notices.
4. **Code handover (fixes RC1, RC2 and RC3).** When a holder lands on the integration branch:
   1. Every agent waiting on it, and every agent whose leases or SCOPE touch the landed regions, is queued for a sync.
   2. The sync runs `git merge --autostash loom/<run>/landed` in the agent's worktree.
      - *Verified:* this succeeds when the dirty edits are in the same file but in other lines.
      - A plain `git merge` refuses here (RC2).
   3. If git conflicts, `regionMerge` (§3.10) is tried on each conflicted file. When it resolves the file, the result is written and the stash re-applied.
   4. If there are still conflicts, the worktree is left with markers. The stash is kept (git's behaviour, verified), and the wake says "conflict in R; resolve" with the conflict brief (§6.8).
   5. Wake text is built **when it is delivered**, from current graph state. It is never cached.
5. **Merge queue:**
   - when an agent says it is done, the coordinator merges the integration branch into its worktree (step 4), runs the covering tests (TESTS edges of the changed regions, or else the configured test command), commits, and fast-forwards the integration branch;
   - on a conflict or a failing test, the agent is resumed with the brief;
   - landings are serialized, so the final merge order is the landing order.
6. **Denial back-off (RC5):**
   - each denial carries the holder, the holder's task and the expected wait (the holder's lease age compared with its task's median);
   - a third denial for the same agent and region within 60 s returns the instruction "stop editing R; you will be woken" instead of another denial;
   - further edit attempts on R are refused without notice text until the wake.
7. **No self-wakes (RC6):** wakes and notices are filtered on `holder ≠ recipient`, and a test checks it.
8. **`tests/` indexed (RC4):** test files are regions too, with TESTS edges. Agents lease test code like any other code.
9. **Grading (E5):** an agent's `agents_ok` is judged only on the full final merge. If that merge stops at a conflict, every agent in the run is marked failed.

### 6.7 Async collaborators

```
A: interactive / loom run → commits (+ .loom records) → push
B: session start → loom sync fetches origin, imports A's records via git show → briefing names A's change and decision
B edits a region A changed upstream → version check denies with A's decision → B pulls (or acks and diverges)
B pulls → post-merge → sync → Region.HEAD moves; A's versions are now ancestors, no more denial
```

**Task claims across collaborators** are async and best-effort:
- `claim_task` writes a `task` event;
- B sees it once A has pushed;
- the briefing flags it when B claims a task whose SCOPE overlaps.

The pitch never claims more than this.

### 6.8 `loom conflict`: merge conflict explainer

Runs inside a merge (`MERGE_HEAD` exists), or as `loom conflict <ours> <theirs>`. Rebase is supported through the explicit form only, because during a rebase "ours" and "theirs" swap.

1. `base = git merge-base ours theirs`. Import theirs' session files with `git show`, so both sides' history is in the graph.
2. Compute region maps for the base, ours and theirs blobs of every file either side changed. These come from `git show`, never from the worktree, which may contain conflict markers.
3. Classify every region that changed on at least one side:
   - **A**, textual: changed on both sides, and `regionMerge` reports a conflict for it;
   - **B**, both modified but merged: changed on both sides, and `regionMerge` merged it. It is listed as risky;
   - **C**, semantic: one side changed R's **contract**, while the other side added or changed a region that CALLS R. The contract is the signature text: parameters, defaults and the return annotation. This is v1's `mergecheck` prediction;
   - **D**, delete vs modify.
4. For each, attach both sides' version paths since base (person, session, agent, task, decision, evidence), the affected callers (impact) and the covering tests (TESTS).
5. **Output:**
   - a CLI table;
   - `--json`: the conflict brief used by agents, the merge queue and the dashboard;
   - `--verify`: build the merged tree in a temporary worktree (from regionMerge, or from the in-progress merge result), run the covering tests, and turn a C prediction into confirmed or refuted.

### 6.9 `loom diff <a>..<b>` and `loom log`

The same engine as §6.8, without classification. It returns the regions changed between two commits, grouped by commit → person → session → agent, with their decisions and evidence. `loom log` is the per-commit summary list. Both feed the dashboard Timeline and Commit views.

### 6.10 Lessons (procedural)

**Mined lessons:**
- a notice the agent ignored that ended in a failing test (v1);
- a version check that denied an edit, when the agent then landed a passing edit after re-reading;
- a C-kind conflict that `--verify` confirmed.

**Manual:** `loom lesson add <region> <text>`.

**Scope:**
- Lessons live in the repo graph and in `.loom/`, so a lesson never leaves its repo or tenant. This fixes C1.
- They are injected at PreToolUse on matching regions and in the briefing.

---

## 7. MCP tools (19)

Every query response is JSON and includes a `path[]` of `{node, edge}` steps that justifies it. Write tools return the nodes they created.

| Tool | Status | Purpose |
|---|---|---|
| `register` | existing | identify the agent |
| `lease` / `release` | existing, now on regions | lease regions |
| `notices` / `ack_notice` | existing | read and acknowledge notices (stale-version acks too) |
| `who_is_touching` | existing | live holders and editors |
| `impact` | existing, extended to IMPORTS/TESTS | callers and tests within 3 hops |
| `why` | existing, now returns the path | why a region looks the way it does |
| `record_decision` | existing | write a Decision |
| `lessons` | existing, repo-scoped | lessons for a region |
| `claim_task` / `claim_done` | existing | claim and finish tasks (done carries a summary) |
| `history` | **new** | a region's version DAG with people, agents, tasks and decisions |
| `changes_since` | **new** | the news for a commit or a time (§6.3 step 5) |
| `conflict` | **new** | the conflict brief (§6.8) |
| `hotspots` | **new** | `algo.betweenness` on CALLS within a scope |
| `clusters` | **new** | `algo.WCC` on CALLS within a scope |
| `path` | **new** | `shortestPath` between two regions or entities. *Verified* on the FalkorDB in use, directed and undirected |
| `define_regions` | **new** | an agent proposes regions for a file with no pack; validated against §3.2 |

---

## 8. CLI

Every command supports `--json`.

| Command | Status |
|---|---|
| `loom init [--tenant t] [--test-cmd c]` | upgraded (§6.1) |
| `loom up / down / status` | existing; status adds degraded files, unresolved calls, the watermark and the upstream |
| `loom sync [--quiet] [--no-fetch]` | **new** (§6.3) |
| `loom brief` | **new**: print the current briefing |
| `loom finish [--commit]` | **new** (§6.2 step 6) |
| `loom run --plan <file> [--blind]` | upgraded (§6.6) |
| `loom conflict [ours theirs] [--verify]` | **new** (§6.8) |
| `loom diff <a>..<b>` / `loom log [-n]` | **new** (§6.9) |
| `loom history <region>` | **new** |
| `loom why <region\|decision\|version>` | existing, now path-based |
| `loom regions [file] \| check \| mark … \| reindex` | **new** (§3) |
| `loom tasks [list\|claim\|done\|abandon]` | **new** |
| `loom lesson add\|list` | existing, repo-scoped |
| `loom hook git <name>` / `loom hook claude <event>` | **new**: internal hook entries |
| `loom merge-check`, `loom replay`, `loom verify`, `loom plan` | existing |
| `loom ui` | existing |
| `loom demo` | **new**: replays the bundled recordings; no API key needed |

---

## 9. Dashboard

Built after the tool works. A light Claude theme (cream/orange), with dark mode. Every view reads the same JSON as the CLI.

| View | Shows |
|---|---|
| **Repo timeline** | commits as rows; lanes per person → session → agent; click through to the commit graph diff |
| **Commit / diff** | the regions a commit or range changed, as a subgraph (region ← version ← agent ← person, plus decision and evidence) |
| **Conflict** | the §6.8 classification; both sides' paths side by side; affected callers highlighted |
| **Region history** | the version DAG for one region, with diffs, the why path and lessons |
| **Why explorer** | the `path[]` of any answer, drawn as a graph; every node can be queried |
| **Live run** | v1 Live/Timeline: leases, waits, wakes, the merge queue |
| **People & agents** | collaborators → their sessions → agents → work done |
| **Bench** | STALE / E5 / X1 / X2 / S1 / I1 results, with the raw records linked |

Every number has an ⓘ explainer. The Ask bot (`/ask` through the local Claude Code CLI) is first on the cut list.

---

## 10. Proof plan

**How agent runs are made:**
- every agent run uses the Claude Code CLI on the subscription, with model Sonnet and all `ANTHROPIC_*` environment variables stripped;
- the extended/full STALE sets never run without explicit approval.

**Gates and targets are kept apart:**
- **Merge gates** are deterministic and cost nothing (L−1, L0, S1, I1). A phase merges only when its gates are green.
- **Agent benchmarks** are reported targets. They are run and reported whatever the result, and they never block a merge.

| ID | Kind | What | Bar | Cost |
|---|---|---|---|---|
| L−1 | gate | Region engine on the Django corpus (882 files), TS fixtures and non-ASCII fixtures. Property tests of §3.2 (exact cover, determinism, locality under random body edits), the shifted map under random syntax-breaking edits, golden fixtures for each kind, and regionMerge against git on adjacent-edit cases | 100% invariants; 0 maps from an ERROR parse | $0 |
| L0 | gate | Scripted fake agents for each mechanism: lease and TTL, version check (live and upstream), handover with a dirty worktree, merge queue, back-off, no self-wake, sync/import idempotence, union-merged lock and sessions, conflict classes A–D, lesson scoping, fail-open hooks | all green | $0 |
| S1 | gate | 32 simulated agents × 200 lease ops on one graph, no LLM | 0 double grants; report p50/p99 | $0 |
| I1 | gate | 2 tenants on the same repo, plus the C1 lesson-leak case | 0 cross-reads | $0 |
| STALE core | target | 12 pairs × blind / oracle / live | live ≥ 11/12 merged-pass, blind 0/12 | ~$2.5 |
| E5 team | target | s1/s2/s3: 4 agents on the same function, with the grader fixed (§6.6 step 9) | loom 3/3 all_pass vs blind | ~$4 |
| X1 cross-session | target | 4 pairs: session 1 lands a contract change plus a decision; a fresh session 2 works on a caller. With the repo graph vs an empty graph | right with the graph, and `why` cites the decision | ~$2 |
| X2 async collaborators | target | 2 clones, 3 scenarios: B is warned of A's pushed work before pulling (stale-edit deny); B starts an overlapping task (briefing); a real merge conflict (the explainer classifies A–D, and `--verify` confirms the C conflict). With `.loom/` vs without | explainer right on every scenario; better agent outcome with `.loom/` | ~$2 |

Every reported number links to its `records.jsonl`. Failures are reported, not hidden.

### 10.1 Proof ledger and the thesis gate

- `docs/proofs/LEDGER.md` lists every claim this spec makes that is not yet backed by a test or a measured result. Each row has the claim, the spec section, the test or experiment that settles it, the owning phase, and a status: `unproven`, `proven` (with the command and its output file), or `refuted` (with the evidence and what changed in the spec).
- **Thesis gate (P1.5), right after P1:** every claim that can be settled with the region engine alone is tested on real data (the Django corpus and its git history) before P2 starts. Those are T1–T5 in the P1.5 plan.
- **Every later phase** must move each of its ledger rows to `proven` or `refuted` before it merges.
- At submission no row may be `unproven`. A refuted claim is reported and the spec and pitch are corrected. Results are never tuned to pass.

---

## 11. Repository and delivery

- **Remote:** `github.com/18Abhinav07/Loom` (private until Abhinav's go-ahead).
- **Branches:**
  - `main` only receives merges;
  - `docs/<topic>`, `feat/p<N>-<topic>`, `fix/<topic>`, `bench/<id>`;
  - one PR per branch, merged with a merge commit so history is kept. Abhinav merges.
- **Commits:** conventional, small, test first where the code allows it, and pushed as the work happens.
- **Phases:** each phase is one or more PRs, and it merges when its **gates** are green.

| Phase | Day | Content | Gate |
|---|---|---|---|
| P0 | Thu 15 | Repo, README, this spec, findings, implementation plans | docs merged |
| P1 | Thu 15–Fri 16 | Region engine: kinds, IDs, offsets, lifecycle, strict parse and shifted map, packs (Python, TS/JS, MD, JSON), markers, code edges, regionMerge, lock | L−1 |
| P1.5 | Fri 16 | Thesis gate (§10.1): T1–T5 on the Django corpus and history; proof ledger created | every P1-owned ledger row proven or refuted |
| P2 | Fri 16 | Repo graph (§4); `.loom/` sessions, export/import; git hooks; sync with upstream read, reconcile, briefing; tenant naming; repo-scoped lessons | L0 memory/sync parts; I1 |
| P3 | Fri 16–Sat 17 | Live: region leases, version check, handover, merge queue, RC1–RC6, E5 grader | L0 coordination parts; S1 · then run STALE core and E5 |
| P4 | Sat 17 | Conflict/diff engine, new MCP tools, path-based `why` | L0 conflict parts · then run X1 and X2 |
| P5 | Sat 17–Sun 18 | Dashboard views, `loom demo`, README, demo video, submission (target 20:00 Sun) | review |

- **Cut order if late:** Ask bot → `define_regions` → TS pack (Python only) → regionMerge in handover (fall back to the git conflict plus the brief) → Region-history view.
- **Never cut:** L−1, L0, S1, I1, the P1.5 thesis gate, the proof ledger, and running STALE, E5, X1 and X2.

---

## 12. Out of scope

- Real-time cross-machine coordination (needs a shared hosted FalkorDB).
- Distributed concurrency.
- Auth and multi-user servers.
- Packs beyond Python/TS/JS/MD/JSON.
- Storing full agent transcripts.
- Reconstructing history from before `loom init`.
- Track 03 (Company Brain).

---

## 13. Decisions (resolved 2026-10-15)

1. Remote `github.com/18Abhinav07/Loom`, private. It goes public only on Abhinav's go-ahead.
2. The prior prototype code is committed as regular work. The organisers confirmed this is allowed.
3. Spec approved by Abhinav, then refined by the review in §14.

---

## 14. Review log (2026-10-15)

Each line gives the defect found in the first draft, how it was checked, and the fix.

| # | Defect | Check | Fix |
|---|---|---|---|
| R1 | The lock stored "byte" offsets, but web-tree-sitter reports UTF-16 indices | Probe: in `s = "é"\n…`, the next node starts at 8, where its byte offset is 9 | §3.4: UTF-8 bytes in the lock, converted at the boundary |
| R2 | A version chain `<region>@<n>` breaks on git branches: two different "v3"s | Reasoning against the git DAG | §4.3: Version DAG, ulid ids, current per ref |
| R3 | Parallel agents appending to one session file conflict when their branches merge | Same-file appends in two branches conflict in git | §5: one file per writer |
| R4 | A custom lock merge driver can't see the merged code, and is missing on machines without Loom | Git runs drivers per file; driver config is local | §3.11: built-in `union` + blob-checked loader. *Verified* with nested `.gitattributes`. Driver removed |
| R5 | "Keep the last clean map" left offsets wrong once a file was edited | Offsets shift on any edit | §3.6: shifted map through a line diff; no Versions from degraded maps |
| R6 | A container's "header outside its members" wasn't contiguous, which broke exact cover | Invariant 1 | §3.1: container = header up to the first member; the rest are definitions and gaps |
| R7 | The version check needed "the version the agent last read", which nothing tracked | No hook records reads | §6.5: staleness against an upstream ref through git ancestry; no read tracking |
| R8 | B only saw A's work after pulling, so the "stale edit" scenario couldn't happen in X2 | After a pull the working tree already holds A's work | §6.3: fetch + `git show` import of upstream records before pulling |
| R9 | `repoId` from the root commit differs on shallow clones | `rev-list --max-parents=0` returns the shallow boundary | §4.1: computed once and stored in `.loom/config.json` |
| R10 | Reconciling all history on init (Django has ~30k commits) is unbounded | Cost | §6.1 step 4: baseline at init; §6.3: 200-commit cap |
| R11 | Spec Lease node vs v1 lease edge; TTL unstated | Read `lease.ts`: `LEASED` edge, `write`/`contract`, 10-min TTL with renew | §4.4–4.5 follow v1 |
| R12 | "Splice fallback" was undefined and only handled one case | Verified: autostash handles same-file non-overlapping edits; git still conflicts on adjacent lines | §3.10: one `regionMerge`, shared by handover, the merge queue and conflict |
| R13 | RC2 fix unverified | Verified: plain `merge` refuses a dirty worktree, `merge --autostash` succeeds; when lines overlap, the stash is kept with markers | §6.6 step 4 |
| R14 | Contract "raised errors / return type" can't be reliably extracted | No extractor exists | §6.8: contract = signature text; behaviour checked by `--verify` |
| R15 | News ranking used "regions in my open tasks", but Tasks had no regions | Missing edge | §4.4: `Task-[:SCOPE]->Region` |
| R16 | Pre-commit used worktree text, which is wrong with partial staging | `git add -p` | §3.11 / §6.2: parse the index blob |
| R17 | Hooks could block all editing when the daemon is down | No failure policy | §2: fail-open with a 2 s timeout |
| R18 | Benchmarks with model variance were merge gates, so one bad run could block a phase | §11 table | §10: deterministic gates vs reported targets |
| R19 | `shortestPath`, TS/JSON grammars unverified | Probes on the running FalkorDB and on web-tree-sitter 0.22.6 | Verified; no Markdown wasm, so §3.7 uses a line scanner |
| R20 | YAML/TOML promised in tier 3, but out of event scope | Inconsistency | §3.7: JSON only for the event |
| R21 | Call resolution unspecified | Python is dynamic | §3.9: ordered resolution rule with `via` on each edge |
| R22 | Session records are committed without consent | Privacy | §5: `share: false` |
| R23 | Markdown sections "to the next heading of the same or higher level" nest, which breaks the flat partition | Invariant 2 | §3.1: flat sections with heading-path names |
| R24 | "Markers must nest" also breaks the flat partition, and degrading a cleanly parsed file throws away a valid map | Invariant 2 | §3.8: markers don't nest; invalid markers are ignored with a warning |
| R25 | Unproven claims had no tracked owner | Abhinav's review | §10.1: proof ledger and the P1.5 thesis gate |
