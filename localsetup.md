# Local setup

Everything needed to run Loom and reproduce the StaleBench results on one machine. About 15 minutes the first time.

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Node 22+ and pnpm | build and run Loom | `node -v`, `pnpm -v` |
| Docker (running) | FalkorDB, the graph database | `docker info` |
| Python 3.12+ | the benchmark harness and Django tests | `python3 --version` |
| git | clones Django and STALE-bench | `git --version` |
| `claude` CLI, logged in | the agents run on your own Claude plan | `claude --version` |

## 2. Get it running (one command)

```bash
git clone https://github.com/18Abhinav07/Loom.git
cd Loom
./scripts/demo.sh
```

`demo.sh` checks the prerequisites, builds Loom, starts FalkorDB and the daemon, opens the dashboard, then asks what to run.
Use **one clone only**; two clones share ports 4317/4318 and the `loom` command points at whichever installed last.

| Menu choice | Command | What it does | Agent runs | Cost (Haiku) |
|---|---|---|---|---|
| 1 live | `./scripts/demo.sh live` | Django demo: 4 agents without Loom, then 4 with Loom. Press **Plan** in the dashboard. | 8 | cents |
| 2 core | `./scripts/demo.sh 12` | 12 pairs, blind vs Loom | 24 | ~$0.15 |
| 3 all | `./scripts/demo.sh 36` | 36 pairs, blind vs Loom | 72 | ~$0.35 |
| 4 full | `./scripts/demo.sh 108` | 36 pairs x blind, oracle, live | 108 | ~$0.60 |

`MODEL=sonnet ./scripts/demo.sh 108` changes the model; `YES=1` skips the cost prompt.

## 3. Manual steps (what demo.sh does)

```bash
./scripts/install.sh          # pnpm install, builds hook/mcp/cli/ui, puts `loom` on PATH
loom up                       # FalkorDB (docker compose) + daemon :4318 + dashboard :4317
loom stalebench --check       # verifies git, Python, Docker, claude; spends nothing
loom stalebench --pairs 108   # or 12 / 36; asks before spending tokens
```

Direct harness (from `bench/`): `.venv/bin/python -m e1.run --set all --conds blind,oracle,live --model haiku --jobs 5`.
If a run is cut off (usage limit, crash), resume it: add `--skip-done runs/e1/<timestamp>`.

## 4. Where results go

- Raw records: `bench/runs/e1/<timestamp>/records.jsonl` (git-ignored; **copy it before deleting a clone**).
- Shipped records from the published run: `bench/results/e1/records-108.jsonl` (the dashboard falls back to it on a fresh clone).
- Summaries: `bench/results/e1.json`, `e1-story.json`, `e3.json`. Regenerate with
  `bench/regen.sh --records bench/runs/e1/<timestamp>`; this also rewrites the table in `README.md`.
- Dashboard: http://127.0.0.1:4317/?cwd=<repo> , **Benchmark** tab (Home and Team show the live demo).

## 4b. Published result (Haiku, 108 runs)

| condition | merged pass | interference |
|---|---|---|
| blind | 0/36 | 100% |
| oracle | 36/36 | 0% |
| live (Loom) | 24/36 | 33% |

Live by change kind: signature 12/12, rename 9/12, return type 3/12.

## 5. Troubleshooting

- **HTTP 500 from the daemon / "MISCONF"**: FalkorDB refuses writes after a failed snapshot. `loom up` and `docker-compose.yml` turn snapshots off; on an old container run
  `docker exec loom-falkordb-1 redis-cli config set stop-writes-on-bgsave-error no`.
- **"dashboard view unavailable"** during a benchmark: only the optional dashboard repo failed to set up; the benchmark itself is unaffected.
- **Port 4317/4318 busy**: another Loom daemon (often from a second clone) is running. `loom down`, or kill it, then `loom up` from this clone.
- **Run stops with "usage limit"**: wait for your Claude plan window, then resume with `--skip-done`.
- **Wrong numbers on the Benchmark tab**: you are running a daemon from a different clone; check `ps aux | grep packages/daemon`.
