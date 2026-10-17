"""E5 driver: python -m e5.run --set pilot --conds blind,loom [--skip-done DIR]

Each scenario runs once per condition through the real product path, `loom run --plan` (blind = `--blind`):
every agent is a real `claude -p --model sonnet`, all launched at the same time in their own worktrees.
Grading: each agent's oracle on its own commit (solo) and on the merged tree; broken = solo pass, merged fail.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

from e1.django_ws import BENCH, MIRROR, ensure_mirror

from .plans import PLAN_IDS
from .scenarios import COMPLEX, FAULT, PILOT, RULES, SCENARIOS, TEAM, Agent, Scenario

ROOT = BENCH.parent
CLI = ROOT / "packages" / "cli" / "dist" / "loom.cjs"
RUNS = BENCH / "runs" / "e5"
PY = sys.executable
LOOM_URL = os.environ.get("LOOM_URL", "http://127.0.0.1:4318")

ORACLE = textwrap.dedent('''\
    import importlib, sys, unittest
    try:
        import django
        from django.conf import settings
        settings.configure(USE_I18N=False, INSTALLED_APPS={apps!r})
        django.setup()
    except Exception:
        pass
    m = importlib.import_module("django.utils.text")
    class T(unittest.TestCase):
        def test_oracle(self):
    {body}
    r = unittest.TextTestRunner(verbosity=0, stream=sys.stdout).run(unittest.defaultTestLoader.loadTestsFromTestCase(T))
    sys.exit(0 if r.wasSuccessful() else 1)
''')


def _git(*a: str, cwd: Path | None = None, check: bool = True) -> str:
    return subprocess.run(["git", *a], cwd=cwd, check=check, capture_output=True, text=True).stdout.strip()


def prompt_for(sc: Scenario, a: Agent) -> str:
    """Team scenarios brief every agent on the whole feature and everyone's part (both conditions); the rest is the task."""
    if not sc.brief:
        return a.prompt
    team = "\n".join(f"- agent {o.id}, {o.title}: {o.prompt}" for o in sc.agents)
    return (f"{sc.brief}\n\nThe team, all working at the same time in separate checkouts that are merged when everyone "
            f"finishes:\n{team}\n\nYou are agent {a.id}. Do your part ({a.title}) so it works with the others' parts. {RULES}")


def plan_for(sc: Scenario, repo: Path) -> dict:
    return {"repo": str(repo), "test": f"PYTHONPATH=. {PY} tests/runtests.py {' '.join(sc.tests)} --parallel 1",
            "tasks": [{"id": a.id, "title": a.title, "prompt": prompt_for(sc, a), "scope": list(a.scope)} for a in sc.agents]}


def check(tree: Path, agent: Agent, apps: tuple[str, ...] = ()) -> tuple[bool, str]:
    """Agent's oracle against a source tree: (passed, error tail)."""
    code = ORACLE.format(body=textwrap.indent(agent.oracle, " " * 8), apps=list(apps))
    p = subprocess.run([PY, "-c", code], cwd=tree, capture_output=True, text=True, timeout=120,
                       env={**os.environ, "PYTHONPATH": str(tree), "PYTHONDONTWRITEBYTECODE": "1"})
    return (True, "") if p.returncode == 0 else (False, (p.stdout + p.stderr)[-600:])


def make_repo(base: str, dest: Path) -> Path:
    ensure_mirror()
    _git("clone", "-q", "--shared", "--no-checkout", str(MIRROR), str(dest))
    _git("checkout", "-q", "--detach", base, cwd=dest)
    (dest / ".loom").mkdir(exist_ok=True)
    (dest / ".loom" / "config.json").write_text(json.dumps({"dirs": ["django"]}))
    return dest


def _get(path: str):
    with urllib.request.urlopen(LOOM_URL + path, timeout=30) as r:
        return json.loads(r.read())


def _transcript_stats(f: Path) -> dict:
    cost, turns, denied, handovers, limit = 0.0, 0, 0, 0, False
    if f.exists():
        for line in f.read_text().splitlines():
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            if m.get("type") == "result":
                cost += m.get("total_cost_usd") or 0
                turns += m.get("num_turns") or 0
                limit = limit or "limit" in str(m.get("result", "")).lower() and bool(m.get("is_error"))
            content = (m.get("message") or {}).get("content") if isinstance(m.get("message"), dict) else None
            for c in content if isinstance(content, list) else []:   # what the agent saw back from a tool call Loom gated
                t = str(c.get("content", "")) if c.get("type") == "tool_result" else ""
                denied += "[loom] edit blocked" in t
                handovers += "[loom]" in t and "your file now contains it" in t
    return {"cost_usd": round(cost, 4), "turns": turns, "denied": denied, "handovers": handovers, "limit": limit}


