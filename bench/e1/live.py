"""Live condition: B runs with Loom hooks; A's change is pushed through Loom's edit path mid-run."""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .django_ws import a_patch, apply_patch, make_worktree, remove_worktree
from .instances import Instance

LOOM_URL = os.environ.get("LOOM_URL", "http://127.0.0.1:4318")
ROOT = Path(__file__).resolve().parents[2]
HOOK_CMD = f"node {ROOT / 'packages' / 'hook' / 'dist' / 'loom-hook.cjs'}"


def _post(path: str, body: dict) -> dict:
    req = urllib.request.Request(LOOM_URL + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read() or b"{}")


def _get(path: str, tries: int = 3) -> object:
    """GET with a short retry: under many parallel runs the daemon can answer 500 for a moment."""
    for i in range(tries):
        try:
            with urllib.request.urlopen(LOOM_URL + path, timeout=30) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, OSError):
            if i == tries - 1:
                raise
            time.sleep(1.0 + i)


def claude_settings() -> dict:
    h = lambda ev: [{"hooks": [{"type": "command", "command": f"{HOOK_CMD} claude {ev}", "timeout": 30}]}]
    return {"hooks": {
        "SessionStart": h("SessionStart"),
        "UserPromptSubmit": h("UserPromptSubmit"),
        "PostToolUse": [{"matcher": "*", "hooks": h("PostToolUse")[0]["hooks"]}],
        "Stop": h("Stop"),
    }}


def _patch_files(patch: str) -> list[str]:
    return [l[len("+++ b/"):] for l in patch.splitlines() if l.startswith("+++ b/")]


class LiveRun:
    def __init__(self, inst: Instance, tag: str, wt_b: Path, scratch: Path, a_at: str = "edit"):
        self.inst, self.wt_b, self.a_at = inst, wt_b, a_at
        self.run = f"coord:e1:{tag}:{int(time.time())}"
        self.wt_a = scratch / "a"
        self.a_landed_s: float | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.t0 = 0.0

    def _land_a(self) -> None:
        patch = a_patch(self.inst)
        assert apply_patch(self.wt_a, patch)
        _post("/admin/ingest", {"run": self.run, "agent": "A", "worktree": str(self.wt_a), "files": _patch_files(patch)})
        self.a_landed_s = round(time.time() - self.t0, 1)

    def _qualified(self) -> bool:
        kind = "edit" if self.a_at == "edit" else "read"
        q = {"agent": "B", "kind": kind} | ({} if kind == "edit" else {"file": self.inst.module_path})
        try:
            return bool(_get(f"/runs/{urllib.parse.quote(self.run, safe='')}/touched?{urllib.parse.urlencode(q)}")["touched"])
        except (urllib.error.URLError, OSError, KeyError, ValueError):
            return False   # a failed poll is "not yet", never a crash; the next poll or needs_resume retries

    def _trigger(self) -> None:
        while not self._stop.wait(1.0):
            if self._qualified():
                self._land_a()
                return

    def needs_resume(self) -> bool:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=300)  # a landing in progress finishes first
        if self.a_landed_s is None and self.a_at in ("edit", "read") and self._qualified():
            self._land_a()
        try:
            notices = _get(f"/runs/{urllib.parse.quote(self.run, safe='')}/notices")
        except (urllib.error.URLError, OSError, ValueError):
            return False
        return any(n["agent"] == "B" and n["status"] == "pending" for n in notices)

    def start_detached(self) -> dict[str, str]:
        env = self.start_no_trigger()
        import subprocess, sys
        # detach stdio too: an inherited stdout keeps the caller's $(...) capture open forever
        log = open(self.wt_a.parent / "trigger.log", "ab")
        subprocess.Popen([sys.executable, "-m", "e1.live_trigger", self.inst.id, self.run, str(self.wt_a)],
                         cwd=Path(__file__).resolve().parents[1], start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        return env

    def start_no_trigger(self) -> dict[str, str]:
        a_at, self.a_at = self.a_at, "manual"
        try:
            return self.start()
        finally:
            self.a_at = a_at

    def start(self) -> dict[str, str]:
        make_worktree(self.inst.base_commit, self.wt_a)
        _post("/admin/runs", {"run": self.run, "root": str(self.wt_b), "dirs": ["django"], "baseKey": self.inst.base_commit, "lessons": False})
        _post("/admin/agents", {"run": self.run, "agent": "A", "harness": "replay", "worktree": str(self.wt_a)})
        (self.wt_b / ".claude").mkdir(exist_ok=True)
        (self.wt_b / ".claude" / "settings.json").write_text(json.dumps(claude_settings(), indent=2))
        self.t0 = time.time()
        if self.a_at == "t0":
            self._land_a()
        elif self.a_at in ("edit", "read"):
            self._thread = threading.Thread(target=self._trigger, daemon=True)
            self._thread.start()
        return {"LOOM_URL": LOOM_URL, "LOOM_RUN": self.run, "LOOM_AGENT": "B"}

    def finish(self) -> dict:
        self._stop.set()
        try:
            notices = _get(f"/runs/{urllib.parse.quote(self.run, safe='')}/notices")
        except (urllib.error.URLError, OSError, ValueError):
            return False
        return {"run": self.run, "a_at": self.a_at, "a_landed": self.a_landed_s is not None, "a_landed_s": self.a_landed_s,
                "notices": notices, "notices_delivered": sum(n.get("deliveredAt") is not None for n in notices)}

    def close(self) -> None:
        self._stop.set()
        remove_worktree(self.wt_a)
