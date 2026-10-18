# Loom

A shared, live world model for parallel Claude Code agents, kept in one FalkorDB graph.

Run several coding agents on one repo at once. Their patches pass alone, merge cleanly, and break together: agent A
changes `slugify`'s contract while agent B writes a new caller against the old one. Loom puts the code's call graph,
every agent's in-flight edits, function-level leases, decisions and test evidence in one graph, and on every edit
runs a traversal that tells exactly the affected agent, mid-work, what changed under it.

## Quickstart

```bash
git clone https://github.com/18Abhinav07/Loom.git && cd Loom
./scripts/install.sh        # needs Node 22+, Docker (for FalkorDB), and the `claude` CLI logged in
```

This puts a `loom` command on your PATH.

**One command:** after cloning, `./scripts/demo.sh` checks your machine, installs Loom, asks what to run, opens the dashboard and starts it.
`./scripts/demo.sh live|12|36|108` skips the menu. `MODEL=haiku|sonnet` picks the model (Haiku default), `YES=1` skips the cost prompt.
Every option runs real Claude agents on your own Claude plan; nothing is simulated.

| Option | What it runs | Agent runs | Time / cost (Haiku) | Output |
|---|---|---|---|---|
| **live** | The Django demo: 4 agents without Loom, then the same 4 with Loom. You press **Plan** in the dashboard and watch locks, notices and messages. | 8 | ~10 min, a few cents | Home + Team tabs |
| **12** | Core benchmark: 12 pairs, each run blind (no Loom) and with Loom. | 24 | ~5 min, ~$0.15 | `bench/results/e1.json` |
| **36** | All 36 real-derived pairs, blind and with Loom. | 72 | ~12 min, ~$0.35 | same |
| **108** | The full study: 36 pairs x 3 conditions (blind, oracle, Loom live). **108 runs, not 108 tasks.** | 108 | ~20 min, ~$0.60 | same, plus notice precision (E3) |

A *pair* is two agents editing the same Django code at once: A (a scripted AST rewrite) makes a breaking change to a helper, B (a real
Haiku agent) writes code that calls it. Grading is offline: B's patch alone, then merged with A's. **Blind** = B gets no information,
**oracle** = B is told the exact change up front (the ceiling), **live** = Loom's hooks deliver the notice mid-work.

**1. Run the StaleBench demo on Django (the hackathon demo)**

```bash
git clone https://github.com/django/django && cd django
loom init                   # indexes Django, installs hooks + MCP, starts FalkorDB + the daemon, opens the dashboard
```

`loom init` drops the Django StaleBench plan in `.loom/plans/`. In the dashboard press **Plan**: the Lead proposes the four
Django tasks, then starts them twice, four Haiku agents **without** Loom (Home) and four **with** Loom (Team), on your own Claude plan.
Home shows each side's agents and whether the merged tests pass; Team shows the locks, notices and messages between agents.

**2. Run the StaleBench benchmark yourself**

```bash
loom stalebench --check                 # verifies git, Python 3.12+, Docker, claude; spends nothing
loom stalebench --pairs 12              # core set: 12 pairs x (blind, Loom) = 24 agent runs
loom stalebench --pairs 36              # all 36 real-derived pairs = 72 runs
loom stalebench --pairs 36 --oracle     # 36 pairs x 3 conditions = 108 runs
```

One pair is two agents editing the same Django code at once, one changing a helper the other calls. The 36 pairs are STALE-bench's
real-derived tier (12 helper functions x 3 kinds of change); **108 is 36 pairs x 3 conditions, not 108 tasks**. The command clones the
STALE-bench data and Django mirror for you, asks before spending tokens (Haiku by default, `--model sonnet` to change), then writes
`bench/results/e1.json`, which the dashboard's Benchmark tab shows. Shipped results are the full 108-run set (below).

**3. Use it on your own project (beta, may break)**

```bash
cd /path/to/your/git/repo
loom init                   # indexes the repo, installs the hooks + MCP, starts the daemon, opens the dashboard, starts the Lead
```

