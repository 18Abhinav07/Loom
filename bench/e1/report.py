"""E1 report: records.jsonl → bench/results/e1.json, one row per condition (spec §8 E1).

Only records whose B session finished (b_ok) count; the rest are reported as `excluded`, never graded as failures.
Usage: python -m e1.report --records runs/e1/<dir> [--out results/e1.json]
"""
import argparse
import json
import re
from pathlib import Path

RESULTS = Path(__file__).resolve().parent.parent / "results"


def load(records_dir: Path) -> list[dict]:
    return [json.loads(l) for l in (records_dir / "records.jsonl").read_text().splitlines() if l.strip()]


def report(records: list[dict]) -> dict:
    ok = [r for r in records if r.get("b_ok")]
    conds: dict[str, dict] = {}
    for cond in ("blind", "oracle", "live"):
        rs = [r for r in ok if r["cond"] == cond]
        if not rs:
            continue
        n = len(rs)
        conds[cond] = {"n": n, "solo_pass": sum(bool(r["solo_pass"]) for r in rs), "merged_pass": sum(bool(r["merged_pass"]) for r in rs),
                       "interference": sum(r["interference"] for r in rs), "interference_rate": round(sum(r["interference"] for r in rs) / n, 3),
                       "mean_b_seconds": round(sum(r["b_seconds"] for r in rs) / n, 1), "cost_usd": round(sum(r["cost_usd"] or 0 for r in rs), 4)}
    base = conds.get("blind", {}).get("interference_rate")
    for c in conds.values():
        c["delta_vs_blind"] = None if base is None else round(c["interference_rate"] - base, 3)
    return {"conds": conds, "excluded": len(records) - len(ok), "instances": len({r["id"] for r in ok})}


CHANGE = {"signature": "adds a required `strict` argument", "rename": "renames it (old name gone)",
          "rettype": "changes what it returns"}


def _err_line(text: str) -> str:
    """The line a person reads first: the last `...Error: ...` line, else the last non-empty one."""
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    errs = [l for l in lines if re.match(r"^[\w.]*(Error|Exception)\b.*:", l)]
    return (errs or lines or [""])[-1]


def _lane(r: dict | None) -> dict | None:
    if r is None:
        return None
    lane = {"broke": not r["merged_pass"], "seconds": r["b_seconds"]}
    if r["merged_pass"]:
        m = re.search(r"Ran \d+ tests?", r.get("merge_err") or "")
        lane["passed"] = m.group(0) if m else "tests pass"
    else:
        lane["error"] = _err_line(r.get("merge_err") or "")
    if r["cond"] == "live":
        got = sorted((n for n in r.get("notices") or [] if n.get("deliveredAt") and n.get("at")), key=lambda n: n["deliveredAt"])
        a = r.get("a_landed_s")
        lane["a_changed_s"] = a
        # the notice is created when A's change lands, so told = landed + (delivered - created)
        lane["told_s"] = round(a + (got[0]["deliveredAt"] - got[0]["at"]) / 1000, 1) if got and a is not None else None
        if got:
            lane["notice"] = (got[0].get("text") or "").splitlines()[0] if got[0].get("text") else ""
    return lane


def story(records: list[dict]) -> dict:
    """One entry per task pair, blind and live side by side: what the Story screen draws (spec-presentation §7)."""
    ok = [r for r in records if r.get("b_ok")]
    pairs = []
    for pid in sorted({r["id"] for r in ok}):
        first = lambda cond: next((r for r in sorted(ok, key=lambda r: r.get("trial", 0)) if r["id"] == pid and r["cond"] == cond), None)
        func, _, mech = pid.partition("__")
        pairs.append({"id": pid, "func": func, "mech": mech, "change": CHANGE.get(mech, mech), "blind": _lane(first("blind")), "live": _lane(first("live"))})
    return {"pairs": pairs, "model": next((r.get("model") for r in ok if r.get("model")), None)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=RESULTS / "e1.json")
    a = ap.parse_args()
    out = {**report(load(a.records)), "records": str(a.records)}
    a.out.write_text(json.dumps(out, indent=2) + "\n")
    (a.out.parent / "e1-story.json").write_text(json.dumps({**story(load(a.records)), "records": str(a.records)}, indent=2) + "\n")
    print(json.dumps(out["conds"], indent=2))


if __name__ == "__main__":
    main()
