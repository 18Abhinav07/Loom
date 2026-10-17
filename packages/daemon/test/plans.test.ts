// B3 §3.3: GET /plans, GET /plans/:slug, POST /plans/check read the caller's repo; a malformed plan is 200 ok:false.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { ensureLoomDir, repoId } from '@loom/memory';
import { startServer } from '../src/server.js';
import { git, gitTree, tmpRecord } from './helpers.js';

const home = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'pln' }));
let db: LoomDb; let srv: { port: number; close(): Promise<void> }; let url: string; let r: string;
const PLAN = `---
goal: Split the API
test: npm test
base: main
tasks:
  - id: api
    title: API
    owns: [src/api/**]
    reads: [src/shared.ts]
    done: tests pass
    prompt: do the api
  - id: ui
    title: UI
    owns: [src/ui/**]
    reads: [src/shared.ts]
    after: [api]
    done: tests pass
    prompt: do the ui
---
why: notes
`;
beforeAll(async () => {
  db = await LoomDb.connect();
  srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord(), home });
  url = `http://127.0.0.1:${srv.port}`;
  r = gitTree({ 'src/shared.ts': 'export type A = 1;\n' });
  git(r, 'branch', '-M', 'main');
  ensureLoomDir(r, { repoId: repoId(r), dirs: ['src'], excludes: [], testCmd: 'npm test', share: true });
  mkdirSync(join(r, '.loom/plans'), { recursive: true });
  writeFileSync(join(r, '.loom/plans/split.md'), PLAN);
  writeFileSync(join(r, '.loom/plans/bad.md'), '---\ntasks: [\n---\n');
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'loom init');
});
afterAll(async () => { await srv.close(); await db.close(); });
const H = { 'content-type': 'application/json', 'x-loom-home': home };
const check = (b: object) => fetch(`${url}/plans/check`, { method: 'POST', headers: H, body: JSON.stringify({ cwd: r, ...b }) });

test('GET /plans lists .loom/plans; GET /plans/:slug returns text and parsed plan; unknown slug 404', async () => {
  expect(await (await fetch(`${url}/plans?cwd=${encodeURIComponent(r)}`, { headers: H })).json())
    .toEqual([{ slug: 'bad', goal: '', tasks: 0 }, { slug: 'split', goal: 'Split the API', tasks: 2 }]);
  const one = await (await fetch(`${url}/plans/split?cwd=${encodeURIComponent(r)}`, { headers: H })).json();
  expect(one).toMatchObject({ slug: 'split', text: PLAN, problems: [], plan: { goal: 'Split the API', body: 'why: notes\n' } });
  expect((await fetch(`${url}/plans/nope?cwd=${encodeURIComponent(r)}`, { headers: H })).status).toBe(404);
  expect((await fetch(`${url}/plans?cwd=${encodeURIComponent(tmpdir())}`, { headers: H })).status).toBe(404);
});

test('POST /plans/check by slug, by file and by text; files come from git at base', async () => {
  const ok = await (await check({ slug: 'split' })).json();
  expect(ok).toMatchObject({ ok: true, problems: [], warnings: [] });
  expect((await (await check({ file: '.loom/plans/split.md' })).json()).ok).toBe(true);
  const missing = await (await check({ text: PLAN.replace('reads: [src/shared.ts]\n    done: tests pass\n    prompt: do the api', 'reads: [src/gone.ts]\n    done: tests pass\n    prompt: do the api') })).json();
  expect(missing.problems).toEqual(['task api reads src/gone.ts, which does not exist on main and no earlier task owns it']);
});

test('a malformed plan is 200 ok:false with the parse problem', async () => {
  const res = await check({ slug: 'bad' });
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.ok).toBe(false);
  expect(j.problems[0]).toMatch(/^front matter: /);
  expect(await (await check({ slug: 'absent' })).json()).toMatchObject({ ok: false });
});

test('POST /plan without a plan file is refused (the goal → LLM planner is gone)', async () => {
  const res = await fetch(`${url}/plan`, { method: 'POST', headers: H, body: JSON.stringify({ goal: 'do things', cwd: r }) });
  expect(res.status).not.toBe(200);
});
