# Gate G4: depth (P4)

**Verdict: PASS** (2026-10-14)

## Seeded blind spot (`bench/scripts/verify_seed.sh`, against a new-source daemon)
- claim_done result: `VERIFIED`, strength 0.67, `blindSpots: ["pkg/m.py::g"]`, labels test_f + test_g.
- `loom verify` prints `blind: pkg/m.py::g` and exits 1.
- The script prints `PASS: blind spot g named`.

## Merge-check on the demo run (`~/Documents/loom-demo`, `--run loom-mv7y0ybo`)
- `a b`: predicted 0, confirmed 0, false positives 0, misses 0. b was told about a's change and adapted.
- `a demo-blind-b`: predicted 1 (`title_slug → slugify`, "calls slugify(1 positional) but a changed it to `def slugify(value, allow_unicode=False, *, strict)`"), confirmed 1, false positives 0, misses 0. 5 TitleSlugTests fail on the merge.

## Bench reproducibility (`bench/regen.sh --records bench/runs/e1/20261014-160928`)
- E1 core set (12 pairs × 3 conditions, sonnet, claude.ai subscription):
  - blind: interference 12/12;
  - oracle: 0/12;
  - live: 1/12 (−92% vs blind).
- E3: 15 notices delivered, 12 precise (80%), 147.6 per agent-hour, 0 excluded.
- E2: the CAS lease gives 0 double grants out of 10000. The control without a conflict check gives 1870.
- E4: daemon p50 for PostToolUse Edit went from 14.5 ms to 29.1 ms (P5 patch recording). End-to-end is 58 ms, within budget.
- Python bench tests: 18/18. All 6 `bench/results/*.json` files regenerated, and the README block was rewritten from them.

Not run: the 108-pair extended set. It waits for Abhinav's go-ahead.
