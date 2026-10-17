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

**1. See it (the hackathon demo)**

```bash
loom demo                   # starts FalkorDB + the daemon, opens http://127.0.0.1:4317/?demo=1
```

- **Recorded run**: the hero plays 3 real Claude agents on Django (no API key, no agents running).
- **Run it live**: pick Haiku / Sonnet / Opus and press *Run 3 agents with and without Loom*. Six real Claude sessions run on a
  small Python repo (`~/.loom/demo-repo`, created for you) on **your own Claude plan**. Watch the locks, the notices and who lands.
- **Benchmark**: the *Benchmark* tab shows the StaleBench runs shipped in `bench/results` (12 of 12 broke without Loom, 0 of 12 with it,
  n=12 constructed pairs; see `bench/e5/PREREG.md`).

**2. Use it on your own project**

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
| `loom up` / `loom down` | start / stop the daemon (`init` and `demo` already start it) |
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
**E1 — STALE-bench Django, 12 pairs × 3 conditions** (agent B's patch merged with A's; interference = passes alone, fails merged)

| condition | n | B solo pass | merged pass | interference | rate | Δ vs blind | mean B s |
|---|---|---|---|---|---|---|---|
| blind | 12 | 12 | 0 | 12 | 100% | +0% | 19.6 |
| oracle | 12 | 4 | 12 | 0 | 0% | -100% | 16.8 |
| live | 12 | 3 | 12 | 0 | 0% | -100% | 29.7 |

**E3 — notice precision (live condition)**: a notice is precise when it names the helper the pair conflicts on and the blind twin interfered.

| delivered | precise | precision | notices / agent-hour | excluded (no blind twin) |
|---|---|---|---|---|
| 15 | 12 | 80% | 151.39 | 0 |

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
