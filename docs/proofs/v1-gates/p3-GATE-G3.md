# G3 — three real Claude Code workers on loom-demo: PASS

Run `loom-mv7y0ybo` (attempt 2), `loom run --plan demo/plan.yaml --model sonnet`, subscription login only.

| worker | task | exit | commit | resumed |
|---|---|---|---|---|
| a | strict slugify (hub owner, pre-granted write+contract on `slugify`) | 0 | d69ea01 | 0 |
| b | title_slug caller | 0 | 5dcf06c | 0 |
| c | slugify max_length + capfirst_words | 0 | 757a729 | 0 |

Merge `loom/mv7y0ybo/merged`: no conflict, 39 tests, OK (`run.out`, `run-report.json`).

## Criteria

- **Notice delivered.** b and c each got `[loom] agent a changed slugify in django/utils/text.py (contract, in progress…)`; both resolved.
- **Deny.** c asked for a contract lease on `slugify` and got
  `{"granted":false,"holders":[{"holder":"a","symbol":"django/utils/text.py::slugify","mode":"write","contract":true,"task":"a"}]}`.
  c skipped its slugify part and finished capfirst_words ("Loom denied the lease because agent `a` holds `slugify`").
- **Why.** `loom why django/utils/text.py::slugify --run loom-mv7y0ybo` → decision → task a → agent a → contract change → commit d69ea01 (`why.txt`).
- **Clean merge, tests green.** Yes.

## Attempt 1 (loom-mv7xutap): FAIL

Merge was clean but 27 tests errored: a's commit had no `text.py`. c's write lease on slugify denied a's own edits.
Fixes: lease CAS bug (an aggregate after UNWIND emptied the next OPTIONAL MATCH on FalkorDB 6.0.2), and the hub owner is pre-granted write then contract (sticky write flagged contract, spec §5.7.4). E2 rerun: 10k attempts, 0 double grants.

## Screenshots

`g3-deny-notice.jpg` and `g3-landed.png` are from attempt 1. The dashboard needs a loaded run, so attempt 2 can't be shown after a daemon restart. P5 `loom replay` covers it, and the shots get retaken then.
