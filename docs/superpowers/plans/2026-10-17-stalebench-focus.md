# Loom: StaleBench-only focus plan (Oct 17, deadline Oct 18 23:59 IST)

**Positioning:** Loom is a StaleBench solver. FalkorDB is the agents' shared memory and message bus. It may work on other repos but we don't claim it. Everything outside the demo path is hidden or cut.

**One promise:** clone loom + clone the StaleBench Django checkout, run 3 commands, watch 3 agents solve the same task without Loom (break) and with Loom (coordinate through FalkorDB), in a dashboard.

## The demo path (the only thing that must be flawless)
1. `./scripts/install.sh` (deps, build, `loom` on PATH)
2. `loom stalebench ~/path/to/django` (new command): starts FalkorDB + daemon, indexes the repo ONCE (cached), loads the shipped plan, opens the dashboard on the Compare screen.
3. Dashboard: one big "Run: without Loom vs with Loom" button -> two teams of 3 agents run side by side, live graph of regions/claims/notices, final test result per side.
4. A "Replay our recorded run" button for people without API credit (already works: `demo/run-1`).

## Cut / hide (don't fix what the demo doesn't need)
- Lead interactive planning, `loom init` on arbitrary repos, new-project flow, Plans-tab editing, git-hook sync, the 8 old-UI vitest files (delete them).
- Dashboard tabs reduced to: Compare (live), Graph (FalkorDB), Messages (agent-to-agent), Benchmark (shipped results), Replay.

## Work items, in order (each ends with a verification)
| # | Item | Done when |
|---|---|---|
| 1 | `loom stalebench <repo>` command: ensureDb+daemon, copy shipped plan, index in background with progress, open `/?cwd=..&view=compare` | one command from a clean clone reaches the dashboard; empty-state never shown |
| 2 | Fix slow/hanging index on 2 GB Django: index only `django/` python (skip docs, tests data, js), cache by HEAD sha | index < 60s, second run instant |
| 3 | Fix hook error `Cannot read properties of null (reading 'excludes')` (hook SessionStart) | no hook errors in `~/.loom/daemon.log` during a run |
| 4 | Compare screen: one button starts blind + loom teams; shows both columns, agent status, test result, collisions count | a full Haiku run finishes with both columns filled; screenshot |
| 5 | Agent-to-agent via FalkorDB made visible: Messages tab lists notices/claims/blocks as graph writes (query shown) | during the loom run, events appear live with the Cypher/graph node they came from |
| 6 | Run it for real 3x on Haiku; record honest numbers (n=3 per side) into `bench/results`, Benchmark tab reads only those | README table matches files |
| 7 | Record the demo video from the exact 3-command path on a fresh clone | video + fresh-clone checklist passes |
| 8 | README rewritten around the 3 commands and the FalkorDB story; honest limits section | a stranger can follow it |
| 9 | Commit, push `feat/b7-ui`, PR #28 updated | CI/build green |

## Schedule
- Oct 17 (today): items 1-5. Item 2 and 3 first, they block everything.
- Oct 18 morning: 6 (real runs), then 7-8. Afternoon buffer, submit by evening, not at 23:59.

## Risks
- Real runs cost API credit and may not show a clean win: report whatever n=3 gives; replay stays as the guaranteed visual.
- Fresh-clone friction (Docker, Python venv for Django tests): `install.sh` must create the venv and install asgiref/sqlparse; test it on a clean directory.

## Decisions I need from you
1. Haiku for live runs (cheap, ok?) 
2. Delete the 8 stale vitest files?
