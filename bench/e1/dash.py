"""Shows a benchmark pair on the dashboard as a team (A and B cards, verdict), like the demo teams.

The daemon lists every .loom/teams/<id>.json in the repo; a file rewritten in the last 20s counts as running.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .instances import Instance


class Show:
    def __init__(self, repo: Path | None, inst: Instance, cond: str, tag: str):
        self.f = None
        if repo is None:
            return
        d = repo / ".loom" / "teams"
        d.mkdir(parents=True, exist_ok=True)
        self.f = d / f"sb-{tag}.json"
        self.v = {"id": f"sb-{tag}", "plan": f"sb-{inst.id}", "repo": str(repo), "leadSid": None, "person": "stalebench",
                  "goal": f"StaleBench {inst.id}: A {inst.mechanism}s {inst.func} (scripted), B builds on it (a real agent)",
                  "landed": "", "state": "running", "startedAt": int(time.time() * 1000), "blind": cond == "blind", "events": [],
                  "agents": [self._ag("a", f"A (scripted): {inst.mechanism} {inst.func}", "pending", []),
                             self._ag("b", f"B: {inst.task_b[:60]}", "pending", [])]}
        self.write()
        self._stop = threading.Event()
        threading.Thread(target=self._beat, daemon=True).start()   # keeps the file fresh, so the dashboard shows the pair as running

    def _beat(self) -> None:
        while not self._stop.wait(5):
            self.write()

    @staticmethod
    def _ag(i: str, title: str, state: str, lands: list[str], reply: str = "") -> dict:
        return {"id": i, "title": title, "state": state, "after": [], "sid": "", "worktree": "", "branch": "", "lands": lands,
                "resumed": 0, "lastReply": reply}

    def write(self) -> None:
        if self.f:
            self.f.write_text(json.dumps(self.v))

    def set(self, agent: str, state: str, reply: str | None = None, lands: list[str] | None = None, resumed: int | None = None) -> None:
        if not self.f:
            return
        a = next(x for x in self.v["agents"] if x["id"] == agent)
        a["state"] = state
        if reply is not None:
            a["lastReply"] = reply
        if lands is not None:
            a["lands"] = lands
        if resumed is not None:
            a["resumed"] = resumed
        self.write()

    def done(self, passed: bool, out: str, notices: list[str]) -> None:
        if not self.f:
            return
        self._stop.set()
        self.v["state"] = "done"
        self.v["result"] = {"pass": passed, "out": out[-600:]}
        self.v["events"] = [{"id": f"n{i}", "kind": "notice", "region": [], "parties": [], "outcome": "delivered",
                             "at": int(time.time() * 1000), "detail": t[:300]} for i, t in enumerate(notices)]
        self.write()
