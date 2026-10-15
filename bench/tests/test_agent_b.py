from e1.instances import load_instances
from e1.agent_b import build_prompt

INST = {i.id: i for i in load_instances()}


def test_prompt_blind_has_task_no_oracle():
    p = build_prompt(INST["slugify__signature"], None)
    assert "slugify_filename" in p and "django/utils/text.py" in p
    assert "parallel" not in p.lower()


def test_prompt_oracle_prepends_message():
    p = build_prompt(INST["slugify__signature"], "`django.utils.text.slugify` gains ...")
    assert p.index("parallel") < p.index("Task:")
