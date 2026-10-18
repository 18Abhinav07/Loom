"""Django checkouts: bare mirror, per-run worktrees, oracle + module-test runners, A patch cache."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

from .amech import apply_mechanism
from .instances import Instance

BENCH = Path(__file__).resolve().parents[1]
CACHE = BENCH / "cache"
MIRROR = CACHE / "django.git"
PY = sys.executable

ORACLE = textwrap.dedent('''\
    import importlib, sys, unittest
    import django
    from django.conf import settings
    settings.configure(USE_I18N=False)
    django.setup()
    m = importlib.import_module(sys.argv[1])
    class T(unittest.TestCase):
        def test_oracle(self):
            {oracle}
    r = unittest.TextTestRunner(verbosity=0).run(unittest.defaultTestLoader.loadTestsFromTestCase(T))
    sys.exit(0 if r.wasSuccessful() else 1)
''')


def _git(*args: str, cwd: Path | None = None, check: bool = True, input: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True, text=True, input=input)


def ensure_mirror() -> Path:
    if CACHE.is_symlink() and not CACHE.exists():   # dangling link (e.g. to a moved checkout): drop it
        CACHE.unlink()
    if not MIRROR.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        _git("clone", "--bare", "--filter=blob:none", "https://github.com/django/django.git", str(MIRROR))
    return MIRROR


def make_worktree(base: str, dest: Path) -> Path:
    ensure_mirror()
    if dest.exists():
        remove_worktree(dest)
    _git("--git-dir", str(MIRROR), "worktree", "add", "--detach", str(dest), base)
    return dest


def remove_worktree(dest: Path) -> None:
    _git("--git-dir", str(MIRROR), "worktree", "remove", "--force", str(dest), check=False)
    shutil.rmtree(dest, ignore_errors=True)
    _git("--git-dir", str(MIRROR), "worktree", "prune", check=False)


def diff(wt: Path, exclude: tuple[str, ...] = ("tests", ".claude")) -> str:
    _git("add", "-A", cwd=wt)
    spec = ["."] + [f":(exclude){e}" for e in exclude]
    out = _git("diff", "--cached", "--binary", "--", *spec, cwd=wt).stdout
    _git("reset", "-q", cwd=wt)
    return out


def apply_patch(wt: Path, patch: str, three_way: bool = False) -> bool:
    if not patch.strip():
        return True
    if three_way:
        _git("add", "-A", cwd=wt)  # --3way requires the index to match the worktree (A is applied unstaged)
    args = ["apply", "--whitespace=nowarn"] + (["--3way"] if three_way else []) + ["-"]
    return _git(*args, cwd=wt, check=False, input=patch).returncode == 0


def _env(wt: Path) -> dict[str, str]:
    return {**os.environ, "PYTHONPATH": str(wt), "PYTHONDONTWRITEBYTECODE": "1"}


def run_oracle(wt: Path, inst: Instance) -> tuple[bool, str]:
    code = ORACLE.format(oracle=inst.oracle_test)
    p = subprocess.run([PY, "-c", code, inst.module], cwd=wt, env=_env(wt), capture_output=True, text=True, timeout=120)
    return p.returncode == 0, (p.stderr or p.stdout)[-2000:]


def run_module_tests(wt: Path, inst: Instance) -> tuple[bool, str]:
    p = subprocess.run([PY, "tests/runtests.py", inst.module_test, "--parallel", "1", "-v", "0"],
                       cwd=wt, env=_env(wt), capture_output=True, text=True, timeout=600)
    return p.returncode == 0, (p.stderr or p.stdout)[-2000:]


def a_patch(inst: Instance) -> str:
    out = CACHE / "a_patches" / f"{inst.id}.patch"
    if out.exists():
        return out.read_text()
    wt = make_worktree(inst.base_commit, CACHE / "wt_a" / inst.id)
    try:
        changed = apply_mechanism(wt, inst)
        assert inst.module_path in changed, f"{inst.id}: defining module not rewritten"
        ok, err = run_module_tests(wt, inst)
        if not ok:
            raise RuntimeError(f"A patch for {inst.id} breaks {inst.module_test}:\n{err}")
        patch = diff(wt, exclude=())
    finally:
        remove_worktree(wt)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(patch)
    return patch
