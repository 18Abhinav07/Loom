// B3 §3.3: the team plan file (.loom/plans/<slug>.md) and the plan checker that gates a team start.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { checkTeamPlan, listPlans, parseTeamPlan, type TeamPlan } from '../src/index.js';

const FILES = ['shared/types.ts', 'src/api/a.ts', 'src/api/b.ts', 'src/ui/c.ts', 'src/ui/d.ts', 'README.md'];
const repo = (files = FILES, regionPaths = ['src/api/a.ts', 'src/api/b.ts', 'src/ui/c.ts', 'src/ui/d.ts', 'shared/types.ts']) =>
  ({ files: (ref: string) => (ref === 'main' ? files : (() => { throw new Error(`unknown ref ${ref}`); })()), regions: regionPaths.length, regionPaths });

const task = (id: string, extra: string) => `  - id: ${id}
    title: Task ${id}
    done: tests pass
    prompt: |
      do ${id}
${extra}`;
const doc = (tasks: string, head = 'goal: Build it\nsources: [docs/design.md]\ntest: npm test\ncompile: npx tsc --noEmit\nbase: main') =>
  `---\n${head}\ntasks:\n${tasks}---\nNotes here.\n`;

const GOOD = doc([
  task('api', '    owns: [src/api/**]\n    reads: [shared/types.ts]\n    after: []\n'),
  task('ui', '    owns: [src/ui/c.ts]\n    reads: [shared/types.ts, src/api/a.ts]\n    after: [api]\n'),
  task('docs', '    owns: [docs/**]\n    reads: [README.md]\n'),
].join(''));

const check = (text: string, r = repo()) => { const { plan, problems } = parseTeamPlan(text); expect(problems).toEqual([]); return checkTeamPlan(plan!, r); };

test('a complete 3-task plan parses and passes', () => {
  const { plan, problems } = parseTeamPlan(GOOD);
  expect(problems).toEqual([]);
  expect(plan).toMatchObject({ goal: 'Build it', sources: ['docs/design.md'], test: 'npm test', compile: 'npx tsc --noEmit', base: 'main', body: 'Notes here.\n' });
  expect(plan!.tasks.map((t) => [t.id, t.after])).toEqual([['api', []], ['ui', ['api']], ['docs', []]]);
  expect(plan!.tasks[0].prompt).toBe('do api\n');
  expect(checkTeamPlan(plan!, repo())).toEqual({ ok: true, problems: [], warnings: [] });
});

test('bad YAML is a front matter problem, never a throw; tasks must be a list', () => {
  const bad = parseTeamPlan('---\ngoal: [unclosed\n---\n');
  expect(bad.plan).toBeNull();
  expect(bad.problems).toHaveLength(1);
  expect(bad.problems[0]).toMatch(/^front matter: /);
  expect(parseTeamPlan('no front matter at all').problems).toEqual(['front matter: missing (the file must start with ---)']);
  expect(parseTeamPlan('---\ngoal: x\ntest: t\ntasks: nope\n---\n').problems).toEqual(['tasks must be a list']);
});

test('task <id>: missing <field>', () => {
  const r = check(doc('  - id: a\n    title: A\n    reads: [shared/types.ts]\n    prompt: go\n'));
  expect(r.ok).toBe(false);
  expect(r.problems).toEqual(['task a: missing owns', 'task a: missing done']);
  expect(check(doc('  - title: A\n    owns: [x/**]\n    reads: [README.md]\n    done: d\n    prompt: p\n')).problems).toEqual(['task #1: missing id']);
});

test('overlapping owns with no after ordering between them', () => {
  const r = check(doc(task('a', '    owns: [src/**]\n    reads: [README.md]\n') + task('b', '    owns: [src/ui/**]\n    reads: [README.md]\n')));
  expect(r.problems).toEqual(['tasks a and b both own src/** and neither is after the other']);
  // ordered (even transitively) is fine
  expect(check(doc(task('a', '    owns: [src/**]\n    reads: [README.md]\n') + task('m', '    owns: [m/**]\n    reads: [README.md]\n    after: [a]\n')
    + task('b', '    owns: [src/ui/**]\n    reads: [README.md]\n    after: [m]\n'))).problems).toEqual([]);
});