def from_team(repo: Path, team: dict, test_cmd: str) -> dict:
    """The daemon's TeamView in the shape grade() reads: a worktree of the landed branch is the merged tree, and the plan's test runs on it here."""
    id8 = team["id"][-8:].lower()
    tree = repo / ".loom" / "wt" / id8 / "_merge"
    tip = lambda b: _git("rev-parse", "--verify", "-q", b, cwd=repo, check=False)
    ok = False
    tail = ""
    if tip(team["landed"]):
        tree.parent.mkdir(parents=True, exist_ok=True)
        _git("worktree", "add", "-q", "--detach", str(tree), team["landed"], cwd=repo)
        p = subprocess.run(test_cmd, shell=True, cwd=tree, env=agent_env(os.environ), capture_output=True, text=True)
        ok, tail = p.returncode == 0, p.stdout + p.stderr
    return {"run": team["id"], "merge": {"conflict": False, "testsPassed": ok, "testOutputTail": tail},
            "workers": [{"agent": a["id"], "exit": 0 if a["state"] == "landed" else 1, "commit": tip(a["branch"]) if a["state"] == "landed" else "",
                         "resumed": a["resumed"], "lands": a["lands"]} for a in team["agents"]]}


def agent_env(base) -> dict:
    """Worker env: subscription only (no ANTHROPIC_*), the bench venv's python, imports from the worktree."""
    env = {k: v for k, v in base.items() if not k.startswith("ANTHROPIC_")}   # subscription, never a paid key
    env["PATH"] = f"{Path(PY).parent}:{env['PATH']}"
    env["PYTHONPATH"] = "."                     # workers run in their worktree; `python ...` alone is allowlisted
    return env


def archive(repo: Path, run: str, base: str, out: Path, tag: str) -> None:
    """Keep the evidence (agent transcripts, every Loom branch as a diff from base), then drop the clone: ~0.5 GB each."""
    tdir = repo / ".git" / "loom" / "runs" / run[-8:].lower()   # daemon-owned teams keep traces under the git dir
    if tdir.exists():
        shutil.copytree(tdir, out / "transcripts" / tag, dirs_exist_ok=True)
    ddir = out / "diffs" / tag
    ddir.mkdir(parents=True, exist_ok=True)
    for b in _git("for-each-ref", "--format=%(refname:short)", "refs/heads/loom/", cwd=repo).split():
        (ddir / f"{b.replace('/', '_')}.diff").write_text(_git("diff", base, b, cwd=repo))
    shutil.rmtree(repo)


def run_cond(sc: Scenario, cond: str, out: Path, model: str, keep: bool = False, rep: int = 0) -> dict:
    tag = f"{sc.id}__{cond}" + (f"__r{rep}" if rep else "")
    repo = make_repo(sc.base, out / "repos" / tag)
    plan_f = BENCH / "plans" / f"{sc.id}.md"   # generated by e5/plans.py; the same file feeds both arms
    if not plan_f.exists():
        raise SystemExit(f"no plan file for {sc.id}: counted scenarios are {', '.join(PLAN_IDS)}")
    rep_f = out / "reports" / f"{tag}.json"
    env = agent_env(os.environ)
    cmd = ["node", str(CLI), "run", "--plan", str(plan_f), "--model", model, "--report", str(rep_f)] + (["--blind"] if cond == "blind" else []) \
        + (["--claude", os.environ["E5_CLAUDE"]] if os.environ.get("E5_CLAUDE") else [])   # plumbing dry runs only
    t0 = time.time()
    p = subprocess.run(cmd, cwd=repo, env=env, capture_output=True, text=True)
    wall = round(time.time() - t0, 1)
    (out / "logs").mkdir(exist_ok=True)
    (out / "logs" / f"{tag}.cli.txt").write_text(p.stdout + p.stderr)
    report = from_team(repo, json.loads(rep_f.read_text()), plan_for(sc, repo)["test"])
    r = {**grade(sc, cond, repo, report, wall), "rep": rep}
    if not keep:
        archive(repo, report["run"], sc.base, out, tag)
    return r


def verdict(conflict, tests_passed, merged: dict, integration) -> dict:
    """Judged on the run's full final merge only: with a conflict nothing merged, so every agent failed."""
    failed = sorted(merged) if conflict else sorted(k for k, ok in merged.items() if not ok)
    return {"agents_ok": len(merged) - len(failed), "failed": failed,
            "all_pass": not conflict and bool(tests_passed) and not failed and integration is not False}


