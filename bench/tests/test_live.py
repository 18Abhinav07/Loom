import json, os, subprocess, time
import pytest
from e1.instances import load_instances
from e1.django_ws import make_worktree, remove_worktree
from e1.live import LiveRun, HOOK_CMD

pytestmark = [pytest.mark.loom, pytest.mark.django]
INST = {i.id: i for i in load_instances()}


def fire(env, wt, event, payload):
    """Act as Claude Code: run the configured hook command with a hook payload on stdin."""
    p = subprocess.run(HOOK_CMD.split() + ["claude", event], input=json.dumps({"cwd": str(wt), "hook_event_name": event, **payload}),
                       env={**os.environ, **env}, capture_output=True, text=True, timeout=30)
    return p.stdout


def test_live_run_delivers_graph_notice_after_b_reads(tmp_path):
    inst = INST["phone2numeric__signature"]
    wt = make_worktree(inst.base_commit, tmp_path / "b")
    live = LiveRun(inst, "test", wt, tmp_path, a_at="read")
    try:
        env = live.start()
        settings = json.loads((wt / ".claude" / "settings.json").read_text())
        assert "PostToolUse" in settings["hooks"]
        fire(env, wt, "SessionStart", {})
        fire(env, wt, "PostToolUse", {"tool_name": "Read", "tool_input": {"file_path": str(wt / inst.module_path)}})
        deadline = time.time() + 60
        out = ""
        while time.time() < deadline and "strict" not in out:
            time.sleep(1)
            out = fire(env, wt, "PostToolUse", {"tool_name": "Bash", "tool_input": {"command": "ls"}})
        assert "def phone2numeric(phone, *, strict)" in out
        res = live.finish()
        assert res["a_landed"] and res["notices_delivered"] >= 1
    finally:
        live.close()
        remove_worktree(wt)


def test_edit_mode_lands_after_first_edit_and_flags_resume_when_b_already_stopped(tmp_path):
    inst = INST["phone2numeric__signature"]
    wt = make_worktree(inst.base_commit, tmp_path / "b")
    live = LiveRun(inst, "test-edit", wt, tmp_path, a_at="edit")
    try:
        env = live.start()
        fire(env, wt, "SessionStart", {})
        fire(env, wt, "PostToolUse", {"tool_name": "Read", "tool_input": {"file_path": str(wt / inst.module_path)}})
        time.sleep(2.5)
        assert live.a_landed_s is None  # a read alone must not trigger edit mode
        # B writes a stale caller (old signature), then exits before the 1 s poll can fire
        mod = wt / inst.module_path
        mod.write_text(mod.read_text() + "\n\ndef _b_new():\n    return phone2numeric('1-800-FLOWERS')\n")
        fire(env, wt, "PostToolUse", {"tool_name": "Write", "tool_input": {"file_path": str(mod)}})
        assert live.needs_resume() is True  # landed A synchronously; notice is pending for B
        assert live.a_landed_s is not None
        out = fire(env, wt, "UserPromptSubmit", {"prompt": "Continue."})
        assert "strict" in out and "_b_new" in out  # delivered on the resume prompt, names B's caller
        assert live.needs_resume() is False
    finally:
        live.close()
        remove_worktree(wt)