test('reads a path that does not exist and no earlier task owns', () => {
  const r = check(doc(task('a', '    owns: [gen/**]\n    reads: [shared/missing.ts]\n') + task('b', '    owns: [x/**]\n    reads: [gen/out.ts]\n')));
  expect(r.problems).toEqual([
    'task a reads shared/missing.ts, which does not exist on main and no earlier task owns it',
    'task b reads gen/out.ts, which does not exist on main and no earlier task owns it',
  ]);
  // once b is after a, a owns gen/** first
  expect(check(doc(task('a', '    owns: [gen/**]\n    reads: [shared/types.ts]\n') + task('b', '    owns: [x/**]\n    reads: [gen/out.ts]\n    after: [a]\n'))).problems).toEqual([]);
  // a directory that exists counts
  expect(check(doc(task('a', '    owns: [z/**]\n    reads: [src/api]\n'))).problems).toEqual([]);
});

test('after: cycle and unknown ids', () => {
  const r = check(doc(task('a', '    owns: [a/**]\n    reads: [README.md]\n    after: [b]\n') + task('b', '    owns: [b/**]\n    reads: [README.md]\n    after: [a]\n')));
  expect(r.problems).toEqual(['after: cycle a → b → a']);
  expect(check(doc(task('a', '    owns: [a/**]\n    reads: [README.md]\n    after: [ghost]\n'))).problems).toEqual(['task a: after names unknown task ghost']);
});

test('test is missing', () => {
  expect(check(doc(task('a', '    owns: [a/**]\n    reads: [README.md]\n'), 'goal: g\nbase: main')).problems).toEqual(['test is missing']);
});

test('empty repo rule: no code under any reads path needs a scaffold task first', () => {
  const empty = repo(['README.md'], []);
  const two = task('a', '    owns: [a/**]\n    reads: [lib/core.ts]\n') + task('b', '    owns: [b/**]\n    reads: [lib/core.ts]\n');
  expect(check(doc(two), empty).problems).toContain('empty repo: no code on main under any reads path; add a scaffold task first');
  // a scaffold task that owns lib/** and that every other task comes after
  const scaffolded = task('scaffold', '    owns: [lib/**]\n    reads: [README.md]\n')
    + task('a', '    owns: [a/**]\n    reads: [lib/core.ts]\n    after: [scaffold]\n') + task('b', '    owns: [b/**]\n    reads: [lib/core.ts]\n    after: [scaffold]\n');
  expect(check(doc(scaffolded), empty)).toMatchObject({ ok: true, problems: [] });
});

test('warnings: owns over 40% of regions; no reads', () => {
  const r = check(doc(task('big', '    owns: [src/**]\n    reads: [README.md]\n') + task('lone', '    owns: [shared/**]\n    after: [big]\n')));
  expect(r.ok).toBe(true);
  expect(r.warnings).toEqual(['task big owns 80% of indexed regions', 'task lone has no reads']);
});

test('an unknown base is a problem, not a throw', () => {
  expect(check(doc(task('a', '    owns: [a/**]\n    reads: [README.md]\n'), 'goal: g\ntest: t\nbase: nope')).problems).toEqual(['base nope is not a commit in this repo']);
});

test('listPlans reads .loom/plans/*.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-plans-'));
  mkdirSync(join(root, '.loom/plans'), { recursive: true });
  writeFileSync(join(root, '.loom/plans/build.md'), GOOD);
  writeFileSync(join(root, '.loom/plans/broken.md'), '---\n: : :\n---\n');
  writeFileSync(join(root, '.loom/plans/notes.txt'), 'ignored');
  expect(listPlans(root)).toEqual([{ slug: 'broken', goal: '', tasks: 0 }, { slug: 'build', goal: 'Build it', tasks: 3 }]);
  expect(listPlans(mkdtempSync(join(tmpdir(), 'loom-noplans-')))).toEqual([]);
});

// keep the exported type in use so a rename breaks this file
export const _t: TeamPlan | null = null;
