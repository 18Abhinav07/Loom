from e1.instances import load_instances, CORE, PILOT, STALE_DIR


def test_loads_all_36_with_base_commits():
    insts = load_instances(STALE_DIR)
    assert len(insts) == 36
    by_id = {i.id: i for i in insts}
    p = by_id["phone2numeric__signature"]
    assert p.func == "phone2numeric"
    assert p.module == "django.utils.text"
    assert p.module_path == "django/utils/text.py"
    assert p.base_commit == "6d1cf5375f6fbc1496095d2356357c3b08a46324"
    assert p.module_test == "utils_tests.test_text"
    assert "phone2numeric_clean" in p.oracle_test
    assert all(pid in by_id for pid in PILOT)
    assert all(cid in by_id for cid in CORE) and not set(CORE) & set(PILOT)
    assert len({by_id[c].func for c in CORE}) == 12
    assert sorted(by_id[c].mechanism for c in CORE) == ["rename"] * 4 + ["rettype"] * 4 + ["signature"] * 4
