#!/usr/bin/env bash
# Regenerate every bench/results/*.json the dashboard Bench view and README tables read.
# Usage: bench/regen.sh [--records bench/runs/e1/<dir>]   (FalkorDB up; e4 hooks also needs the daemon: `loom up`)
set -euo pipefail
cd "$(dirname "$0")/.."
RECORDS=""
while [ $# -gt 0 ]; do case "$1" in --records) RECORDS="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done

echo "== e2 leases";          pnpm exec tsx bench/e2/leases.mts
echo "== e2 control";         E2_BROKEN=1 pnpm exec tsx bench/e2/leases.mts || true   # the control is expected to show violations
echo "== e4 hooks";           pnpm -s build:hook >/dev/null && pnpm exec tsx bench/e4/hooks.mts
echo "== e4 indexer";         pnpm exec tsx bench/e4/indexer.mts
if [ -n "$RECORDS" ]; then
  echo "== e1 report + e3 ($RECORDS)"
  (cd bench && .venv/bin/python -m e1.report --records "${RECORDS#bench/}" && .venv/bin/python -m e1.e3 --records "${RECORDS#bench/}")
fi
echo "== README tables";     (cd bench && .venv/bin/python readme.py)
ls -1 bench/results/
