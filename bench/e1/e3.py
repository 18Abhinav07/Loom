"""E3 notice precision from live records → bench/results/e3.json (spec §8 E3).

precision = delivered notices on the instance's helper symbol whose blind twin interfered ÷ delivered notices.
Notices of a live record without a blind twin are counted as no_twin and left out of both.
notices per agent-hour = delivered ÷ (Σ live b_seconds / 3600).
Usage: python -m e1.e3 --records runs/e1/<dir> [--out results/e3.json]
"""
import argparse
import json
from pathlib import Path

from .report import RESULTS, load


def e3(records: list[dict], helper_of: dict[str, str]) -> dict:
    ok = [r for r in records if r.get("b_ok")]
    blind = {(r["id"], r["trial"]): r for r in ok if r["cond"] == "blind"}
    live = [r for r in ok if r["cond"] == "live"]
    delivered = precise = no_twin = 0
    for r in live:
        twin = blind.get((r["id"], r["trial"]))
        for n in r.get("notices") or []:
            if n.get("deliveredAt") is None:
                continue
            if not twin:                     # nothing to judge the notice against: counted, never scored
                no_twin += 1
                continue
            delivered += 1
            precise += bool(f":{helper_of.get(r['id'], chr(0))}:" in n["id"] and twin["interference"])
    hours = sum(r["b_seconds"] for r in live) / 3600
    return {"delivered": delivered, "precise": precise, "precision": round(precise / delivered, 3) if delivered else None,
            "agent_hours": round(hours, 3), "notices_per_agent_hour": round(delivered / hours, 2) if hours else None, "n_live": len(live), "no_twin": no_twin}


def main() -> None:
    from .instances import load_instances
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=RESULTS / "e3.json")
    a = ap.parse_args()
    helper_of = {i.id: f"{i.module_path}::{i.func}" for i in load_instances()}
    out = {**e3(load(a.records), helper_of), "records": str(a.records)}
    a.out.write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
