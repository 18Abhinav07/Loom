"""Corrected STALE grading: B alone vs A+B merged, graded on B's oracle + the helper module's tests."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .django_ws import a_patch, apply_patch, make_worktree, remove_worktree, run_module_tests, run_oracle
from .instances import Instance


@dataclass
class Grade:
    solo_pass: bool
    solo_err: str
    textual_conflict: bool
    merged_pass: bool
    merge_err: str

    @property
    def interference(self) -> int:
        return int(self.solo_pass and not self.textual_conflict and not self.merged_pass)


def _check(wt: Path, inst: Instance) -> tuple[bool, str]:
    ok, err = run_oracle(wt, inst)
    if not ok:
        return False, err
    return run_module_tests(wt, inst)


def grade(inst: Instance, b_patch: str, scratch: Path) -> Grade:
    solo = make_worktree(inst.base_commit, scratch / "grade_solo")
    merged = make_worktree(inst.base_commit, scratch / "grade_merged")
    try:
        apply_patch(solo, b_patch)
        solo_ok, solo_err = _check(solo, inst)
        assert apply_patch(merged, a_patch(inst)), "A patch must apply to its own base"
        if not apply_patch(merged, b_patch, three_way=True):
            return Grade(solo_ok, solo_err, True, False, "textual conflict")
        m_ok, m_err = _check(merged, inst)
        return Grade(solo_ok, solo_err, False, m_ok, m_err)
    finally:
        remove_worktree(solo)
        remove_worktree(merged)
