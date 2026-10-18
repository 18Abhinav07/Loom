---
{
  "goal": "Django StaleBench (4 agents): a changes slugify's signature, c also edits slugify, b builds title_slug on it, and d builds a unique-slug helper on top of a's and b's landed work",
  "test": "cd tests && PYTHONPATH=.. python3 runtests.py utils_tests.test_text template_tests.filter_tests.test_slugify utils_tests.test_text_a utils_tests.test_text_b utils_tests.test_text_c utils_tests.test_text_d --parallel 1 2>&1 | tail -15",
  "tasks": [
    {
      "id": "a",
      "title": "strict slugify",
      "owns": [
        "django/utils/text.py::slugify",
        "tests/utils_tests/test_text_a.py"
      ],
      "after": [],
      "done": "strict slugify done and its tests pass",
      "prompt": "Add a required keyword-only parameter `strict` to django.utils.text.slugify. When strict is True, raise ValueError if the result is empty; when False, keep today's behaviour. Pass strict=False at every existing caller in django/ (search the whole package, including django/contrib and django/template) and in the existing tests under tests/, and make sure template_tests.filter_tests.test_slugify still passes. Put your new tests in a new file tests/utils_tests/test_text_a.py (class StrictSlugifyTests). Run tests from the repo root with `python tests/runtests.py utils_tests.test_text utils_tests.test_text_a --parallel 1`."
    },
    {
      "id": "b",
      "title": "title_slug helper",
      "owns": [
        "django/utils/text.py::title_slug",
        "tests/utils_tests/test_text_b.py"
      ],
      "after": [],
      "done": "title_slug helper done and its tests pass",
      "prompt": "Add a function title_slug(title) to django/utils/text.py, placed directly after slugify, that lowercases the title, strips a leading \"the \", and returns django.utils.text.slugify of the rest. Put its tests in a new file tests/utils_tests/test_text_b.py (class TitleSlugTests). Run tests from the repo root with `python tests/runtests.py utils_tests.test_text_b --parallel 1`."
    },
    {
      "id": "c",
      "title": "slugify max_length",
      "owns": [
        "django/utils/text.py::capfirst_words",
        "tests/utils_tests/test_text_c.py"
      ],
      "after": [],
      "done": "slugify max_length done and its tests pass",
      "prompt": "Two things: (1) give django.utils.text.slugify a new optional parameter max_length=None that truncates the result; (2) add a function capfirst_words(s) at the end of django/utils/text.py that applies capfirst to each word. Put tests for what you change in a new file tests/utils_tests/test_text_c.py (class CapfirstWordsTests). If Loom denies your slugify change, slugify belongs to another agent: skip (1), do not edit slugify later, and finish (2). Run tests from the repo root with `python tests/runtests.py utils_tests.test_text_c --parallel 1`."
    },
    {
      "id": "d",
      "title": "unique_slugs helper",
      "owns": [
        "django/utils/text.py::unique_slugs",
        "tests/utils_tests/test_text_d.py"
      ],
      "after": [
        "a",
        "b"
      ],
      "done": "unique_slugs done and its tests pass",
      "prompt": "Add a function unique_slugs(titles) at the end of django/utils/text.py: it returns a list with one slug per title, built with title_slug (from the other agent), and when two titles give the same slug the later ones get -2, -3, ... appended. A title whose slug would be empty raises ValueError; to detect that, call slugify with strict=True (slugify's new keyword-only parameter from the first agent). Build only on what has already landed; do not edit slugify or title_slug. Put your tests in a new file tests/utils_tests/test_text_d.py (class UniqueSlugsTests). Run tests from the repo root with `python tests/runtests.py utils_tests.test_text_d --parallel 1`."
    }
  ]
}
---
