// P3 Task 4: plan loading, full-text scope, WCC partition and betweenness hubs (plan 03 Task 4).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb, type LoomGraph } from '@loom/core';
import { Coordinator } from '../../daemon/src/coordinator.js';
import { gitTree } from '../../daemon/test/helpers.js';
import { loadPlan, partition, scope } from '../src/index.js';

const T = 'django/utils/text.py', H = 'django/utils/html.py', D = 'django/utils/dates.py';
let db: LoomDb; let g: LoomGraph;
beforeAll(async () => {
  db = await LoomDb.connect(); g = db.graph(`test:planner:${Date.now()}`);
  const root = gitTree({
    [T]: 'def slugify(value, allow_unicode=False):\n    """Convert to ASCII and make a URL slug."""\n    return value\n\ndef capfirst(x):\n    return x\n',
    [H]: 'from django.utils.text import slugify\n\ndef title_slug(t):\n    return slugify(t)\n',
    [D]: 'def iso(d):\n    """Strict mode helper: uses strict values, converts strict mode values."""\n    return d\n'
      + '\ndef tz_a():\n    return tz_b()\n\ndef tz_b():\n    return tz_c()\n\ndef tz_c():\n    return 0\n',
  });
  const c = await Coordinator.create(g, 'r'); await c.indexBase(root, ['django']);
});
afterAll(async () => { await g.drop(); await db.close(); });

test('4.1 scope by full text; WCC components; betweenness hub owned by the first task; a shared symbol wins', async () => {
  expect(await scope(g, { id: 't', title: 'add strict flag to slugify', prompt: '' })).toContain(`${T}::slugify`);
  // a symbol the task writes as code outranks docstrings that merely repeat the prompt's common words
  expect(await scope(g, { id: 't', title: 'add a strict mode to slugify',
    prompt: 'In django/utils/text.py extend `slugify(value)`; the helper uses strict mode values' }, 1))
    .toEqual([`${T}::slugify`]);
  const p = await partition(g, new Map([['T1', [`${T}::slugify`]], ['T2', [`${H}::title_slug`]], ['T3', [`${D}::iso`]]]));
  expect(p.components).toEqual([['T1', 'T2'], ['T3']]);
  expect(p.hubs).toContain(`${T}::slugify`);
  expect(p.hubOwner[`${T}::slugify`]).toBe('T1');
  // a symbol every task scopes is the contested one: it is the hub even when an unshared chain has more betweenness
  const q = await partition(g, new Map([['T1', [`${T}::slugify`]], ['T2', [`${T}::slugify`, `${D}::tz_b`]], ['T3', [`${T}::slugify`]]]));
  expect(q.hubs).toEqual([`${T}::slugify`]);
  expect(q.hubOwner[`${T}::slugify`]).toBe('T1');
  const [r] = await g.query<{ n: number }>('MATCH (n:Scoped) RETURN count(n) AS n');
  expect(r.n).toBe(0);
});

test('4.2 Lucene metacharacters in a title are escaped, not thrown', async () => {
  expect(await scope(g, { id: 't', title: 'change slugify(value, *, strict) [x]', prompt: '' })).toContain(`${T}::slugify`);
});

test('4.3 loadPlan rejects a duplicate task id', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'loom-plan-')), 'p.yaml');
  writeFileSync(f, 'tasks:\n  - {id: a, title: x, prompt: y}\n  - {id: a, title: z, prompt: w}\n');
  expect(() => loadPlan(f)).toThrow(/duplicate task id/);
});
