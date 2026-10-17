// The live demo's playground: a small self-contained Python repo plus a 3-task plan whose tasks touch each other's code,
// so agents working at once can really collide. Created once under ~/.loom/demo-repo and initialised with the real `loom init`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const FILES: Record<string, string> = {
  'textkit/__init__.py': '',
  'textkit/text.py': `import re


def slugify(value):
    """Lower-case, strip, and join words with hyphens."""
    value = re.sub(r"[^\\w\\s-]", "", str(value)).strip().lower()
    return re.sub(r"[-\\s]+", "-", value)
`,
  'textkit/titles.py': `from .text import slugify


def page_url(title):
    return "/" + slugify(title)


def breadcrumb(parts):
    return " > ".join(slugify(p) for p in parts)
`,
  'tests/__init__.py': '',
  'tests/test_textkit.py': `import unittest

from textkit.text import slugify, slugify_unique
from textkit.titles import page_url, breadcrumb
from textkit.slugpath import slug_path


class TextKit(unittest.TestCase):
    def test_slugify_lenient(self):
        self.assertEqual(slugify("Hello World!", strict=False), "hello-world")
        self.assertEqual(slugify("!!!", strict=False), "")

    def test_slugify_strict(self):
        with self.assertRaises(ValueError):
            slugify("!!!", strict=True)
        self.assertEqual(slugify("Hi There", strict=True), "hi-there")

    def test_slugify_requires_the_flag(self):
        with self.assertRaises(TypeError):
            slugify("x")

    def test_callers_pass_the_flag(self):
        self.assertEqual(page_url("Hi There"), "/hi-there")
        self.assertEqual(breadcrumb(["A B", "C D"]), "a-b > c-d")

    def test_slugify_unique(self):
        self.assertEqual(slugify_unique("A B", set()), "a-b")
        self.assertEqual(slugify_unique("A B", {"a-b"}), "a-b-2")
        self.assertEqual(slugify_unique("A B", {"a-b", "a-b-2"}), "a-b-3")

    def test_slug_path(self):
        self.assertEqual(slug_path(["My Dir", "Sub Dir", "File"], {"file"}), "my-dir/sub-dir/file-2")


if __name__ == "__main__":
    unittest.main()
`,
};

const TEST = 'python3 -m unittest discover -s tests -t . 2>&1';
const PLAN = {
  goal: 'textkit: strict slugify, slugify_unique, slug_path',
  test: TEST,
  tasks: [
    { id: 'a', title: 'strict slugify', owns: ['textkit/text.py::slugify'], after: [], done: 'slugify has a required strict flag and every caller passes it',
      prompt: 'Callers of textkit.text.slugify must decide explicitly what happens when the result is empty. Add a REQUIRED keyword-only parameter `strict` to slugify (no default): strict=True raises ValueError when the slug would be empty, strict=False keeps today\'s behaviour. Update every existing caller in textkit/ to pass strict=False. Make file changes with the Edit/Write tools. You may run `python3 -m unittest discover -s tests -t .` to check.' },
    { id: 'b', title: 'slugify_unique', owns: ['textkit/text.py::slugify_unique'], after: [], done: 'slugify_unique works',
      prompt: 'Add `slugify_unique(value, existing)` at the end of textkit/text.py: slugify `value` by REUSING the module\'s slugify helper; if the slug is in the set `existing`, append -2, -3, ... (the first free one). Return the slug. Make file changes with the Edit/Write tools. You may run `python3 -m unittest discover -s tests -t .` to check.' },
    { id: 'c', title: 'slug_path', owns: ['textkit/slugpath.py'], after: [], done: 'slug_path works',
      prompt: 'Create a new module textkit/slugpath.py with `slug_path(parts, existing)`: it returns the parts joined with "/", where every part except the last is slugified with textkit.text.slugify and the last part goes through textkit.text.slugify_unique(value, existing), which another agent is adding right now (it slugifies value and appends -2, -3, ... until the slug is not in the set `existing`). Use those two helpers; do not re-implement them. Make file changes with the Edit/Write tools. You may run `python3 -m unittest discover -s tests -t .` to check.' },
  ],
};

const run = (cwd: string, cmd: string, ...a: string[]) => execFileSync(cmd, a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Create (or reset to a clean checkout) the demo repo and return its path and plan file. `cli` is the built loom.cjs. */
export function demoSandbox(cli: string, home = homedir()): { cwd: string; plan: string } {
  const cwd = join(home, '.loom', 'demo-repo');
  const plan = join(cwd, 'demo-plan.md');
  if (!existsSync(join(cwd, '.git'))) {
    mkdirSync(cwd, { recursive: true });
    for (const [f, body] of Object.entries(FILES)) { mkdirSync(dirname(join(cwd, f)), { recursive: true }); writeFileSync(join(cwd, f), body); }
    writeFileSync(join(cwd, '.gitignore'), '__pycache__/\n.loom/wt/\n');
    run(cwd, 'git', 'init', '-q', '-b', 'main');
    run(cwd, 'git', '-c', 'user.email=demo@loom.local', '-c', 'user.name=loom-demo', 'add', '-A');
    run(cwd, 'git', '-c', 'user.email=demo@loom.local', '-c', 'user.name=loom-demo', 'commit', '-q', '-m', 'textkit: starting point');
    run(cwd, 'node', cli, 'init', '--no-lead');
  }
  writeFileSync(plan, `---\n${JSON.stringify(PLAN, null, 2)}\n---\n`);
  return { cwd, plan };
}
