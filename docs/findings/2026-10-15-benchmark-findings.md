# Benchmark findings (v1)

These are the results v2 is designed against. Every agent run used the Claude Code CLI, model Sonnet, with all `ANTHROPIC_*` environment variables stripped. Raw records are in `bench/runs/` (local), and the curated copies are in `bench/results/`.

## E1: STALE-bench core (semantic interference across different functions)

12 held-out pairs. Agent B edits code that depends on a contract agent A changes in a *different* function. Each pair runs under 3 conditions; the measure is merged-pass (tests green after merging A and B).

| Run | blind | oracle | live (Loom) | Notes |
|---|---|---|---|---|
| `20261014-160928` | 0/12 | 12/12 | 11/12 | Contaminated: the global lessons graph leaked lessons from earlier runs (finding C1) |
| `20261014-164045` | 0/12 | 12/12 | 12/12 | Clean rerun; agent cost $0.70 / $0.60 / $0.87 |

**Reading:**
- Without coordination, every pair breaks on merge.
- With Loom, agents are told mid-work about the contract change and adapt.
- This is the between-agents half of the thesis.

## E5: team scenarios (four agents editing the same function in `django/utils/text.py`)

Both conditions get the whole team brief and everyone's assignment. `blind` = the briefed team without Loom.

| Condition | all_pass | agents_ok | broken | conflicts | wall time | cost | turns |
|---|---|---|---|---|---|---|---|
| blind | 0/3 | 4/12 | 5 | 3 | 103s | $1.25 | 71 |
| loom | 0/3 | 4/12 | 5 | 3 | 259s | $2.84 | 168 |

**Loom did not help here.** Root causes, from the transcripts and the branch ancestry:

- **RC1. A lease handover is not a code handover.**
  - In s1, agent a landed at 03:13:54. At 03:13:59, agent c was allowed to edit `slugify` on a checkout that did not contain a's commit.
  - Only stopped agents are synced, not running ones.
- **RC2. `sync()` fails on a dirty worktree.**
  - git refuses to merge into uncommitted edits to the same file, even when the edited functions don't overlap (reproduced).
  - The agent is falsely told "conflicts with yours" and carries on with stale code.
- **RC3. Stale notice text.** Agent c was told "in progress, not in your checkout yet" 24 seconds *after* a had landed.
- **RC4. `tests/` is not indexed.** So there are no leases on test code, and s2 conflicted in `tests/utils_tests/test_text.py`.
- **RC5. Retry loops after a denied edit.** In s3, agent b was denied 6 times in 35 seconds, which is why Loom used 168 turns against blind's 71.
- **RC6. A self-attributed wake.** Agent b was told "agent b's change … has landed".
- **Grading flaw.** Each agent's `merged` was graded even when the final merge had stopped at a conflict, on a partial tree.

## E5 pilot-1 (2 to 3 agents, uninformed baseline)

loom 3/3 all_pass vs blind 0/3. This was **overclaimed**: the baseline was handicapped because blind agents didn't get the team brief, and the tasks were easy. It's kept for the record, not as evidence.

## Memory findings

- **C1.** The lessons graph is global, so lessons leaked between runs and repos and contaminated an E1 run.
- **Coordination state is per run.** Every run creates a fresh graph, so nothing persists across sessions except the lessons.

## What v2 changes

See `docs/specs/2026-10-15-loom-v2-design.md`:

- **RC1, RC2 and RC3:** code handover, the merge queue and wake text generated at delivery time.
- **RC4:** `tests/` indexed, with TESTS edges.
- **RC5:** denial back-off.
- **RC6:** a no-self-wake filter.
- **The grader** is fixed.
- **C1 and per-run memory:** one persistent graph per tenant and repo, carried in git through `.loom/`.