def grade(sc: Scenario, cond: str, repo: Path, rep: dict, wall: float) -> dict:
    run = rep["run"]
    run8 = run[-8:].lower()
    merged_tree = repo / ".loom" / "wt" / run8 / "_merge"   # v1: the end merge of every branch; v2: a worktree of the landed branch
    tdir = repo / ".git" / "loom" / "runs" / run8.lower()
    workers = {w["agent"]: w for w in rep["workers"]}
    notices = _get(f"/runs/{urllib.parse.quote(run, safe='')}/notices") if cond == "loom" else []
    agents = {}
    for a in sc.agents:
        w = workers[a.id]
        solo = None
        if not a.needs and w.get("commit"):
            st = repo / ".loom" / "solo" / a.id
            _git("worktree", "add", "-q", "--detach", str(st), w["commit"], cwd=repo)
            solo = check(st, a, sc.apps)[0]
            _git("worktree", "remove", "--force", str(st), cwd=repo, check=False)
        merged, err = check(merged_tree, a, sc.apps)
        mine = [n for n in notices if n.get("agent") == a.id]
        agents[a.id] = {"exit": w["exit"], "commit": bool(w.get("commit")), "resumed": w.get("resumed", 0), "lands": w.get("lands", []),
                        "solo": solo, "merged": merged, "err": err[-300:],
                        "notices": len(mine), "delivered": sum(n.get("deliveredAt") is not None for n in mine),
                        **_transcript_stats(tdir / f"{a.id}.jsonl")}
    conflict = rep["merge"]["conflict"]
    integ = check(merged_tree, Agent("integration", "", "", sc.integration), sc.apps) if sc.integration and not conflict else (None, "")
    return {"scenario": sc.id, "kind": sc.kind, "cond": cond, "run": run, "wall_s": wall,
            "conflict": conflict, "tests_passed": rep["merge"]["testsPassed"],
            "integration": integ[0] if sc.integration else None, "integration_err": integ[1][-300:],
            **verdict(conflict, rep["merge"]["testsPassed"], {k: x["merged"] for k, x in agents.items()}, integ[0]),
            "broken": sum(1 for x in agents.values() if x["solo"] and not x["merged"]),
            "agents": agents, "tests_tail": rep["merge"]["testOutputTail"][-600:]}


def summarize(recs: list[dict]) -> str:
    by = defaultdict(list)
    for r in recs:
        by[r["cond"]].append(r)
    # blind = the same briefed team without Loom
    lines = ["cond   n  all_pass  agents_ok  broken  conflicts  wall_s  cost_usd  turns  integration"]
    for cond in ("blind", "loom"):
        rs = by.get(cond, [])
        if not rs:
            continue
        ag = [x for r in rs for x in r["agents"].values()]
        lines.append(f"{cond:6} {len(rs)}  {sum(r['all_pass'] for r in rs)}/{len(rs)}  "
                     f"{sum(verdict(r['conflict'], True, {k: x['merged'] for k, x in r['agents'].items()}, None)['agents_ok'] for r in rs)}/{len(ag)}  {sum(r['broken'] for r in rs)}  "
                     f"{sum(bool(r['conflict']) for r in rs)}  {sum(r['wall_s'] for r in rs):.0f}  "
                     f"{sum(x.get('cost_usd', 0) for x in ag):.2f}  {sum(x.get('turns', 0) for x in ag)}  "
                     f"{sum(bool(r.get('integration')) for r in rs if r.get('integration') is not None)}"
                     f"/{sum(r.get('integration') is not None for r in rs)}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="pilot")
    ap.add_argument("--conds", default="blind,loom")
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--skip-done", type=Path, default=None)
    ap.add_argument("--reps", type=int, default=1, help="runs per scenario and condition; conditions alternate inside each rep")
    ap.add_argument("--keep-repos", action="store_true", help="keep each scenario's clone (~0.5 GB) instead of archiving it")
    a = ap.parse_args()
    out = (a.skip_done or RUNS / dt.datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()   # the CLI runs inside the scenario repo
    out.mkdir(parents=True, exist_ok=True)
    rec_f = out / "records.jsonl"
    recs = [json.loads(l) for l in rec_f.read_text().splitlines()] if rec_f.exists() else []
    done = {(r["scenario"], r["cond"], r.get("rep", 0)) for r in recs}
    ids = {"pilot": PILOT, "team": TEAM, "complex": COMPLEX, "fault": FAULT, "all": [s.id for s in SCENARIOS]}.get(a.set) or a.set.split(",")
    for sc, rep, cond in ((s, i, c) for s in SCENARIOS if s.id in ids for i in range(a.reps) for c in a.conds.split(",")):
            if (sc.id, cond, rep) in done:
                continue
            r = run_cond(sc, cond, out, a.model, a.keep_repos, rep)
            if any(x["limit"] for x in r["agents"].values()):
                print(f"usage limit reached; continue with --skip-done {out}")
                raise SystemExit(3)
            recs.append(r)
            with open(rec_f, "a") as f:
                f.write(json.dumps(r) + "\n")
            print(f"{sc.id:12} {cond:5} r{rep} all_pass={r['all_pass']!s:5} broken={r['broken']} conflict={r['conflict']} "
                  + " ".join(f"{k}:{'ok' if v['merged'] else 'FAIL'}" for k, v in r["agents"].items()) + f" {r['wall_s']}s", flush=True)
    print(summarize(recs))
    print(f"records: {rec_f}")


if __name__ == "__main__":
    main()
