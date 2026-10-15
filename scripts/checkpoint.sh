#!/usr/bin/env bash
# Snapshot before the event window opens; commit once it is open (Oct 15 00:01 IST).
set -euo pipefail
msg="${1:?usage: checkpoint.sh <message>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
open_epoch=$(TZ=Asia/Kolkata date -j -f "%Y-%m-%d %H:%M" "2026-10-15 00:01" +%s)
if [ "$(date +%s)" -lt "$open_epoch" ]; then
  dest="$HOME/Documents/loom-snapshots/$(date +%Y%m%d-%H%M%S)-$(echo "$msg" | tr -cs 'a-zA-Z0-9' '-' | cut -c1-40)"
  mkdir -p "$dest"
  rsync -a --exclude node_modules --exclude .venv --exclude cache --exclude runs --exclude third_party --exclude dist "$root/" "$dest/"
  echo "snapshot: $dest"
else
  cd "$root"; [ -d .git ] || git init -q
  git add -A && git commit -qm "$msg" && git log --oneline -1
fi
