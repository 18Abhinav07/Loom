"""E1 driver: python -m e1.run --conds blind,oracle --set pilot --trials 1 --model sonnet"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from collections import defaultdict
from pathlib import Path

from .agent_b import build_prompt, run_b
from .amech import describe_change
from .django_ws import BENCH, diff, make_worktree, remove_worktree
from .grade import grade
from .instances import CORE, PILOT, Instance, load_instances

RUNS = BENCH / "runs" / "e1"
RESUME_PROMPT = "Continue. Check any [loom] notices in your context and make sure your change still fits; then finish."


def select(which: str) -> list[Instance]:
    insts = load_instances()
    if which == "all":
        return insts
    ids = {"pilot": PILOT, "core": CORE}.get(which) or which.split(",")
    by_id = {i.id: i for i in insts}
    return [by_id[i] for i in ids]


def run_one(inst: Instance, cond: str, trial: int, model: str, out_dir: Path, a_at: str = "edit") -> dict:
    tag = f"{inst.id}__{cond}__{trial}"
    scratch = out_dir / "wt" / tag
    wt_b = make_worktree(inst.base_commit, scratch / "b")
    # Subscription-only: B must run on the claude.ai login, never on a pay-per-token key that happens to be set.
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    live = None
    (wt_b / ".claude").mkdir(exist_ok=True)
    (wt_b / ".claude" / "settings.json").write_text("{}")
    try:
        oracle = describe_change(inst, wt_b) if cond == "oracle" else None
        if cond == "live":
            from .live import LiveRun  # Task 12
            live = LiveRun(inst, tag, wt_b, scratch, a_at=a_at)
            env.update(live.start())
        log = run_b(wt_b, build_prompt(inst, oracle), model=model, env=env, log=out_dir / "logs" / f"{tag}.jsonl")
        resumed = False
        if live and live.needs_resume() and log.session_id:
            # Barrier wake-up (spec §5.6): A's change reached the graph after B's last turn; resume B once.
            # The UserPromptSubmit hook delivers the pending notices; the prompt itself carries no content.
            r2 = run_b(wt_b, RESUME_PROMPT, model=model, env=env, log=out_dir / "logs" / f"{tag}.resume.jsonl",
                       resume=log.session_id)
            log.cost_usd = (log.cost_usd or 0) + (r2.cost_usd or 0)
            log.seconds += r2.seconds
            resumed = True
        extra = {**live.finish(), "resumed": resumed} if live else {}
        g = grade(inst, diff(wt_b), scratch)
        rec = {"id": inst.id, "mech": inst.mechanism, "cond": cond, "trial": trial, "model": model,
               "solo_pass": g.solo_pass, "textual_conflict": g.textual_conflict, "merged_pass": g.merged_pass,
               "interference": g.interference, "solo_err": g.solo_err[-300:], "merge_err": g.merge_err[-300:],
               "b_exit": log.exit_code, "b_ok": log.exit_code == 0 and log.session_id is not None,
               "b_seconds": round(log.seconds, 1), "cost_usd": log.cost_usd,
               "transcript": str(log.transcript), **extra}
    finally:
        if live:
            live.close()
        remove_worktree(wt_b)
    return rec


def summarize(records: list[dict]) -> str:
    by = defaultdict(list)
    for r in records:
        by[r["cond"]].append(r)
    lines = ["cond     n  solo_pass  merged_pass  interference  cost$"]
    for cond in ("blind", "oracle", "live"):
        rs = by.get(cond, [])
        if not rs:
            continue
        cost = sum(r["cost_usd"] or 0 for r in rs)
        lines.append(f"{cond:7} {len(rs):2}  {sum(r['solo_pass'] for r in rs):9}  "
                     f"{sum(r['merged_pass'] for r in rs):11}  {sum(r['interference'] for r in rs):12}  {cost:5.2f}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conds", default="blind,oracle")
    ap.add_argument("--set", default="pilot")
    ap.add_argument("--trials", type=int, default=1)
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--a-at", default="edit", choices=["edit", "read", "t0"])
    ap.add_argument("--skip-done", type=Path, default=None,
                    help="continue an earlier run dir: skip (id, cond, trial) already recorded with b_ok")
    a = ap.parse_args()
    out_dir = a.skip_done or RUNS / dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    rec_file = out_dir / "records.jsonl"
    recs = [json.loads(l) for l in rec_file.read_text().splitlines()] if rec_file.exists() else []
    done = {(r["id"], r["cond"], r["trial"]) for r in recs if r.get("b_ok")}
    for inst in select(a.set):
        for cond in a.conds.split(","):
            for t in range(a.trials):
                if (inst.id, cond, t) in done:
                    continue
                r = run_one(inst, cond, t, a.model, out_dir, a.a_at)
                recs.append(r)
                with open(rec_file, "a") as f:
                    f.write(json.dumps(r) + "\n")
                print(f"{r['id']:32} {cond:6} ok={r['b_ok']!s:5} solo={r['solo_pass']!s:5} "
                      f"merged={r['merged_pass']!s:5} intf={r['interference']} {r['b_seconds']}s", flush=True)
                if not r["b_ok"] and "limit" in Path(r["transcript"]).read_text()[-2000:].lower():
                    # Subscription usage window exhausted: stop cleanly; rerun later with --skip-done <out_dir>.
                    print(f"usage limit reached; continue with: python -m e1.run ... --skip-done {out_dir}")
                    raise SystemExit(3)
    print(summarize([r for r in recs if r.get("b_ok")]))
    print(f"records: {out_dir / 'records.jsonl'}")


if __name__ == "__main__":
    main()
