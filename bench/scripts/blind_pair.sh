#!/usr/bin/env bash
# G4 merge-check pair: branch demo-blind-b = the demo's b commit with `strict=False` dropped, i.e. b written blind to a's contract.
# Usage: bench/scripts/blind_pair.sh [repo=~/Documents/loom-demo] [b=loom/mv7y0ybo/b]   (never touches the repo's checkout)
set -euo pipefail
REPO="${1:-$HOME/Documents/loom-demo}"; B="${2:-loom/mv7y0ybo/b}"
WT="$(mktemp -d)/blind-b"
git -C "$REPO" worktree add -q --detach "$WT" "$B"
trap 'git -C "$REPO" worktree remove --force "$WT"' EXIT
sed -i.bak 's/slugify(title, strict=False)/slugify(title)/' "$WT/django/utils/text.py" && rm "$WT/django/utils/text.py.bak"
git -C "$WT" diff --quiet && { echo "no strict=False call in $B" >&2; exit 1; }
git -C "$WT" -c user.email=bench@loom -c user.name=bench commit -qam "title_slug helper (blind to strict)"
git -C "$REPO" branch -f demo-blind-b "$(git -C "$WT" rev-parse HEAD)"
echo "demo-blind-b -> $(git -C "$REPO" rev-parse --short demo-blind-b)"
