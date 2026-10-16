# E5 x1_textlist — results (pre-registered in PREREG.md)

Run `bench/runs/e5/20261016-110735/` · Loom build 733ca4e · 3 reps × {blind, loom} · Claude Code subscription.

| cond  | all_pass | broken | merge conflicts | wall s (sum) | cost USD | turns |
|-------|----------|--------|-----------------|--------------|----------|-------|
| blind | 0/3      | 0      | 3               | 160          | 1.28     | 120   |
| loom  | 3/3      | 0      | 0               | 294          | 2.52     | 191   |

**Rule outcome: supported** (Σ all_pass 3 > 0; Σ broken 0 ≤ 0).

## What actually decided it
- Every blind failure is a textual git conflict at the end merge: r0 and r2 on `django/contrib/admin/models.py` (a's caller update vs c's LogEntry change), r1 on `django/utils/text.py` (a's rename vs b's new helper). No blind run reached the tests.
- Under Loom the same agents landed one at a time; b and c were resumed onto the landed branch (b: 1/1/0 resumes, c: 2/2/3) and saw a's work before finishing. Notices: a got 2 and c got 1 per rep, all delivered.
- `broken` (passes solo, fails merged) never occurred in either arm, so this scenario does **not** test semantic-breakage detection; it tests coordination of overlapping edits.
- Blind b fails its *solo* check in all reps because it codes against a's not-yet-existing `format_list` (the shared brief names it). That is a dependency, not breakage; b passes on the merged tree where the merge got that far.

## Costs and limits
- Loom costs ~2× and takes ~1.8× wall time (handover waits + resumes).
- n = 3 per arm, one scenario. Lease denials, stale detection and contract-break rejection did not fire in any run; they are backed by their integration tests only.
