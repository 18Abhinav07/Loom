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
