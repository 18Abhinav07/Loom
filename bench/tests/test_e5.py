"""E5: real multi-agent bench — plan building, per-agent oracles on a tree, summary."""
from pathlib import Path

from e5.run import agent_env, check, plan_for, summarize, verdict
from e5.scenarios import RULES, SCENARIOS, Agent


def test_plan_is_the_same_for_both_conditions_and_carries_scope():
    sc = next(s for s in SCENARIOS if s.kind == "trio")
    p = plan_for(sc, Path("/r"))
    assert p["repo"] == "/r" and [t["id"] for t in p["tasks"]] == ["a", "b", "c"]
    assert p["tasks"][0]["scope"] == ["django/utils/text.py::slugify"] and p["tasks"][2]["scope"] == []
    assert "runtests.py utils_tests.test_text" in p["test"]
    # only `python ...` is allowlisted, so prompts must not ask for an env prefix or shell writes
    assert all("PYTHONPATH=" not in t["prompt"] and "Edit/Write" in t["prompt"] for t in p["tasks"])
    env = agent_env({"ANTHROPIC_API_KEY": "k", "PATH": "/bin"})
    assert env["PYTHONPATH"] == "." and "ANTHROPIC_API_KEY" not in env and env["PATH"].endswith(":/bin")
    # team scenarios: every agent gets the same brief and everyone's assignment (both conditions), then its own task
    team = next(s for s in SCENARIOS if s.kind == "team")
    tp = plan_for(team, Path("/r"))["tasks"]
    assert len(tp) == 4 and all(t["prompt"].startswith(team.brief) for t in tp)
    for t, a in zip(tp, team.agents):
        assert all(o.title in t["prompt"] for o in team.agents)
        assert t["prompt"].count("Edit/Write") == 1 and f"You are agent {a.id}" in t["prompt"]
        assert t["prompt"].rstrip().endswith(RULES)


def test_check_runs_an_agent_oracle_against_a_tree(tmp_path: Path):
    (tmp_path / "django" / "utils").mkdir(parents=True)
    (tmp_path / "django" / "__init__.py").write_text("")
    (tmp_path / "django" / "utils" / "__init__.py").write_text("")
    (tmp_path / "django" / "utils" / "text.py").write_text("def slugify(v, *, strict):\n    return v.lower()\n")
    ok = Agent("a", "t", "p", "self.assertEqual(m.slugify('X', strict=False), 'x')\n")
    bad = Agent("b", "t", "p", "self.assertEqual(m.slugify('X'), 'x')\n")
    assert check(tmp_path, ok) == (True, "")
    passed, err = check(tmp_path, bad)
    assert not passed and "TypeError" in err and "strict" in err


def test_summarize_counts_full_success_per_condition():
    recs = [{"scenario": "p1", "cond": "blind", "all_pass": False, "agents": {"a": {"merged": True}, "b": {"merged": False}},
             "conflict": None, "broken": 1, "wall_s": 100},
            {"scenario": "p1", "cond": "loom", "all_pass": True, "agents": {"a": {"merged": True}, "b": {"merged": True}},
             "conflict": None, "broken": 0, "wall_s": 120}]
    recs.append({"scenario": "s1", "cond": "loom", "all_pass": False, "integration": False,
                 "agents": {"a": {"merged": True}}, "conflict": None, "broken": 0, "wall_s": 10})
    out = summarize(recs)
    assert "blind" in out and "loom" in out
    assert out.splitlines()[1].split()[:4] == ["blind", "1", "0/1", "1/2"]
    assert out.splitlines()[2].split()[:4] == ["loom", "2", "1/2", "3/3"]
    assert out.splitlines()[2].split()[-1] == "0/1"          # integration column: team records only


def test_verdict_a_conflict_fails_every_agent():
    v = verdict(conflict="a.py", tests_passed=None, merged={"a": True, "b": True}, integration=None)
    assert v["agents_ok"] == 0 and v["all_pass"] is False and v["failed"] == ["a", "b"]


def test_verdict_agent_ok_only_from_the_full_final_merge():
    v = verdict(conflict=None, tests_passed=True, merged={"a": True, "b": False}, integration=None)
    assert v["agents_ok"] == 1 and v["all_pass"] is False and v["failed"] == ["b"]
    assert verdict(conflict=None, tests_passed=True, merged={"a": True}, integration=False)["all_pass"] is False
    assert verdict(conflict=None, tests_passed=True, merged={"a": True}, integration=None)["all_pass"] is True
