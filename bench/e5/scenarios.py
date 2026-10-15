"""E5 scenarios: every agent is a real Claude Code session; A's feature needs a breaking change to a shared helper.

Pairs (A, B) and trios (A, B, C; C also builds on B). Each agent has its own oracle, checked on the merged tree.
Teams (4 agents): one feature split four ways over the same functions; every agent gets the whole team brief, in
both conditions, so the only difference between them is Loom. An integration oracle checks the parts together.
"""
from __future__ import annotations

from dataclasses import dataclass, field

TEXT = "django/utils/text.py"


@dataclass(frozen=True)
class Agent:
    id: str
    title: str
    prompt: str
    oracle: str                      # python statements; `self` is a TestCase, `m` is django.utils.text
    scope: tuple[str, ...] = ()      # symbols the task changes (plan input; Loom pre-grants hub ownership from it)
    needs: tuple[str, ...] = ()      # other agents whose code this agent's oracle depends on (no solo grade)


@dataclass(frozen=True)
class Scenario:
    id: str
    base: str
    agents: tuple[Agent, ...]
    tests: tuple[str, ...]           # Django test labels run on the merged tree
    kind: str = field(default="pair")
    brief: str = ""                  # team scenarios: the feature every agent is told about, with everyone's assignment
    integration: str = ""            # oracle over everyone's work together, on the merged tree


RULES = ("Make every file change with the Edit/Write tools (shell redirection is not allowed). Do not run the full "
         "Django test suite; you may run small `python -c` snippets (the worktree is already on PYTHONPATH) or "
         "`python tests/runtests.py <label> --parallel 1` for the modules you touch.")

STRICT_A = Agent(
    "a", "strict slugify",
    "Feature: callers of django.utils.text.slugify must decide explicitly what happens when the result is empty. "
    "Add a REQUIRED keyword-only parameter `strict` to slugify (no default): strict=True raises ValueError when the "
    "slug would be empty, strict=False keeps today's behaviour. Update every existing caller in django/ and tests/ "
    "to pass strict=False. " + RULES,
    "with self.assertRaises(ValueError):\n    m.slugify('!!!', strict=True)\n"
    "self.assertEqual(m.slugify('Hello World', strict=False), 'hello-world')\n"
    "with self.assertRaises(TypeError):\n    m.slugify('x')\n",
    scope=(f"{TEXT}::slugify",))

RENAME_A = Agent(
    "a", "phone_to_numeric",
    "Feature: Django is moving its text helpers to snake_case names. Rename django.utils.text.phone2numeric to "
    "phone_to_numeric with identical behaviour. The old name must disappear completely (no alias, no wrapper). "
    "Update every caller in django/ and tests/. " + RULES,
    "self.assertEqual(m.phone_to_numeric('1-800-COLLECT'), '1-800-2655328')\n"
    "self.assertFalse(hasattr(m, 'phone2numeric'))\n",
    scope=(f"{TEXT}::phone2numeric",))

