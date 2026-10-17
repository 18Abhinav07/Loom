#!/usr/bin/env bash
# B5 proof: two identities, two daemons, one origin. Both change the same function; after push, pull and `loom sync`
# each machine's graph holds both people and exactly one divergence, and each briefing names the other person.
#   LOOM_FAKE=1 scripts/two-people.sh        (needs FalkorDB on :6379, git, jq, node; makes no claude calls)
# The agents' own records are written by scripts/two-people-land.mts, the writer the daemon's hooks use.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ "${LOOM_FAKE:-}" = 1 ] || { echo "set LOOM_FAKE=1 (a real-agent run needs the owner's go-ahead)"; exit 2; }
LOOM="node $ROOT/packages/cli/dist/loom.cjs"; TSX="node $ROOT/node_modules/tsx/dist/cli.mjs"
T=$(mktemp -d); RUN=$$; REGION='pkg/text.py::slugify::definition#0'; PIDS=()
free() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
ok() { echo "OK   $*"; }; die() { echo "FAIL $*"; exit 1; }
cleanup() { for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  [ -n "${REPOID:-}" ] && for w in a b; do (cd "$ROOT" && $TSX scripts/two-people-land.mts drop "p$w-$RUN" "$REPOID") || true; done; rm -rf "$T"; }
trap cleanup EXIT
ident() { git -C "$1" config user.email "$2@loom.test"; git -C "$1" config user.name "$2"; }

git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/seed" 2>/dev/null; ident "$T/seed" seed
mkdir -p "$T/seed/pkg"; printf 'def slugify(v):\n    return v\n\n\ndef other():\n    return 0\n' > "$T/seed/pkg/text.py"
git -C "$T/seed" add -A; git -C "$T/seed" commit -qm seed; git -C "$T/seed" push -q origin HEAD:main
for w in a b; do git clone -q "$T/origin.git" "$T/$w"; ident "$T/$w" "$w"; done

declare -A PORT HOMEDIR
for w in a b; do   # one daemon per person: their own LOOM_HOME (tenant, token) and graph
  HOMEDIR[$w]="$T/home-$w"; mkdir -p "${HOMEDIR[$w]}"; echo "{\"tenant\":\"p$w-$RUN\"}" > "${HOMEDIR[$w]}/config.json"
  PORT[$w]=$(free)
  (cd "$ROOT" && LOOM_HOME="${HOMEDIR[$w]}" LOOM_PORT=${PORT[$w]} LOOM_UI_PORT=$(free) $TSX packages/daemon/src/server.ts >"$T/daemon-$w.log" 2>&1) &
  PIDS+=($!)
done
for w in a b; do for _ in $(seq 40); do curl -sf "http://127.0.0.1:${PORT[$w]}/health" >/dev/null && break; sleep 0.5; done
  curl -sf "http://127.0.0.1:${PORT[$w]}/health" >/dev/null || die "daemon $w did not start: $(tail -3 "$T/daemon-$w.log")"; done
ok "two daemons up (ports ${PORT[a]}, ${PORT[b]}), tenants pa-$RUN and pb-$RUN"

as() { local w=$1; shift; (cd "$T/$w" && LOOM_HOME="${HOMEDIR[$w]}" LOOM_URL="http://127.0.0.1:${PORT[$w]}" "$@"); }
as a $LOOM init --no-lead --commit >/dev/null
git -C "$T/a" push -q origin HEAD:main
git -C "$T/b" pull -q --no-rebase origin main
as b $LOOM init --no-lead --no-commit >/dev/null
REPOID=$(jq -r .repoId "$T/a/.loom/config.json"); [ "$REPOID" = "$(jq -r .repoId "$T/b/.loom/config.json")" ] || die "the clones disagree on repoId"
as a $LOOM sync --quiet; as b $LOOM sync --quiet
ok "both clones initialised on repo $REPOID"

land() { local w=$1; (cd "$ROOT" && $TSX scripts/two-people-land.mts land "$T/$w" "$w@loom.test" "$REGION")
  git -C "$T/$w" add -A; git -C "$T/$w" commit -qm "$w changes slugify"; }
land a; git -C "$T/a" push -q origin HEAD:main                  # A lands slugify and pushes
land b; as b $LOOM sync --quiet                                  # B lands it too; B's sync sees A's side and records the divergence
git -C "$T/b" add -A; git -C "$T/b" commit -qm "divergence record"
git -C "$T/b" pull -q --no-rebase --no-edit origin main; git -C "$T/b" push -q origin HEAD:main
git -C "$T/a" pull -q --no-rebase --no-edit origin main; as a $LOOM sync --quiet

q() { curl -sf "http://127.0.0.1:${PORT[$1]}$2$([[ $2 == *\?* ]] && echo '&' || echo '?')cwd=$T/$1"; }
for w in a b; do
  o=$([ $w = a ] && echo b || echo a)
  q $w /people | jq -e '[.[].person] | contains(["a@loom.test","b@loom.test"])' >/dev/null || die "$w: /people lacks a person"
  ok "$w: /people has both"
  [ "$(q $w '/collisions?kind=divergence' | jq length)" = 1 ] || die "$w: divergence count is not 1: $(q $w /collisions | jq -c .)"
  ok "$w: exactly one divergence"
  q $w /collab | jq -e '.edges | length == 1 and .[0].collisions == 1' >/dev/null || die "$w: /collab edge"
  ok "$w: /collab shows the pair with one collision"
  # the other person's landing is news to me: a fresh watermark-less viewer sees it in the read-only briefing
  q $w "/brief?person=viewer@loom.test" | jq -e --arg o "$o@loom.test" '.text | contains($o)' >/dev/null || die "$w: briefing does not name $o@loom.test"
  ok "$w: briefing names $o@loom.test"
done
echo "ALL OK"
