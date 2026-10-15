# Implementation plans

Spec: [`docs/specs/2026-10-15-loom-v2-design.md`](../specs/2026-10-15-loom-v2-design.md) · Proof ledger: [`docs/proofs/LEDGER.md`](../proofs/LEDGER.md)

Plans run in this order. A phase merges only when its gate is green (spec §11). Every claim that a phase cannot prove itself goes into the ledger as `open`. It becomes `proven` or `refuted` only with a command and a result file.

| Phase | Plan | Gate | Then run (each needs a go-ahead) | Status |
|---|---|---|---|---|
| P1 | [Region engine](2026-10-15-p1-regions.md) | L−1 (`bench/results/l-1.txt`) | — | done |
| P1.5 | [Thesis gate](2026-10-15-p1.5-thesis-gate.md) | T1–T5 proven or refuted | — | running |
| P2 | [Repo graph, `.loom/` memory, sync](2026-10-15-p2-memory-sync.md) | L0 memory (`bench/results/l0-memory.txt`), I1 | — | done locally, not committed |
| P3 | [Live coordination on regions](2026-10-15-p3-live-coordination.md) | L0 coordination, S1 | STALE core, E5 | planned |
| P4 | [Conflict/diff engine, path `why`, 19 MCP tools](2026-10-15-p4-conflict-diff-tools.md) | L0 conflict | X1, X2 | planned |
| P5 | [Dashboard, `loom demo`, README, submission](2026-10-15-p5-dashboard-demo-submission.md) | review; suite + build green | — | planned |

**Cut order if late** (§11): Ask bot → `define_regions` → TS pack → regionMerge in handover → Region-history view.
**Never cut:** L−1, L0, S1, I1, the thesis gate, the ledger, and running STALE, E5, X1 and X2.

**How each plan is written:** TDD steps (failing test → run → implement → run), exact file paths, the interfaces a task consumes and produces, rulings taken while planning, and a Review Focus list of five failure modes the tests must pin.
