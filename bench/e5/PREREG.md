# E5 complex benchmark — pre-registration

Written and committed **before** any real agent ran on `x1_textlist`. Nothing below changes after the first real run.

## Question
Do three Claude Code agents working on intermingled tasks in one codebase ship a correct merged result more often with Loom than without it?

## Setup (fixed)
- Scenario: `x1_textlist` (Django @ afe6634). A renames `get_text_list` → `format_list(items, *, conjunction)` across six modules; B adds `format_count_list` + `joinlist`; C builds the LogEntry change message on B's helper (C needs B).
- Conditions: `blind` (same brief, same worktrees, same merge, no Loom hooks/MCP) vs `loom`.
- Agents: Claude Code CLI, subscription auth (no API key), default model, same prompts in both conditions.
- Reps: 3 per condition, conditions alternated within each rep (`--reps 3`).
- Grading is automatic: per-agent oracle on its solo commit and on the merged tree; integration oracle; 57 Django tests (`utils_tests.test_text admin_utils.test_logentry validation.test_unique template_tests.test_parser`) on the merged tree.

## Metrics
- **all_pass**: all three agent oracles + integration oracle + Django tests pass on the merged tree.
- **broken**: agent passed solo, fails merged (someone else broke it).
- Also reported, not judged: conflicts, wall time, cost, turns, notices sent/delivered, lease denials, resumes.

## Rule
- **Thesis supported** iff Σ all_pass(loom) > Σ all_pass(blind) over the 3 reps **and** Σ broken(loom) ≤ Σ broken(blind).
- Anything else (tie, blind ahead, loom breaks more) = **not supported on this scenario**, reported as such.
- n = 3 per arm: this is evidence for one scenario, not a statistical claim. Cost ratio is reported next to the result.

## Integrity
- One loom readiness run happens first and is **not counted**; it only checks every mechanism fires.
- If Loom or the harness changes after any counted run, all counted runs are discarded and rerun.
- Every run's records, transcripts, diffs and logs are kept under `bench/runs/e5/<stamp>/`. No run is dropped; crashed runs count as failures.

## Addendum (2026-10-16, before any of these runs)
The harness changed after the counted x1 runs (e916b94: denial/handover counting and the rep field; this commit: each worker's
landing outcomes `lands`). Run behaviour is unchanged, but the rule above says changed harness → counted runs discarded. So:
- **x1_textlist** is rerun, 3 reps per arm, with this harness. The earlier x1 runs (`20261016-110735`) stay on disk, not counted.
- **t1_slugpath** (semantic breakage: a makes `slugify`'s `strict` keyword required while b/c write new callers) gets the same
  rule, 3 reps per arm, run in the same invocation. Its earlier runs (n=2) are not counted.
- **f1_oldcall** is a **fault-injection mechanism check, not counted toward any thesis**: c is instructed to keep calling
  `slugify(part)` whatever it is told. Pass condition, decided now: in every loom rep at least one landing ends
  `contract_break` and the landed branch never contains a call that does not fit `slugify`'s merged signature (c's oracle may
  fail; that is c's injected fault). Blind is run beside it to show what the same agents merge without the check.
  1 rep per arm, 3 if the first loom rep does not show a `contract_break` (reported either way).

## Addendum 2 (2026-10-16, before the reruns below)
The runs in `20261016-114037` (t1 + x1 r0) and `20261016-113848` (f1) were made on the build before two Loom fixes, each
found by those real-agent runs and covered by a test that failed first:
- 04847e3: the contract check did not see a function handed to `map`/`filter`/`key=` (t1 loom r2 landed `[*map(slugify, head)]`
  after `strict` became required).
- 5a6cb6e: a worker whose landing only missed a callee another agent had not landed yet was resumed to no end (x1 loom r0).
Loom changed, so by the rule above all of those runs are **discarded** (kept on disk, reported as pre-fix evidence, not counted).
Counted now: t1_slugpath and x1_textlist, 3 reps per arm, plus f1_oldcall under its own pass condition, all on this build.

## Addendum 3 — daemon-owned teams (build recorded at the counted run)

Loom v2 replaced the v1 run-then-merge flow: `loom run --plan` now starts a daemon-owned team (agents land on a shared `landed` branch as they finish, hooks and collision checks live). Counted runs are made on that build, recorded as `<sha>` in the run's `records.jsonl` header before the first run.

- Scenarios unchanged: `t1_slugpath`, `x1_textlist`, `f1_oldcall`, now fed from plan files (`bench/plans/*.md`, generated from `scenarios.py` by `e5/plans.py`) to both arms; `--blind` is the same team without hooks or Loom tools.
- 3 reps per arm. Scoring unchanged: each agent's check on the final tree, the integration check, the plan's test run on the landed branch.
- Results from earlier builds are kept and labelled `build 5a6cb6e`; they are not pooled with these.
- Any Loom change after counted runs begin discards them (rule above); a re-run needs a further addendum.
