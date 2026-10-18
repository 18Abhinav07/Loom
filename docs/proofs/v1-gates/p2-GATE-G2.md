# GATE G2 — PASS (2026-10-13)

Plan: Brain `plans/02-core.md` Task 6. Model: sonnet. Daemon: `loom up` (attach-capable build).

## E2 — lease safety (bench/results/e2.json, e2-control.json)

| run | attempts | granted | double grants | graph violations | throughput | grant p50 / p99 | read p50 / p99 |
|---|---|---|---|---|---|---|---|
| real | 10000 | 2362 | **0** | **0** | 3779/s | 10.39 / 11.73 ms | 0.44 / 0.81 ms |
| control (`E2_BROKEN=1`) | 10000 | — | 1870 | 703 | — | — | — |

The control proves the detector fires when the lease check is removed.

## E4 — hook latency (bench/results/e4-hooks.json, n=100 each)

| event | total p95 (hook process) | daemon-only p95 |
|---|---|---|
| PreToolUse Edit | 72.0 ms | ≤ 19 ms |
| PostToolUse Read | 62.7 ms | ≤ 19 ms |
| PostToolUse Edit | 66.4 ms | ≤ 19 ms |
| UserPromptSubmit | 59.4 ms | ≤ 19 ms |
| Stop | 60.8 ms | ≤ 19 ms |

Bar: every event p95 < 150 ms. Node startup is most of the total.

## e2e — packages/daemon e2e test, 42/42 suite green.

## Deny smoke — real Claude session (bench/scripts/deny_smoke.sh, bench/runs/p2/deny.jsonl)

> [loom] edit blocked before it happened: django/utils/text.py::phone2numeric is leased by agent A (contract, task implicit:A). A's pending change: def phone2numeric(phone) → def phone2numeric(phone, *, strict)

Signature in B's tree unchanged after the session.

## Pilot regression — live, 6 sessions (bench/runs/e1/20261013-210413/records.jsonl)

| instance | merged | notices delivered | resolved | Stop blocks | resumed | A landed (s) |
|---|---|---|---|---|---|---|
| phone2numeric | ✅ | 1 | 1 | 0 | 0 | 13.1 |
| slugify | ✅ | 1 | 1 | 0 | 0 | 9.1 |
| get_valid_filename | ✅ | 1 | 1 | 1 | 0 | 7.1 |
| normalize_newlines | ✅ | 1 | 1 | 0 | 0 | 8.1 |
| int_to_base36 | ✅ | 1 | 1 | 0 | 0 | 9.1 |
| base36_to_int | ✅ | 1 | 1 | 0 | 0 | 16.2 |

6/6 merged (bar ≥ 5/6), notices 6/6 (bar 6/6). Cost $0.49. P2 (leases, Stop gate, resolution) did not regress the P1 thesis result.

Side check (not official): rettype post-hoc re-run 4/4 merged, run 20261013-210123, $0.33. G1b's official number stays 10/12.
