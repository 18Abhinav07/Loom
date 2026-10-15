#!/usr/bin/env bash
# G4 seeded blind spot: a repo where g's only test calls g but asserts nothing. An attach-mode agent edits f and g through
# the daemon's hook HTTP, then claim_done and `loom verify` must both name g as the blind spot. Needs the daemon (loom up).
set -euo pipefail
LOOM="$(cd "$(dirname "$0")/../.." && pwd)"; URL="${LOOM_URL:-http://127.0.0.1:4318}"
R="$(mktemp -d)/seed"; RUN="seed:$(date +%s)"; mkdir -p "$R/pkg" "$R/tests" "$R/.loom"
printf 'def f(x):\n    return x + 1\n\n\ndef g(x):\n    return x * 2\n' > "$R/pkg/m.py"
touch "$R/pkg/__init__.py" "$R/tests/__init__.py"
printf 'import unittest\nfrom pkg import m\n\n\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(m.f(1), 2)\n\n    def test_g(self):\n        m.g(1)\n' > "$R/tests/test_m.py"
cat > "$R/.loom/config.json" <<JSON
{"run": "$RUN", "dirs": ["pkg"], "test": {"command": "cd tests && PYTHONPATH=.. python3 -m unittest {labels}", "label": "{module_dotted}.{Class}.{method}", "root": "tests"}}
JSON
git -C "$R" init -q && git -C "$R" add -A && git -C "$R" -c user.email=s@s -c user.name=s commit -qm base
hook() { curl -s -X POST "$URL/hook/claude/$1" -H 'content-type: application/json' -d "{\"hook_event_name\":\"$1\",\"cwd\":\"$R\",\"session_id\":\"seed0001\"$2}" >/dev/null; }
hook SessionStart ''
hook PreToolUse ",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$R/pkg/m.py\",\"old_string\":\"x * 2\",\"new_string\":\"x + x\"}}"
sed -i.bak -e 's/return x + 1/return 1 + x/' -e 's/return x \* 2/return x + x/' "$R/pkg/m.py" && rm "$R/pkg/m.py.bak"
hook PostToolUse ",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$R/pkg/m.py\"},\"tool_response\":{}"
echo "== claim_done (agent claude-seed000, run $RUN)"
CLAIM="$(curl -s -X POST "$URL/mcp/claim_done" -H 'content-type: application/json' -d "{\"cwd\":\"$R\",\"args\":{\"task\":\"seed\"}}")"
echo "$CLAIM"
echo "== loom verify"
set +e; (cd "$R" && node "$LOOM/packages/cli/dist/loom.cjs" verify); V=$?; set -e
echo "loom verify exit $V"
echo "$CLAIM" | grep -q '"blindSpots":\["pkg/m.py::g"\]' && [ "$V" = 1 ] && echo "PASS: blind spot g named" || { echo "FAIL"; exit 1; }
