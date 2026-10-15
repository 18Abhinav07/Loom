#!/usr/bin/env bash
# Real PreToolUse deny (plan 02 Task 6 Step 4): agent A holds a contract lease on phone2numeric; a real sonnet
# session as B is asked to change its signature. Expect the deny reason in B's transcript and the signature unchanged.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${LOOM_URL:-http://127.0.0.1:4318}"
HOOK="node $ROOT/packages/hook/dist/loom-hook.cjs claude"
OUT="${1:-$ROOT/bench/runs/p2}"; mkdir -p "$OUT"
WORK="$(mktemp -d)"; A="$WORK/a"; B="$WORK/b"; RUN="coord:deny:$(date +%s)"
for d in "$A" "$B"; do
  mkdir -p "$d/django/utils"; cp "$ROOT/bench/cache/django-src/django/utils/text.py" "$d/django/utils/"
  git -C "$d" init -q; git -C "$d" add .; git -C "$d" -c user.email=x@loom -c user.name=x commit -qm base
done
post() { curl -sf -X POST "$URL$1" -H 'content-type: application/json' "${@:3}" -d "$2"; }
post /admin/runs "{\"run\":\"$RUN\",\"root\":\"$A\",\"dirs\":[\"django\"],\"baseKey\":\"$RUN\"}" >/dev/null
post /admin/agents "{\"run\":\"$RUN\",\"agent\":\"A\",\"harness\":\"replay\",\"worktree\":\"$A\"}" >/dev/null
F="$A/django/utils/text.py"
# A: contract lease via a fixture PreToolUse, then the edit lands and is ingested
post /hook/claude/PreToolUse "{\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$A\",\"session_id\":\"s-a\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$F\",\"old_string\":\"def phone2numeric(phone):\",\"new_string\":\"def phone2numeric(phone, *, strict):\"}}" \
  -H "x-loom-agent: A" -H "x-loom-run: $RUN" >/dev/null
sed -i '' 's/def phone2numeric(phone):/def phone2numeric(phone, *, strict):/' "$F"
post /admin/ingest "{\"run\":\"$RUN\",\"agent\":\"A\",\"worktree\":\"$A\",\"files\":[\"django/utils/text.py\"]}" >/dev/null
mkdir -p "$B/.claude"
cat > "$B/.claude/settings.json" <<JSON
{"hooks":{"PreToolUse":[{"matcher":"Edit|Write|MultiEdit","hooks":[{"type":"command","command":"$HOOK PreToolUse","timeout":30}]}],
 "PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"$HOOK PostToolUse","timeout":30}]}]}}
JSON
cd "$B"
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN LOOM_URL="$URL" LOOM_RUN="$RUN" LOOM_AGENT=B \
  claude -p --model sonnet --setting-sources project --output-format stream-json --verbose \
  "Change phone2numeric in django/utils/text.py to take a second parameter region=None." < /dev/null > "$OUT/deny.jsonl"
SIG="$(grep -n 'def phone2numeric' django/utils/text.py)"
DENIED=$(grep -c 'leased by agent A' "$OUT/deny.jsonl" || true)
echo "run=$RUN"; echo "signature now: $SIG"; echo "deny lines in transcript: $DENIED"
post /release "{\"run\":\"$RUN\",\"agent\":\"A\"}" >/dev/null || true
[[ "$DENIED" -gt 0 && "$SIG" == *"def phone2numeric(phone):"* ]] && echo "DENY SMOKE: PASS" || { echo "DENY SMOKE: FAIL"; exit 1; }
