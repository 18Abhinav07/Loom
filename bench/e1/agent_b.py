"""Agent B = Claude Code headless in its own Django worktree."""
from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from .instances import Instance

TASK = (
    "Task: in `{path}` of this Django checkout, {task}\n\n"
    "Rules: do not modify anything under tests/. Keep the change minimal. You may run small python "
    "snippets (PYTHONPATH=.) to check your work; do not run the full Django test suite."
)
ORACLE = (
    "Another agent is changing this repository in parallel, and their change will be merged together with "
    "yours: {msg} Your checkout does not contain their change yet; write your code so it works once both "
    "changes are merged.\n\n"
)


def build_prompt(inst: Instance, oracle: str | None) -> str:
    body = TASK.format(path=inst.module_path, task=inst.task_b)
    return (ORACLE.format(msg=oracle) if oracle else "") + body


@dataclass
class RunLog:
    exit_code: int
    transcript: Path
    seconds: float
    cost_usd: float | None
    session_id: str | None = None


def run_b(wt: Path, prompt: str, *, model: str, env: dict[str, str], log: Path, timeout: int = 900,
          resume: str | None = None) -> RunLog:
    cmd = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--model", model,
           "--permission-mode", "bypassPermissions", "--max-turns", "40", "--setting-sources", "project"]
    if resume:
        cmd += ["--resume", resume]  # verified 2026-10-13: same session id, UserPromptSubmit context injected
    log.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with open(log, "w") as out:
        try:
            # stdin=DEVNULL: without it `claude -p` waits 3 s for stdin on every run (verified)
            p = subprocess.run(cmd, cwd=wt, env=env, stdin=subprocess.DEVNULL, stdout=out,
                               stderr=subprocess.STDOUT, timeout=timeout)
            code = p.returncode
        except subprocess.TimeoutExpired:
            code = -9
    cost, sid = None, None
    for line in log.read_text().splitlines():
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue
        if m.get("type") == "result":
            cost, sid = m.get("total_cost_usd"), m.get("session_id")
    return RunLog(code, log, time.time() - t0, cost, sid)
