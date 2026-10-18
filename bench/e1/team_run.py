"""StaleBench pairs as real teams: A and B are both real agents run by the Loom team engine, so each pair
shows on the dashboard like the demo does (agent cards, Team page, Without Loom page).

This is a different experiment from the pre-registered E1 (scripted A, offline grading): here A is a live
agent and the verdict is the team's own test run on the landed branch. Records go to bench/runs/e6/.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from .amech import RENAME_SUFFIX, describe_change
from .django_ws import MIRROR, ORACLE, ensure_mirror
from .instances import CORE, load_instances

BENCH = Path(__file__).resolve().parents[1]
REPO = BENCH / "cache" / "team_repo"
API = "http://127.0.0.1:4318"


def sh(*a: str, cwd: Path = REPO, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(a, cwd=cwd, capture_output=True, text=True, check=check)


def ensure_repo() -> Path:
    """One persistent Django checkout, so the dashboard's repo (?cwd=) never changes between pairs."""
    ensure_mirror()
    if not (REPO / ".git").exists():
        REPO.parent.mkdir(parents=True, exist_ok=True)
        sh("git", "clone", "-q", "--shared", "--no-checkout", str(MIRROR), str(REPO), cwd=REPO.parent)
    venv = REPO / ".loom" / "venv"
    if not venv.exists():
        venv.parent.mkdir(parents=True, exist_ok=True)
        sh(sys.executable, "-m", "venv", str(venv))
        sh(str(venv / "bin" / "pip"), "install", "-q", "asgiref>=3.8", "sqlparse>=0.5")
    return REPO


def a_task(inst) -> str:
    """Natural-language task for the agent making the breaking change."""
    what = describe_change(inst, REPO)
    return (f"{what} Make that change in {inst.module_path} and update every caller in django/ so nothing breaks. "
            f"Run `python tests/runtests.py {inst.module_test} --parallel 1` before you finish.")


def new_func(inst) -> str:
    m = re.search(r"`(\w+)\(", inst.task_b)
    return m.group(1) if m else inst.func + "_new"


def make_plan(inst, py: str) -> dict:
    oracle = REPO / ".loom" / f"oracle_{inst.id}.py"
    oracle.write_text(ORACLE.format(oracle=inst.oracle_test))
    test = (f"PYTHONPATH=. {py} {oracle} {inst.module} && "
            f"PYTHONPATH=. {py} tests/runtests.py {inst.module_test} --parallel 1 -v 0 2>&1 | tail -15")
    return {
        "goal": f"StaleBench {inst.id}: a changes {inst.func} ({inst.mechanism}) while b builds on it",
        "test": test,
        "tasks": [
            {"id": "a", "title": f"{inst.mechanism} {inst.func}", "owns": [f"{inst.module_path}::{inst.func}"],
             "after": [], "done": f"{inst.func} changed and callers updated", "prompt": a_task(inst)},
            {"id": "b", "title": new_func(inst), "owns": [f"{inst.module_path}::{new_func(inst)}"],
             "after": [], "done": f"{new_func(inst)} added and working", "prompt": inst.task_b},
        ],
    }


def get(path: str):
    with urllib.request.urlopen(f"{API}{path}{'&' if '?' in path else '?'}cwd={REPO}", timeout=30) as r:
        return json.load(r)


def run_pair(inst, blind: bool, model: str, py: str) -> dict:
    sh("git", "checkout", "-q", "-f", inst.base_commit)
    sh("git", "clean", "-fdxq", "-e", ".loom")
    sh("git", "branch", "-q", "-f", "main", inst.base_commit, check=False)
    plan = make_plan(inst, py)
    pdir = REPO / ".loom" / "plans"
    pdir.mkdir(parents=True, exist_ok=True)
    slug = f"sb-{inst.id}"
    (pdir / f"{slug}.md").write_text("---\n" + json.dumps(plan, indent=2) + "\n---\n")
    t0 = time.time()
    cmd = ["loom", "team", "start", slug, "--model", model, "--wait"] + (["--blind"] if blind else [])
    p = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=3600)
    team = next((t for t in get("/teams") if t.get("plan") == slug), None) or {}
    out = (team.get("result") or {}).get("out", "")
    ag = team.get("agents", [])
    return {"id": inst.id, "mech": inst.mechanism, "cond": "blind" if blind else "live", "team": team.get("id"),
            "pass": bool((team.get("result") or {}).get("pass")), "state": team.get("state"),
            "landed": sum(1 for a in ag if a.get("state") == "landed"), "agents": len(ag),
            "resumed": sum(int(a.get("resumed") or 0) for a in ag), "seconds": round(time.time() - t0),
            "out": out[-600:], "exit": p.returncode}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="core")
    ap.add_argument("--conds", default="blind,live")
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    ensure_repo()
    py = str(REPO / ".loom" / "venv" / "bin" / "python")
    insts = [i for i in load_instances() if (a.set == "all" or i.id in CORE) and (not a.only or a.only in i.id)]
    insts.sort(key=lambda i: CORE.index(i.id) if i.id in CORE else 99)
    out = BENCH / "runs" / "e6" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    sh("loom", "init", "--no-lead")
    sh("loom", "ui", "--no-open")
    print(f"watch it live: http://localhost:4317/?cwd={REPO}  (Team tab = with Loom, Without Loom tab = blind)", flush=True)
    for inst in insts:
        for cond in a.conds.split(","):
            r = run_pair(inst, cond == "blind", a.model, py)
            with open(out / "records.jsonl", "a") as f:
                f.write(json.dumps(r) + "\n")
            print(f"{inst.id:34s} {cond:6s} {'PASS' if r['pass'] else 'FAIL'} landed {r['landed']}/{r['agents']} {r['seconds']}s", flush=True)
    print(f"records: {out}/records.jsonl")
    return 0


if __name__ == "__main__":
    sys.exit(main())
