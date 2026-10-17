"""E5 scenarios as team plan files (bench/plans/<id>.md): `loom run --plan` reads them, so both arms start from the same file.

The front matter is JSON (valid YAML), written once from scenarios.py. `owns` is the plan's claim: the scenario's scope, plus for an
agent with none the new symbol or file it creates, so the checker (two unordered tasks may not own the same thing) accepts a plan
whose agents all start at once. The target repo is the caller's cwd, not a field of the plan.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from e5.scenarios import SCENARIOS, Scenario

PLAN_IDS = ["t1_slugpath", "x1_textlist", "f1_oldcall"]
TEXT, FILTERS = "django/utils/text.py", "django/template/defaultfilters.py"
NEW = {   # what a scope-less agent adds
    ("t1_slugpath", "b"): [f"{TEXT}::slugify_unique"], ("t1_slugpath", "c"): ["django/utils/slugpath.py"],
    ("x1_textlist", "b"): [f"{TEXT}::format_count_list", f"{FILTERS}::joinlist"],
    ("x1_textlist", "c"): ["django/contrib/admin/models.py::get_change_message"],
    ("f1_oldcall", "c"): ["django/utils/slugpath.py"],
}


def plan_md(sc: Scenario) -> str:
    from e5.run import PY, prompt_for   # run.py imports PLAN_IDS from here
    fm = {"goal": sc.brief or f"E5 {sc.id}: " + "; ".join(a.title for a in sc.agents),
          "test": f"PYTHONPATH=. {PY} tests/runtests.py {' '.join(sc.tests)} --parallel 1",
          "tasks": [{"id": a.id, "title": a.title, "owns": list(a.scope) or NEW[(sc.id, a.id)], "after": [],
                     "done": f"{a.title} works as described and the tests pass", "prompt": prompt_for(sc, a)} for a in sc.agents]}
    return f"---\n{json.dumps(fm, indent=2)}\n---\nGenerated from bench/e5/scenarios.py by bench/e5/plans.py; do not edit.\n"


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "plans")
    out.mkdir(parents=True, exist_ok=True)
    for sid in PLAN_IDS:
        (out / f"{sid}.md").write_text(plan_md(next(s for s in SCENARIOS if s.id == sid)))


if __name__ == "__main__":
    main()