SCENARIOS = [
    Scenario("p1_slugify", "afe6634146d0fe70498976c49d2eb4d745aa9064", (
        STRICT_A,
        Agent("b", "slugify_filename",
              "Add `slugify_filename(name, ext)` at the end of django/utils/text.py: it slugifies `name` by REUSING the "
              "module's existing slugify helper, lowercases `ext`, and joins them as 'slug.ext'. " + RULES,
              "self.assertEqual(m.slugify_filename('Hello World!', 'TXT'), 'hello-world.txt')\n"),
    ), ("utils_tests.test_text", "template_tests.filter_tests.test_slugify")),
    Scenario("p2_phone", "6d1cf5375f6fbc1496095d2356357c3b08a46324", (
        RENAME_A,
        Agent("b", "phone2numeric_clean",
              "Add `phone2numeric_clean(phone)` at the end of django/utils/text.py: it removes spaces and hyphens from "
              "`phone`, then converts the remaining letters to phone-keypad digits by REUSING the module's existing "
              "phone-to-number helper (do not re-implement the letter->digit map). Return the digit string. " + RULES,
              "self.assertEqual(m.phone2numeric_clean('800-COLLECT'), '8002655328')\n"),
    ), ("utils_tests.test_text", "template_tests.filter_tests.test_phone2numeric")),
    Scenario("t1_slugpath", "afe6634146d0fe70498976c49d2eb4d745aa9064", (
        STRICT_A,
        Agent("b", "slugify_unique",
              "Add `slugify_unique(value, existing)` at the end of django/utils/text.py: slugify `value` by REUSING the "
              "module's slugify helper; if the slug is in the set `existing`, append -2, -3, ... (the first free one). "
              "Return the slug. " + RULES,
              "self.assertEqual(m.slugify_unique('Hello World', set()), 'hello-world')\n"
              "self.assertEqual(m.slugify_unique('Hello World', {'hello-world'}), 'hello-world-2')\n"
              "self.assertEqual(m.slugify_unique('Hello World', {'hello-world', 'hello-world-2'}), 'hello-world-3')\n"),
        Agent("c", "slug_path",
              "Create a new module django/utils/slugpath.py with `slug_path(parts, existing)`: it returns the parts "
              "joined with '/', where every part except the last is slugified with django.utils.text.slugify and the "
              "last part goes through django.utils.text.slugify_unique(value, existing), which another agent is adding "
              "right now (it slugifies value and appends -2, -3, ... until the slug is not in the set `existing`). "
              "Use those two helpers; do not re-implement them. " + RULES,
              "from django.utils.slugpath import slug_path\n"
              "self.assertEqual(slug_path(['My Docs', 'Hello World'], {'hello-world'}), 'my-docs/hello-world-2')\n",
              needs=("b",)),
    ), ("utils_tests.test_text", "template_tests.filter_tests.test_slugify"), kind="trio"),
]

FILTERS = "from django.template import Context, Engine\nr = lambda t, **c: Engine(libraries={}).from_string(t).render(Context(c))\n"

SLUG4 = Scenario("s1_slug4", "afe6634146d0fe70498976c49d2eb4d745aa9064", (
    Agent("a", "slugify separator",
          "Add the keyword-only `separator='-'` parameter to django.utils.text.slugify: words are joined with it and it "
          "is stripped from both ends of the result.",
          "self.assertEqual(m.slugify('Hello World', separator='_'), 'hello_world')\n"
          "self.assertEqual(m.slugify('  Hello -- World  ', separator='.'), 'hello.world')\n"
          "self.assertEqual(m.slugify('Hello World'), 'hello-world')\n",
          scope=(f"{TEXT}::slugify",)),
    Agent("b", "slugify max_length",
          "Add the keyword-only `max_length=None` parameter to django.utils.text.slugify: the slug is cut at a word "
          "boundary so it is at most max_length characters and never ends with a separator; if the first word alone "
          "is longer, that word is cut to max_length.",
          "self.assertEqual(m.slugify('hello world again', max_length=11), 'hello-world')\n"
          "self.assertEqual(m.slugify('hello world again', max_length=13), 'hello-world')\n"
          "self.assertEqual(m.slugify('internationalization', max_length=5), 'inter')\n",
          scope=(f"{TEXT}::slugify",)),
    Agent("c", "slugify stopwords",
          "Add the keyword-only `stopwords=()` parameter to django.utils.text.slugify: words in it are dropped, "
          "compared case-insensitively; if every word is a stopword nothing is dropped.",
          "self.assertEqual(m.slugify('The Art of War', stopwords=('the', 'of')), 'art-war')\n"
          "self.assertEqual(m.slugify('The The', stopwords=('the',)), 'the-the')\n",
          scope=(f"{TEXT}::slugify",)),
    Agent("d", "slugify filter separator",
          "Let the `slugify` template filter in django/template/defaultfilters.py take an optional argument, the "
          "separator: `{{ title|slugify:\"_\" }}`. Without the argument it behaves as today.",
          FILTERS + "self.assertEqual(r('{{ v|slugify:\"_\" }}', v='Hello World'), 'hello_world')\n"
          "self.assertEqual(r('{{ v|slugify }}', v='Hello World'), 'hello-world')\n",
          needs=("a",)),
), ("utils_tests.test_text", "template_tests.filter_tests.test_slugify"), kind="team",
    brief="Feature: richer slugs. django.utils.text.slugify becomes "
          "`slugify(value, allow_unicode=False, *, separator='-', max_length=None, stopwords=())`, and the slugify "
          "template filter takes the separator as its argument. Order inside slugify: normalise as today, drop "
          "stopwords, join the words with the separator, then apply max_length (the separator counts toward it).",
    integration="self.assertEqual(m.slugify('The Art of War', separator='_', max_length=7, stopwords=('the', 'of')), 'art_war')\n"
                "self.assertEqual(m.slugify('The big dog', max_length=3, stopwords=('the',)), 'big')\n"
                "self.assertEqual(m.slugify('a b c d', separator='__', max_length=7), 'a__b__c')\n"
                "self.assertEqual(m.slugify('Hello World Again', separator='_', max_length=12), 'hello_world')\n")