`loom init` leaves you in the **Lead**: a Claude session that talks with you, splits the work into tasks, and starts one agent per task.
The dashboard for this repo is `http://127.0.0.1:4317/?cwd=<repo>` (run `loom ui` any time to reopen it). Then:

| | |
|---|---|
| `loom lead` | start the Lead again |
| `loom ui` | open this repo's dashboard |
| `loom up` / `loom down` | start / stop the daemon (`init` already starts it) |
| `loom team start --plan <file>` | start a team from a plan file (or approve one in the dashboard's Plans tab) |
| `loom status` | what is running here |

Or skip the Lead: run plain `claude` in the repo (and in its worktrees); the hooks coordinate them.

## What it does

| | |
|---|---|
| **Leases** | `lease(symbols, write\|contract)` is an atomic Cypher compare-and-set; FalkorDB's per-graph write serialization makes it race-free (E2). |
| **Notices** | Each edit re-indexes the file, diffs symbols against base, and walks `CALLS` 1–3 hops plus stale-read edges. A contract change becomes a short notice injected into the next hook of each agent whose in-flight code depends on it. |
| **Gates** | PreToolUse denies an edit on a symbol someone else holds; Stop blocks an agent that never acknowledged a notice, or whose claim is stale or has a blind spot. |
| **Claims** | `claim_done` maps the changed symbols to the tests that call them, runs them, mutates each symbol five ways and scores how many mutants the tests kill. A symbol no mutant-killing test covers is a named blind spot. |
| **Why** | `loom why <symbol>` walks decision → task → agent → change → commit. Every deny, notice and verdict carries its graph path. |
| **Lessons** | A notice the agent ignored that ended in a failing test becomes a lesson, injected into later runs that touch the same code. |
| **Merge-check** | `loom merge-check a b` forks the run graph, predicts which callers break, merges both branches and runs the tests to score the prediction. |
| **Replay** | Every API call is recorded; `loom replay <dir>` re-sends a recording into a fresh graph through the same handlers. No agents, no API key. |

## Try it (no API key)

```bash
git clone <this repo> loom && cd loom
docker compose up -d --build
docker compose exec daemon node packages/cli/dist/loom.cjs replay demo/run-1
```

Open http://127.0.0.1:4317. `demo/run-1` is three Claude Code agents on Django: **a** makes `slugify` take a required
keyword-only `strict`, **b** writes `title_slug` calling `slugify(title)`, **c** adds `max_length` to `slugify`.
Watch c get denied the lease a holds, b get told mid-work that `slugify` changed under its new caller, and b adapt
before it finishes. Views: Live graph, Plan, Timeline (lanes per agent), Why, Verify (claims + lessons), Bench.

## Use it on your own repo

```bash
pnpm install && pnpm build:hook && pnpm build:mcp && pnpm build:cli && pnpm build:ui
cd /path/to/your/repo
node ~/loom/packages/cli/dist/loom.cjs init     # writes .loom/config.json, Claude Code hooks + MCP; starts FalkorDB
node ~/loom/packages/cli/dist/loom.cjs up       # daemon on :4318, dashboard on :4317
claude                                          # in this repo and in any of its worktrees, as many as you like
```

Or let Loom spawn the workers: `loom run --plan plan.yaml` (each worker gets its own worktree and branch).
Other commands: `loom plan <goal>`, `loom ui`, `loom status`, `loom why <symbol>`, `loom verify`, `loom merge-check <a> <b>`, `loom lesson add|list|rm`, `loom replay <dir> [--speed N]`.

## Results

Measured on the constructed Django tier of [STALE-bench](https://github.com/illinoisdata/STALE-bench) (clone it into `third_party/STALE-bench` to rerun). The constructed pairs are a stress test, not
a frequency estimate: on mined real PR pairs the paper saw interference in 1 of 834 runs. All numbers below are
generated from `bench/results/*.json` by `bench/regen.sh`.

<!-- bench:start -->
**E1 — STALE-bench Django, 36 pairs × 3 conditions** (agent B's patch merged with A's; interference = passes alone, fails merged)

| condition | n | B solo pass | merged pass | interference | rate | Δ vs blind | mean B s |
|---|---|---|---|---|---|---|---|
| blind | 36 | 36 | 0 | 36 | 100% | +0% | 17.7 |
| oracle | 36 | 1 | 36 | 0 | 0% | -100% | 20.2 |
| live | 36 | 13 | 24 | 12 | 33% | -67% | 29.9 |

**E3 — notice precision (live condition)**: a notice is precise when it names the helper the pair conflicts on and the blind twin interfered.

| delivered | precise | precision | notices / agent-hour | excluded (no blind twin) |
|---|---|---|---|---|
| 43 | 34 | 79% | 143.91 | 0 |

**E2 — lease race** (50 agents × 200 lease attempts on 20 symbols, one connection each; the control empties the CAS conflict matrix)

|  | attempts | granted | double grants | graph violations | ops/s | p50 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| Loom CAS lease | 10000 | 2321 | 0 | 0 | 4373 | 8.34 | 17.74 |
| control: no conflict check | 10000 | 10000 | 2332 | 526 | 2269 | 9.43 | 17.36 |

**E4 — latency an agent feels**

| path | end-to-end p50 ms | p95 | daemon p50 ms | p95 |
|---|---|---|---|---|
| hook PreToolUse Edit | 47.2 | 50.1 | 11.8 | 13.9 |
| hook PostToolUse Read | 39.9 | 42.8 | 3.9 | 4.9 |
| hook PostToolUse Edit | 59.8 | 63.3 | 28.3 | 32 |
| hook UserPromptSubmit | 38.6 | 46 | 2.9 | 3.9 |
| hook Stop | 40.3 | 47 | 4.3 | 5.3 |

Re-index on edit over all of django (10702 symbols, base index 1.8 s): p50 5.6 ms, p95 6.7 ms over 100 edits.
<!-- bench:end -->

**Reading the E1 table.** Blind: B's code passes alone in 36/36 and breaks once merged in 36/36, so the conflict is real. Oracle:
told the change, B merges cleanly in 36/36, so the task is solvable. Live Loom closes two thirds of the gap (24/36 merge; interference
100% to 33%). By kind of change: **signature 12/12, rename 9/12, return-type 3/12**. Return-type changes are Loom's weak spot: the notice
arrives with the before/after code, but Haiku often keeps its own code and does not adapt it (9 of the 12 live failures were return-type changes, the same
failure on helpers like `capfirst`, `escape`, `urlencode`). That is model compliance, not a missing notice; a stronger model or a Stop-gate
that forces a re-run against the new behaviour is the next lever. The 36 pairs are constructed (12 real helpers x 3 mechanisms) and are a
stress test, not a frequency estimate. One run per pair, Haiku only, so treat small differences as noise.

**Operational note.** FalkorDB is started with RDB snapshots off (`--save "" --stop-writes-on-bgsave-error no`), because a failed snapshot
makes Redis refuse writes and the daemon then answers HTTP 500. The compose file and `loom up` set this.

## How it is built

- `packages/indexer` — tree-sitter Python symbols, calls, signatures, mutants
- `packages/core` — FalkorDB client, schema, indexes
- `packages/daemon` — the coordinator (leases, notices, gates, claims, lessons, why, merge-check), HTTP API on :4318, dashboard + SSE on :4317, recorder and replay
- `packages/hook`, `packages/mcp` — Claude Code hook binary and MCP server (12 tools)
- `packages/planner` — task scoping and WCC partitioning for `loom run --plan`
- `apps/dashboard` — React views
- `bench/` — E1 (interference), E2 (lease race), E3 (notice precision), E4 (latency)

Graphs: `<tenant>:<repo>` per run (code + live work), `trace:<run>` per run (every step), `lessons` (global).
Deployed mode (`LOOM_READONLY=1`, see `railway.toml`) refuses every write except replaying a recording under `demo/`.
