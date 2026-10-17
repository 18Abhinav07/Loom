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


def test_archive_keeps_transcripts_and_branch_diffs_then_drops_the_clone(tmp_path: Path):
    import subprocess
    from e5.run import archive
    repo = tmp_path / "repo"
    repo.mkdir()
    g = lambda *a: subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], cwd=repo, check=True, capture_output=True)
    (repo / "m.py").write_text("x = 1\n")
    g("init", "-q"); g("add", "-A"); g("commit", "-qm", "base")
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip()
    g("checkout", "-qb", "loom/abcd1234/landed"); (repo / "m.py").write_text("x = 2\n"); g("commit", "-qam", "a")
    tdir = repo / ".git" / "loom" / "runs" / "abcd1234"
    tdir.mkdir(parents=True)
    (tdir / "a.jsonl").write_text('{"type":"result"}\n')
    archive(repo, "01XXXXXXXXXXXXXXXXABCD1234", base, tmp_path / "out", "t1__loom")
    assert (tmp_path / "out" / "transcripts" / "t1__loom" / "a.jsonl").read_text() == '{"type":"result"}\n'
    assert "+x = 2" in (tmp_path / "out" / "diffs" / "t1__loom" / "loom_abcd1234_landed.diff").read_text()
    assert not repo.exists()


def test_transcript_stats_counts_loom_denials_and_handovers_in_real_transcript_lines(tmp_path: Path):
    # content copied from a real x1 transcript: Claude Code prefixes the hook's deny reason with "<Event>:<Tool> hook error: "
    from e5.run import _transcript_stats
    import json
    deny = {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "is_error": True, "tool_use_id": "t1",
            "content": "PreToolUse:Edit hook error: [loom] edit blocked before it happened:\n  LogEntry.get_change_message is leased by agent c (write, task c), held 11s"}]}}
    hand = {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "is_error": True, "tool_use_id": "t2",
            "content": "PreToolUse:Edit hook error: [loom] get_text_list changed on loom/x/landed by a (task a); your file now contains it, re-read get_text_list."}]}}
    plain = {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t3", "content": "the word leased by itself"}]}}
    f = tmp_path / "a.jsonl"
    f.write_text("\n".join(json.dumps(x) for x in (deny, deny, hand, plain)) + "\n")
    s = _transcript_stats(f)
    assert s["denied"] == 2 and s["handovers"] == 1


def test_plan_files_carry_the_scenarios_tasks_as_team_plan_front_matter():
    import json, re
    from e5.plans import PLAN_IDS, plan_md
    from e5.scenarios import SCENARIOS
    for sid in PLAN_IDS:
        sc = next(s for s in SCENARIOS if s.id == sid)
        text = plan_md(sc)
        fm = json.loads(re.match(r"---\n(.*?)\n---\n", text, re.S).group(1))   # JSON is YAML: parseTeamPlan reads it as front matter
        assert [t["id"] for t in fm["tasks"]] == [a.id for a in sc.agents]
        assert fm["test"].endswith("--parallel 1") and sc.tests[0] in fm["test"]
        for t, a in zip(fm["tasks"], sc.agents):
            assert t["prompt"] and t["owns"] and t["done"] and t["after"] == []   # every agent starts at once, as in the old plan
            assert t["owns"][: len(a.scope)] == list(a.scope)
        owns = [o for t in fm["tasks"] for o in t["owns"]]
        assert len(owns) == len(set(owns))   # the checker refuses two unordered tasks owning the same thing


def test_team_report_is_adapted_to_the_graded_shape(tmp_path):
    import subprocess
    from e5.run import from_team
    g = lambda *a: subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()
    g("init", "-q", "-b", "main"); (tmp_path / "f").write_text("1"); g("add", "."); g("commit", "-qm", "base")
    g("checkout", "-qb", "loom/abcd1234/landed"); (tmp_path / "f").write_text("2"); g("commit", "-qam", "a")
    g("branch", "loom/abcd1234/a"); g("checkout", "-q", "main")
    team = {"id": "01XXXXXXXXXXXXXXXXABCD1234", "state": "done", "landed": "loom/abcd1234/landed", "agents": [
        {"id": "a", "state": "landed", "branch": "loom/abcd1234/a", "lands": ["x"], "resumed": 1},
        {"id": "b", "state": "failed", "branch": "loom/abcd1234/b", "lands": [], "resumed": 0}]}
    rep = from_team(tmp_path, team, "test \"$(cat f)\" = 2")
    w = {x["agent"]: x for x in rep["workers"]}
    assert rep["run"] == team["id"] and rep["merge"]["conflict"] is False and rep["merge"]["testsPassed"] is True
    assert (w["a"]["exit"], w["a"]["resumed"], w["a"]["lands"]) == (0, 1, ["x"]) and w["a"]["commit"]
    assert w["b"]["exit"] == 1 and not w["b"]["commit"]
    assert (tmp_path / ".loom" / "wt" / "abcd1234" / "_merge" / "f").read_text() == "2"