TRUNC4 = Scenario("s2_trunc4", "afe6634146d0fe70498976c49d2eb4d745aa9064", (
    Agent("a", "Truncator.sentences",
          "Add `Truncator.sentences(num, truncate=None)` to django.utils.text: keep the first `num` sentences (a "
          "sentence ends with . ! or ? followed by whitespace or the end of the text), joined by single spaces, and "
          "add the truncation text when something was cut, like words() does.",
          "self.assertEqual(m.Truncator('One. Two! Three?').sentences(1), 'One.…')\n"
          "self.assertEqual(m.Truncator('One. Two! Three?').sentences(2), 'One. Two!…')\n"
          "self.assertEqual(m.Truncator('One. Two! Three?').sentences(3), 'One. Two! Three?')\n",
          scope=(f"{TEXT}::Truncator",)),
    Agent("b", "truncation {count}",
          "Let truncation text contain a `{count}` placeholder: it is replaced by how many words were cut off, e.g. "
          "Truncator('one two three').words(1, truncate=' (+{count})') == 'one (+2)'.",
          "self.assertEqual(m.Truncator('one two three').words(1, truncate=' (+{count})'), 'one (+2)')\n"
          "self.assertEqual(m.Truncator('one two three').words(2), 'one two…')\n",
          scope=(f"{TEXT}::add_truncation_text",)),
    Agent("c", "no dangling punctuation",
          "When Truncator.words() cuts plain text (not html=True), strip trailing commas and colons from the kept text "
          "before the truncation text is added, e.g. Truncator('Hello, world').words(1) == 'Hello…'. The same must "
          "hold for the sentences() method another agent is adding.",
          "self.assertEqual(m.Truncator('Hello, world').words(1), 'Hello…')\n"
          "self.assertEqual(m.Truncator('a: b: c').words(2), 'a: b…')\n"
          "self.assertEqual(m.Truncator('one two').words(1), 'one…')\n",
          scope=(f"{TEXT}::add_truncation_text",)),
    Agent("d", "truncatesentences filter",
          "Add a `truncatesentences` template filter to django/template/defaultfilters.py, next to truncatewords: "
          "`{{ text|truncatesentences:2 }}` keeps two sentences and marks the cut with ' …', as truncatewords does; "
          "a non-integer argument returns the value unchanged.",
          FILTERS + "self.assertEqual(r('{{ v|truncatesentences:1 }}', v='One. Two. Three.'), 'One. …')\n"
          "self.assertEqual(r('{{ v|truncatesentences:\"x\" }}', v='One. Two.'), 'One. Two.')\n",
          needs=("a",)),
), ("utils_tests.test_text", "template_tests.filter_tests.test_truncatewords"), kind="team",
    brief="Feature: better truncation in django.utils.text. Truncator gains sentences(); truncation text may carry a "
          "{count} placeholder for how many units (words, or sentences for sentences()) were cut; dangling , and : are "
          "stripped before the marker in plain-text words() and sentences(); templates get a truncatesentences filter.",
    integration="self.assertEqual(m.Truncator('One, two. Three. Four.').sentences(1, truncate=' (+{count})'), 'One, two. (+2)')\n"
                "self.assertEqual(m.Truncator('Hello, big world').words(1, truncate=' (+{count})'), 'Hello (+2)')\n"
                "self.assertEqual(m.Truncator('One. Two. Three.').sentences(2, truncate=' [{count} more]'), 'One. Two. [1 more]')\n"
                + FILTERS + "self.assertEqual(r('{{ v|truncatesentences:1 }}', v='One, two. Three.'), 'One, two. …')\n")

