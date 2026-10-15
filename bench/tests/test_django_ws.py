import pytest
from e1.instances import load_instances
from e1.django_ws import make_worktree, remove_worktree, run_oracle, run_module_tests, a_patch, apply_patch, CACHE

pytestmark = pytest.mark.django
INST = {i.id: i for i in load_instances()}


@pytest.mark.parametrize("iid", ["phone2numeric__signature", "phone2numeric__rename", "phone2numeric__rettype"])
def test_a_patch_is_valid_and_breaks_old_contract(iid, tmp_path):
    inst = INST[iid]
    patch = a_patch(inst)  # validates module tests itself; raises if they fail
    assert "django/utils/text.py" in patch
    wt = make_worktree(inst.base_commit, tmp_path / "wt")
    try:
        ok, err = run_oracle(wt, inst)  # base: B's function does not exist yet
        assert not ok and "phone2numeric_clean" in err
        assert apply_patch(wt, patch)
        ok, _ = run_module_tests(wt, inst)
        assert ok
    finally:
        remove_worktree(wt)
