---
{
  "goal": "E5 t1_slugpath: strict slugify; slugify_unique; slug_path",
  "test": "PYTHONPATH=. /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 tests/runtests.py utils_tests.test_text template_tests.filter_tests.test_slugify --parallel 1",
  "tasks": [
    {
      "id": "a",
      "title": "strict slugify",
      "owns": [
        "django/utils/text.py::slugify"
      ],
      "after": [],
      "done": "strict slugify works as described and the tests pass",
      "prompt": "Feature: callers of django.utils.text.slugify must decide explicitly what happens when the result is empty. Add a REQUIRED keyword-only parameter `strict` to slugify (no default): strict=True raises ValueError when the slug would be empty, strict=False keeps today's behaviour. Update every existing caller in django/ and tests/ to pass strict=False. Make every file change with the Edit/Write tools (shell redirection is not allowed). Do not run the full Django test suite; you may run small `python -c` snippets (the worktree is already on PYTHONPATH) or `python tests/runtests.py <label> --parallel 1` for the modules you touch."
    },
    {
      "id": "b",
      "title": "slugify_unique",
      "owns": [
        "django/utils/text.py::slugify_unique"
      ],
      "after": [],
      "done": "slugify_unique works as described and the tests pass",
      "prompt": "Add `slugify_unique(value, existing)` at the end of django/utils/text.py: slugify `value` by REUSING the module's slugify helper; if the slug is in the set `existing`, append -2, -3, ... (the first free one). Return the slug. Make every file change with the Edit/Write tools (shell redirection is not allowed). Do not run the full Django test suite; you may run small `python -c` snippets (the worktree is already on PYTHONPATH) or `python tests/runtests.py <label> --parallel 1` for the modules you touch."
    },
    {
      "id": "c",
      "title": "slug_path",
      "owns": [
        "django/utils/slugpath.py"
      ],
      "after": [],
      "done": "slug_path works as described and the tests pass",
      "prompt": "Create a new module django/utils/slugpath.py with `slug_path(parts, existing)`: it returns the parts joined with '/', where every part except the last is slugified with django.utils.text.slugify and the last part goes through django.utils.text.slugify_unique(value, existing), which another agent is adding right now (it slugifies value and appends -2, -3, ... until the slug is not in the set `existing`). Use those two helpers; do not re-implement them. Make every file change with the Edit/Write tools (shell redirection is not allowed). Do not run the full Django test suite; you may run small `python -c` snippets (the worktree is already on PYTHONPATH) or `python tests/runtests.py <label> --parallel 1` for the modules you touch."
    }
  ]
}
---
Generated from bench/e5/scenarios.py by bench/e5/plans.py; do not edit.
