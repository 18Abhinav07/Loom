#!/usr/bin/env bash
# One command after cloning Loom: installs everything, asks what to run, opens the dashboard, runs it.
#   ./scripts/demo.sh                 pick interactively
#   ./scripts/demo.sh live            Django demo: 3 agents without Loom vs 3 with (you press Plan)
#   ./scripts/demo.sh 12|36|108       StaleBench: 12 pairs (24 runs), 36 pairs (72), 36 pairs x 3 conditions (108)
#   env: MODEL=haiku|sonnet (default haiku)  DJANGO_DIR=~/loom-django  YES=1 (skip the token confirmation)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODEL="${MODEL:-haiku}"
DJANGO_DIR="${DJANGO_DIR:-$HOME/loom-django}"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

say "1/5 checking your machine"
command -v git >/dev/null    || die "need git"
command -v node >/dev/null   || die "need Node 22+ (https://nodejs.org)"
command -v docker >/dev/null || die "need Docker (FalkorDB runs in it)"
docker info >/dev/null 2>&1  || die "Docker is installed but not running: start Docker Desktop and retry"
command -v claude >/dev/null || die "need the Claude Code CLI, logged in (https://claude.com/claude-code)"
PY=""; for p in python3.13 python3.12 python3; do command -v $p >/dev/null && $p -c 'import sys;sys.exit(sys.version_info<(3,12))' && PY=$p && break; done
[ -n "$PY" ] || die "need Python 3.12+"
echo "ok"

say "2/5 installing Loom (once)"
if ! command -v loom >/dev/null || [ ! -f packages/cli/dist/loom.cjs ]; then ./scripts/install.sh; else echo "already installed"; fi
command -v loom >/dev/null || die "loom is not on your PATH after install; open a new terminal and rerun"

CHOICE="${1:-}"
if [ -z "$CHOICE" ]; then
  say "what do you want to run?"
  cat <<'M'
  1) live    Django demo: 3 agents without Loom, then 3 with Loom, watched in the dashboard   (6 agent runs)
  2) 12      StaleBench core: 12 pairs, blind vs Loom                                          (24 agent runs)
  3) 36      StaleBench: all 36 real-derived pairs, blind vs Loom                              (72 agent runs)
  4) 108     36 pairs x 3 conditions (blind, oracle, Loom)                                     (108 agent runs)
M
  read -rp "choose 1-4 [1]: " n
  case "${n:-1}" in 1) CHOICE=live;; 2) CHOICE=12;; 3) CHOICE=36;; 4) CHOICE=108;; *) die "pick 1-4";; esac
  read -rp "model, haiku or sonnet [$MODEL]: " m; MODEL="${m:-$MODEL}"
fi

if [ "$CHOICE" = live ]; then
  say "3/5 getting Django"
  [ -d "$DJANGO_DIR/.git" ] || git clone --depth 1000 https://github.com/django/django "$DJANGO_DIR"
  say "4/5 starting Loom on Django"
  cd "$DJANGO_DIR"
  echo "Loom will index Django, open the dashboard and start the Lead."
  echo "In the dashboard press Plan: the Lead proposes the three tasks and runs them without Loom (Home) and with Loom (Team)."
  exec loom init
fi

case "$CHOICE" in 12) ARGS="--pairs 12";; 36) ARGS="--pairs 36";; 108) ARGS="--pairs 36 --oracle";; *) die "use live, 12, 36 or 108";; esac
say "3/5 checking the benchmark setup (spends nothing)"
loom stalebench $ARGS --model "$MODEL" --check
say "4/5 starting the dashboard"
loom up
URL="http://127.0.0.1:4317/?cwd=$(printf %s "$ROOT" | sed 's| |%20|g')&view=bench"
echo "$URL"; (open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true)
say "5/5 running StaleBench ($ARGS, $MODEL)"
loom stalebench $ARGS --model "$MODEL" ${YES:+--yes}
