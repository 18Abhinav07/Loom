#!/usr/bin/env bash
# Usage: bench/scripts/live_demo.sh [instance-id]   (daemon must be running: pnpm daemon)
set -euo pipefail
cd "$(dirname "$0")/.."
IID="${1:-slugify__signature}"
eval "$(.venv/bin/python - "$IID" <<'EOF'
import sys, shlex, tempfile
from pathlib import Path
from e1.instances import load_instances
from e1.django_ws import make_worktree
from e1.live import LiveRun
from e1.agent_b import build_prompt
inst = {i.id: i for i in load_instances()}[sys.argv[1]]
scratch = Path(tempfile.mkdtemp(prefix="loom-demo-"))
wt = make_worktree(inst.base_commit, scratch / "b")
env = LiveRun(inst, "demo", wt, scratch, a_at="edit").start_detached()
for k, v in env.items():
    print(f"export {k}={shlex.quote(v)}")
print(f"export WT={shlex.quote(str(wt))}")
print(f"export PROMPT={shlex.quote(build_prompt(inst, None))}")
EOF
)"
echo "B worktree: $WT"
echo "After B's first edit, Loom lands agent A's change and B gets a [loom] notice on its next tool call."
cd "$WT" && claude --setting-sources project "$PROMPT"
