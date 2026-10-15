import pytest
from e1.instances import load_instances
from e1.django_ws import make_worktree, remove_worktree, diff
from e1.grade import grade

pytestmark = pytest.mark.django
INST = {i.id: i for i in load_instances()}

STALE_B = '''

def phone2numeric_clean(phone):
    return phone2numeric(phone.replace(" ", "").replace("-", ""))
'''
ADAPTED_B = '''

def phone2numeric_clean(phone):
    return phone2numeric(phone.replace(" ", "").replace("-", ""), strict=False)
'''


def _b_patch(inst, body, tmp):
    wt = make_worktree(inst.base_commit, tmp / "b")
    try:
        with open(wt / inst.module_path, "a") as f:
            f.write(body)
        return diff(wt)
    finally:
        remove_worktree(wt)


def test_stale_b_interferes(tmp_path):
    inst = INST["phone2numeric__signature"]
    g = grade(inst, _b_patch(inst, STALE_B, tmp_path), tmp_path)
    assert g.solo_pass and not g.textual_conflict and not g.merged_pass
    assert g.interference == 1
    assert "strict" in g.merge_err


def test_adapted_b_recovers(tmp_path):
    inst = INST["phone2numeric__signature"]
    g = grade(inst, _b_patch(inst, ADAPTED_B, tmp_path), tmp_path)
    assert g.merged_pass and g.interference == 0


def _rec(cond, interference, merged, notices=(), secs=60.0, cost=0.5, trial=0, id_="x__signature"):
    return {"id": id_, "cond": cond, "trial": trial, "solo_pass": True, "merged_pass": merged, "interference": interference,
            "b_ok": True, "b_seconds": secs, "cost_usd": cost, "notices": list(notices)}


def test_report_and_e3_arithmetic():
    from e1.report import report
    from e1.e3 import e3
    helper = "d/u.py::f"
    hit = {"id": f"r:A:{helper}:2>B", "author": "A", "deliveredAt": 5}
    off = {"id": "r:A:d/u.py::other:1>B", "author": "A", "deliveredAt": 6}
    undelivered = {"id": f"r:A:{helper}:3>B", "author": "A", "deliveredAt": None}
    recs = [_rec("blind", 1, False), _rec("live", 0, True, [hit, off, undelivered], secs=1800),
            {**_rec("live", 0, True), "b_ok": False}]
    r = report(recs)
    assert r["conds"]["blind"] == {"n": 1, "solo_pass": 1, "merged_pass": 0, "interference": 1, "interference_rate": 1.0,
                                   "delta_vs_blind": 0.0, "mean_b_seconds": 60.0, "cost_usd": 0.5}
    assert r["conds"]["live"]["merged_pass"] == 1 and r["conds"]["live"]["delta_vs_blind"] == -1.0
    assert r["excluded"] == 1
    x = e3(recs, {"x__signature": helper})
    assert x == {"delivered": 2, "precise": 1, "precision": 0.5, "agent_hours": 0.5, "notices_per_agent_hour": 4.0, "n_live": 1, "no_twin": 0}
    assert e3([recs[1]], {"x__signature": helper})["no_twin"] == 2


def test_story_lanes_from_records():
    from e1.report import story
    fail = "Traceback\n  File x\nTypeError: f() missing 1 required keyword-only argument: 'strict'\n\n------\nRan 1 test in 0.001s\n\nFAILED (errors=1)\n"
    ok = "------\nRan 20 tests in 0.005s\n\nOK\n"
    told = {"id": "n", "author": "A", "at": 1000, "deliveredAt": 5400, "text": "[loom] agent A changed f\nmore detail"}
    recs = [{**_rec("blind", 1, False), "merge_err": fail},
            {**_rec("live", 0, True, [told]), "merge_err": ok, "a_landed_s": 8.3},
            {**_rec("blind", 1, False, id_="g__rename"), "merge_err": "fatal: merge conflict in g.py\n"},
            {**_rec("live", 0, True, id_="h__rettype"), "merge_err": ok, "a_landed_s": 2.0},
            {**_rec("live", 0, True), "b_ok": False}]   # unfinished B sessions never reach the story
    s = {p["id"]: p for p in story(recs)["pairs"]}
    x = s["x__signature"]
    assert (x["func"], x["mech"], x["change"]) == ("x", "signature", "adds a required `strict` argument")
    assert x["blind"] == {"broke": True, "seconds": 60.0, "error": "TypeError: f() missing 1 required keyword-only argument: 'strict'"}
    assert x["live"] == {"broke": False, "seconds": 60.0, "passed": "Ran 20 tests", "a_changed_s": 8.3, "told_s": 12.7,
                         "notice": "[loom] agent A changed f"}
    assert s["g__rename"]["blind"]["error"] == "fatal: merge conflict in g.py" and s["g__rename"]["live"] is None
    assert s["h__rettype"]["live"]["told_s"] is None and s["h__rettype"]["blind"] is None   # Loom never reached B: no invented time