FILENAME4 = Scenario("s3_filename4", "afe6634146d0fe70498976c49d2eb4d745aa9064", (
    Agent("a", "get_valid_filename max_length",
          "Add the keyword-only `max_length=None` parameter to django.utils.text.get_valid_filename: a longer result "
          "has its stem cut (the extension is kept) so the name is at most max_length characters.",
          "self.assertEqual(m.get_valid_filename('a_very_long_name.txt', max_length=10), 'a_very.txt')\n"
          "self.assertEqual(m.get_valid_filename('short.txt', max_length=10), 'short.txt')\n",
          scope=(f"{TEXT}::get_valid_filename",)),
    Agent("b", "get_valid_filename allow_unicode",
          "Add the keyword-only `allow_unicode=True` parameter to django.utils.text.get_valid_filename: True keeps "
          "today's behaviour; False transliterates to ASCII first (Ü becomes U, characters without an ASCII form are "
          "dropped).",
          "self.assertEqual(m.get_valid_filename('Über.pdf', allow_unicode=False), 'Uber.pdf')\n"
          "self.assertEqual(m.get_valid_filename('Über.pdf'), 'Über.pdf')\n",
          scope=(f"{TEXT}::get_valid_filename",)),
    Agent("c", "get_valid_filename cleanup",
          "Make django.utils.text.get_valid_filename collapse runs of underscores into one underscore and runs of "
          "dashes into one dash, and strip leading dots, so names are tidy and never hidden files.",
          "self.assertEqual(m.get_valid_filename('my  -- file.txt'), 'my_-_file.txt')\n"
          "self.assertEqual(m.get_valid_filename('  ..secret  report.txt'), 'secret_report.txt')\n",
          scope=(f"{TEXT}::get_valid_filename",)),
    Agent("d", "unique_filename",
          "Add `unique_filename(name, existing, **kwargs)` to django/utils/text.py: it cleans `name` with "
          "get_valid_filename(name, **kwargs) and, while the result is in the set `existing`, adds _2, _3, ... before "
          "the extension; with max_length the suffixed name must still fit, so the stem is cut further.",
          "self.assertEqual(m.unique_filename('report.txt', {'report.txt'}), 'report_2.txt')\n"
          "self.assertEqual(m.unique_filename('report.txt', {'report.txt', 'report_2.txt'}), 'report_3.txt')\n"
          "self.assertEqual(m.unique_filename('longname.txt', {'longna.txt'}, max_length=10), 'long_2.txt')\n",
          needs=("a",)),
), ("utils_tests.test_text",), kind="team",
    brief="Feature: safer upload names. django.utils.text.get_valid_filename becomes "
          "`get_valid_filename(name, *, allow_unicode=True, max_length=None)` and gains a sibling "
          "`unique_filename(name, existing, **kwargs)`. Order inside get_valid_filename: transliterate (when "
          "allow_unicode=False), today's cleanup, collapse underscore/dash runs and strip leading dots, "
          "then cut the stem for max_length. The extension is the last '.suffix'; a cut stem never ends in _ or -.",
    integration="self.assertEqual(m.get_valid_filename('  Über  schöne Datei.pdf', allow_unicode=False, max_length=12), 'Uber_sch.pdf')\n"
                "self.assertEqual(m.get_valid_filename('--draft__v2.tar.gz', max_length=9), '-draft.gz')\n"
                "self.assertEqual(m.unique_filename('  Über Datei.pdf', {'Uber_Datei.pdf'}, allow_unicode=False), 'Uber_Datei_2.pdf')\n"
                "self.assertEqual(m.unique_filename('my__report.txt', {'my_report.txt'}, max_length=13), 'my_repo_2.txt')\n")

SCENARIOS += [SLUG4, TRUNC4, FILENAME4]
PILOT = ["p1_slugify", "p2_phone", "t1_slugpath"]
TEAM = ["s1_slug4", "s2_trunc4", "s3_filename4"]
