# P2 — Repo Graph, `.loom/` Memory and Sync: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (the chosen method) or superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One FalkorDB graph per repo and tenant holds regions, a Version DAG and the team's session records. The records travel in git through `.loom/sessions/*.jsonl`. `loom sync` turns them, plus the commits made outside Loom, into a briefing of at most 25 lines at session start.

**Architecture:** A new package, `@loom/memory`, has no daemon dependency. It is made of pure functions over `LoomGraph` and `git`: ids/config, session files, indexing, import, git hooks, pre/post-commit, sync, news/briefing and lessons. The CLI calls it directly from the git hooks, and the daemon calls it from the Claude SessionStart/SessionEnd hooks. Live coordination (leases on regions, the version check, handover) is out of scope here; that is P3. The run-mode coordinator stays as it is until P3, with one exception: its lessons move to the repo graph (C1).

**Tech stack:** TypeScript (ESM), pnpm workspace, vitest 2.1.8, tsx 4.19.2, FalkorDB 6.x (docker `loom-falkordb-1`), git ≥ 2.40, `@loom/indexer` region API (P1).

**Spec:** `docs/specs/2026-10-15-loom-v2-design.md` §4, §5, §6.1–§6.4, §6.10, §10 (L0 memory parts, I1), §11.

## Global Constraints

- Graph name: `loom:<tenant>:<repoId>`. `repoId` is the lexicographically smallest root commit sha. It is computed once by `loom init` and stored in `.loom/config.json`. Init refuses a repo with no commits. (§4.1)
- `tenant` comes from `~/.loom/config.json` `{"tenant": …}` and defaults to `$USER`. Tests override the home directory with `LOOM_HOME`. (§4.1)
- API calls never name a graph. The daemon resolves it from the session's registration (cwd → `.loom/config.json` + tenant). (§4.1, I1)
- Event line: `{"v":1,"type":…,"id":<ulid>,"at":<epoch ms>}`. Types are `session agent task version decision evidence lesson message handoff`. (§5.1)
- Session files are `.loom/sessions/<session-ulid>.<writer>.jsonl`, with one writer per file. `<writer>` is `main` for an interactive session, the agent name for a run agent, or `coord`. (§5)
- `.loom/.gitattributes` contains `sessions/*.jsonl merge=union` and `regions.lock merge=union`. (§5, S-7)
- `share: false` writes `.loom/sessions/` to `.git/info/exclude`; the lock stays shared. (§5)
- Import is idempotent: `MERGE` on the event id. It is skipped when `(:Imported {key})` exists for the file's content and commit key. (§5.2)
- A line's commit comes from `git blame --line-porcelain` on the session file. A line that is not committed has commit `null`. (§5.1, S-18)
- Version id = event id (ulid), or `ext:<commit>:<region>` for an external version. `PREV` gives a DAG. "Current" is per ref: the newest Version of R whose commit is an ancestor of the ref. (§4.3)
- Init baseline: one external Version per region at HEAD. History before init is not reconstructed. (§6.1 step 4)
- Reconcile is capped at 200 commits per ref. Past the cap, each region gets one external Version spanning the range, with `by` = "N authors". (§6.3 step 4)
- News score: 3 = the region is in the SCOPE of one of my open tasks; 2 = it is within 2 CALLS/IMPORTS hops of one; 1 = it is in a file I touched in my last 3 sessions. Ties break by recency; keep the top 10. After a fresh init, the news is the latest handoff of each other person. (§6.3 step 5)
- The briefing follows the §6.4 template, deterministic, at most 25 lines.
- Fetch is best effort, with a 5 s timeout (`spawnSync` timeout, S-20). The upstream is `@{upstream}`, else `origin/<default>`. (§6.3 step 1)
- Hooks fail open. Claude tool hooks use a 2 s client timeout. Git hooks never block a commit because Loom failed. (§2, R17)
- Lessons live in the repo graph and `.loom/` only. There is no global `lessons` graph. (§6.10, C1)
- No `ANTHROPIC_*` variables and no paid API anywhere. Nothing in P2 spawns an agent.

## Rulings made while planning (spec gaps, decided here)

1. **SessionStart timeout.** The 2 s hook budget (R17) can't fit a 5 s fetch. SessionStart gets a 10 s client timeout (`LOOM_HOOK_TIMEOUT_MS_START`, default 10000); every other event gets 2 s. *Cost if wrong:* a slow session start, never a blocked edit.
2. **Hooks file.** §6.1 step 5 says project `.claude/settings.json`, but the hook command holds an absolute path to this machine's Loom install, and committing it breaks every collaborator. Keep `.claude/settings.local.json`, git-excluded (v1 behaviour, covered by init.test). *Cost if wrong:* every clone runs `loom init`, which §6.1 already requires.
3. **A Version can be in several commits.** After a rebase, the same event line lives in the old and the new commit, and both may be reachable from some ref. So `Version.commits` is a list, and `IN` edges go to each. Current-per-ref means *any* of its commits is an ancestor. *Cost if wrong:* none found. It is strictly more correct than a single commit.
4. **The import key includes the file's last commit.** `Imported.key = <file>@<blob>@<rev-list -1 <ref> -- file>`. A rebase keeps the blob but changes the commit, so a blob-only key would keep stale commits (S-18). *Cost if wrong:* one extra `rev-list` per file per sync.
5. **`ord` is computed when queried** (max(prev.ord)+1 over the DAG), not stored, because the PREV targets of an event may arrive in a later import. It is display-only (§4.3).
6. **No active session means pre-commit writes nothing.** Pre-commit finds the session through `<git-dir>/loom/session.json`, written by SessionStart and removed by SessionEnd. git-dir is per worktree, so this is per worktree. A commit made with no session is reconciled as external at the next sync (§4.6). *Cost if wrong:* a human's commit shows as an external version by the git author, which is the spec's behaviour for edits made outside Loom.
7. **`at` is epoch ms (number).** Comparisons and ordering are numeric.
8. **The PreToolUse matcher is `Edit|Write|MultiEdit|NotebookEdit|Bash`** (S-22). P2 only sets the matcher; the Bash handling is in P3.
9. **(Execution) Bulk writes use CREATE-if-absent, never UNWIND … MERGE onto hub nodes.** The Task 3 code as first written hung FalkorDB on Django: one `MERGE (v)-[:IN]->(c)` per region onto a single Commit node is quadratic. `writeRegions`, `writeEdges` and `baseline` were rewritten batched (P2-11). Later tasks that write many edges onto one Commit/Person/Session node follow the same pattern. *Cost if wrong:* none found; the tests are unchanged and pass.
10. **(Execution, Task 4) Fan-out uses FOREACH, not chained UNWIND.** As planned, `decision` ran `UNWIND $regions … WITH DISTINCT d UNWIND $led_to`: an empty `regions` gives zero rows, so `LED_TO` is silently dropped. All list fan-outs became `FOREACH`. A regression test was added (decision with no regions). The idempotence test compared `count(n)` with itself, a tautology; it now compares node and edge counts before and after the second import. *Cost if wrong:* none; it is stricter.
11. **(Execution, Task 5) Hook order assertion.** The plan asserted `log[0] === 'MINE'`, but pre-commit (loom, no user hook) fires before post-commit, so line 0 is loom's pre-commit. The test now asserts the user's post-commit runs before loom's post-commit, which is what the claim actually says. *Cost if wrong:* none.
12. **(Execution, Task 6) Rename targets get a version.** `diffRegions` puts a pure-rename target in neither `created` nor `updated`. As planned, `preCommit` therefore never versioned `f2`. `changed` now includes `renamed[].to`, and `prev` is looked up on the old id's lineage. *Cost if wrong:* none; it is what §3.4 says.
13. **(Execution, Task 6) File text is read byte-exact.** `git()` trims the final newline. As planned, `git show :path` handed regionize altered text, which changed region hashes (a pure rename read as delete + create) and wrote a wrong blob sha into the lock. Added `showRaw` (spawnSync, untouched stdout); a test pins the lock blob to `git rev-parse :a.py` and failed against the old code. Any later code reading file contents from git uses `showRaw`. *Cost if wrong:* none.
14. **(Execution, Task 8) `sync` refreshes HEAD only on regions with non-baseline versions.** As planned it called `refreshHead(g, root)`, which costs one query per region: 81k on Django, every sync. Only regions with an imported or reconciled version can have moved. *Cost if wrong:* a region whose only version is the baseline keeps its baseline HEAD, which is correct.
15. **(Execution, Task 8) Agent `sid/x` is linked RAN from Session `sid` on version and decision import.** Without an `agent` event the version's person resolved to the agent id, and the X2 briefing said "by <sid>/main" instead of "by A@t". This was RED without the link and GREEN with it. *Cost if wrong:* none; the agent id is derived from the sid by construction.
16. **(Execution, Task 8) "Latest handoff" ties on `at` are broken by id.** Two handoffs in the same millisecond picked the first one. ULIDs are monotonic, so a larger id means later. *Cost if wrong:* none.
17. **(Execution, Task 8) The X2 test ran `ensureLoomDir(b)` before `pull`.** The untracked `.loom` files blocked the pull. It now runs after the pull, which is the real order (`loom init` on an existing clone). Degraded listing uses `coalesce(r.tombstoned, false)`, because stub regions have no flag. *Cost if wrong:* none.
18. **(Execution, Task 9) `status --porcelain -uall` wherever `.loom/` dirtiness or a session path is read.** A wholly-untracked `.loom/` collapses to `?? .loom/` without `-uall`, so the sid regex finds nothing. Added `packages/memory/tsconfig.json`, which was missing; `tsc --noEmit` is clean. *Cost if wrong:* none.
19. **(Execution, Task 10) The I1 test gives tenant B its own clone.** The plan ran both tenants in one worktree. B's SessionStart sync then imported A's uncommitted `.loom/sessions/*.jsonl` lesson, and B's `/repo/lessons` returned it (RED at `i1.test.ts:30`). That is the repo-record channel working as designed, not a graph leak. A tenant is another OS user with their own clone, and records reach them only through git. The fix is that B clones A after `loom init` is committed. *Cost if wrong:* if two tenants really share one checkout, they share its `.loom/` records. That is documented, never through the graph.
20. **(Execution, Task 10) `resolveRepo` requires `cfg.repoId`.** A v1 attach config (`run`, no `repoId`) keeps the v1 `runFor` path. A v2 config (no `run`) makes `runFor` return null, so the two never collide. `x-loom-home` is test-only: one test process acts as two tenants. No route accepts a graph name. *Cost if wrong:* none.
21. **(Execution, Task 10) The global `lessons` graph is removed; a run's lessons live in the run's graph (C1 fixed).** `/lessons` now needs `run` (400 without it). The CLI `lesson add|rm|list` and the dashboard pass it. `vitest.setup.ts` existed only to isolate the global graph per test file and is deleted. The server test `a default run is told earlier runs' lessons` asserted the v1 leak. It is inverted to `lessons stay in their run graph (C1 fixed)`: a lesson in run `old` is not told in run `other`, and one in the run's own graph is. *Cost if wrong:* cross-run learning is lost until P3 moves runs into the repo graph, where lessons are shared per repo.
22. **(Execution, Task 10) A stale v1 `lessons` graph exists on dev machines** (3 lessons, about 6.7 h old, no daemon listening). The I1 assertion checks that nothing creates it and that A's secret is never written to it. It does not require the graph to be absent. User data is not deleted. *Cost if wrong:* none.
23. **(Execution, Task 10) Hook timeouts: SessionStart 10 s, every other hook 2 s** (was 5 s for all). The fail-open test was RED at 5,292 ms and GREEN at 2,286 ms. `packages/hook/dist` was rebuilt. *Cost if wrong:* a slow daemon on PreToolUse is skipped (fail open). The pre-commit hook stays the hard check.
24. Task 11: `.loom/` is no longer added to `info/exclude`. v2 tracks it, and init tells the user to commit it. Cost if wrong: the files show as untracked until committed.
25. Task 11: `UserPromptSubmit` and `Stop` stay in `EVENTS`, because the v1 run mode (`server.ts` onHook) still serves them. The test key list includes them. Remove them in P3 with `run`.
26. Task 11: a v1 `.loom/config.json` without `repoId` is upgraded in place: v2 defaults, then the v1 keys, then `repoId`. `ensureLoomDir` still never rewrites a config that has a `repoId`.
27. Task 11: `dirs` = `pyDirs(root)`, falling back to `['.']` when the repo has no Python package dirs.
28. Task 11: `loom lesson` uses the v2 repo graph when the repo config has a `repoId` and neither `--symbol` nor `--run` is given; otherwise it takes the v1 daemon path, unchanged. `lesson rm` stays v1-only.
29. Task 11: `loom sync` passes `quiet` to `sync()` when `--json` is set, so stdout is one JSON line. Without `--json`, `sync()` prints the briefing itself. Cost: no fetch-failure warning in `--json` mode (the `fetched` field carries it).
30. Task 11: init pings and starts FalkorDB *before* `initRepo`, because init now writes the graph. A v2 repo's interactive SessionStart (no `x-loom-run`) takes the v2 briefing path; every other hook event still goes to v1 attach.
31. Task 12: the L0 gate refuted "hooks never dirty a tracked file". `sync` rewrote `.loom/regions.lock` from the worktree, and post-checkout/post-merge run sync, so `git pull --rebase` aborted mid-rebase. Only `init` and `pre-commit` write the lock now; sync reads it and reparses misses without storing them. Cost if wrong: files with uncommitted edits are reparsed on each sync (only those files).
32. Task 12: the gate runs the git hooks through the *bundled* CLI (`node packages/cli/dist/loom.cjs`), not `npx tsx …/loom.ts`. That is what users install, and `main()` runs only when argv[1] ends in `loom.cjs`. The gate needs `pnpm build:cli` first.
33. Task 12: every `loom hook git` gets FalkorDB within 1.5 s or does without it. pre-commit still writes events (graph null); the other hooks print `[loom] <hook>: FalkorDB unreachable; continuing` and exit 0.

## Review Focus

1. **Rebase or amend after import:** a version event that was already imported must end up with the rewritten commit in `commits[]`, and current-per-ref on the new HEAD must find it. Test in Task 4.
2. **Union-merge leftovers in a session file:** a duplicate line (the same id twice) and a line cut mid-JSON by a manual conflict resolution. Import keeps one event per id, skips the broken line with a warning, and never throws. Test in Task 2.
3. **Commit with partial staging (`git add -p`):** pre-commit versions the *index* text, not the worktree text. Test in Task 6.
4. **Daemon or FalkorDB down during a git hook:** the commit still succeeds, a one-line warning goes to stderr, and the next sync repairs the state (the version events are already in the file). Test in Task 6.
5. **Tenant isolation through the HTTP API:** a request carrying another tenant's session id, a forged `x-loom-run` header, or a graph name in the body never reads another graph. Test in Task 10 (I1).

---

## File structure

```
packages/memory/
  package.json                # @loom/memory, deps @loom/core @loom/indexer
  src/index.ts                # barrel
  src/ids.ts                  # ulid, repoId, tenant, graphName
  src/config.ts               # .loom/config.json read/write, ensureLoomDir (+ .gitattributes, share:false)
  src/events.ts               # event types, appendEvent, parseEvents
  src/git.ts                  # git(), gitTry(), blame(), isAncestor() with cache
  src/graph.ts                # REPO_INDEXES, ensureRepoSchema, writeRegions, writeEdges
  src/indexrepo.ts            # indexRepo (lock-checked reparse) + baseline
  src/importer.ts             # importSessions (worktree | ref), event → graph
  src/versions.ts             # currentVersion, ordOf, history
  src/githooks.ts             # installGitHooks (chain .pre-loom, core.hooksPath)
  src/commit.ts               # preCommit, postCommit, postRewrite
  src/reconcile.ts            # external versions for watermark..HEAD, HEAD..upstream
  src/news.ts                 # news scoring + renderBriefing
  src/sync.ts                 # sync(): fetch → import → reparse → reconcile → news → watermark
  src/lessons.ts              # repo-scoped lessons (graph + .loom events)
  src/session.ts              # startSession, finishSession (handoff), active-session file
  test/helpers.ts             # repo(), clone(), testGraph()
  test/*.test.ts
packages/core/src/schema.ts   # + REPO_INDEXES export (Symbol indexes stay for P3's migration)
packages/daemon/src/server.ts # repo resolution per session; SessionStart/SessionEnd → @loom/memory; lessons from repo graph
packages/daemon/src/repo.ts   # resolveRepo(cwd) → { root, cfg, graph }  (the only place a graph name is built)
packages/hook/src/loom-hook.ts# 2 s default, 10 s SessionStart
packages/cli/src/loom.ts      # init (§6.1), sync, brief, finish, hook git, lesson (repo-scoped)
docs/proofs/LEDGER.md         # P2-* rows
```

---

### Task 0: Smoke, before any code

Done on 2026-10-15. These are the ledger rows the tasks rely on: S-6, S-7, S-10, S-18, S-19, S-20, S-21, S-22, S-23, and **S-24**, added now:

| ID | Claim | Status | Evidence |
|---|---|---|---|
| S-24 | The repo graph holds a full Django index fast enough for `loom init` | proven | `packages/indexer/smoke/ingest.ts` (throwaway): 2,827 files (django+tests) → 77,086 regions, 117,218 edges; parse 2.9 s, node write 0.9 s, edge write 1.3 s (UNWIND batches of 2,000 on an indexed `Region.id`); 3-hop CALLS query 32 ms |

- [ ] **Step 1:** add the S-24 row to `docs/proofs/LEDGER.md` under Smoke.

---

### Task 1: Package, ids and config

**Files:**
- Create: `packages/memory/package.json`, `src/index.ts`, `src/ids.ts`, `src/config.ts`, `src/git.ts`, `test/helpers.ts`, `test/ids.test.ts`

**Interfaces:**
- Produces:
  - `ulid(now?: number): string`
  - `repoId(root: string): string` (throws `no commits`)
  - `tenant(): string`
  - `graphName(tenant: string, repoId: string): string`
  - `LoomConfig { repoId: string; dirs: string[]; excludes: string[]; testCmd: string | null; share: boolean }`
  - `readConfig(root): LoomConfig | null`
  - `ensureLoomDir(root, cfg: LoomConfig): void`
  - `git(cwd, ...a): string`
  - `gitTry(cwd, ...a): string | null`
  - `isAncestor(root, a, b): boolean` (cached)
  - `blame(root, file, ref: string | null): Array<{ commit: string | null; text: string }>`

- [ ] **Step 1: Package scaffolding**

`packages/memory/package.json`:
```json
{
  "name": "@loom/memory",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": { "@loom/core": "workspace:*", "@loom/indexer": "workspace:*" }
}
```
Run: `cd /Users/18abhinav07/Documents/loom-v2 && pnpm install --offline`
Expected: `packages/memory/node_modules/@loom/core` and `@loom/indexer` are symlinked.

`packages/memory/test/helpers.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LoomDb, type LoomGraph } from '@loom/core';
import { ulid } from '../src/ids.js';

export const sh = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@t', '-c', 'user.name=A', ...a], { cwd, encoding: 'utf8' }).trim();
export const as = (who: string) => (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', `user.email=${who}@t`, '-c', `user.name=${who}`, ...a], { cwd, encoding: 'utf8' }).trim();
export function write(root: string, files: Record<string, string>) {
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(root, dirname(f)), { recursive: true }); writeFileSync(join(root, f), t); }
}
/** A git repo on `main` with one commit holding `files`. */
export function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'loom-mem-'));
  write(d, files); sh(d, 'init', '-q', '-b', 'main'); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', 'base', '--allow-empty');
  return d;
}
/** origin (bare) + two clones a, b — the X2 shape. */
export function pair(files: Record<string, string>) {
  const src = repo(files); const origin = `${src}.git`;
  sh(src, 'clone', '-q', '--bare', src, origin);
  const a = `${src}-a`, b = `${src}-b`;
  sh(src, 'clone', '-q', origin, a); sh(src, 'clone', '-q', origin, b);
  return { origin, a, b };
}
let db: LoomDb | null = null;
export async function testGraph(): Promise<LoomGraph> { db ??= await LoomDb.connect(); return db.graph(`loom:test:${ulid()}`); }
export async function closeDb() { await db?.close(); db = null; }
```

- [ ] **Step 2: Write the failing test** — `packages/memory/test/ids.test.ts`
```ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ulid, repoId, tenant, graphName } from '../src/ids.js';
import { ensureLoomDir, readConfig } from '../src/config.js';
import { repo, sh } from './helpers.js';

afterEach(() => { delete process.env.LOOM_HOME; });

test('ulid: 26 Crockford chars, strictly increasing within one millisecond', () => {
  const ids = Array.from({ length: 1000 }, () => ulid(1_700_000_000_000));
  expect(ids.every((i) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(i))).toBe(true);
  expect([...ids].sort()).toEqual(ids);
  expect(new Set(ids).size).toBe(1000);
});

test('repoId: refuses a repo with no commits; smallest root sha with two roots', () => {
  const empty = mkdtempSync(join(tmpdir(), 'loom-e-')); sh(empty, 'init', '-q', '-b', 'main');
  expect(() => repoId(empty)).toThrow(/no commits/);
  const r = repo({ 'a.py': 'x = 1\n' });
  const root1 = sh(r, 'rev-list', '--max-parents=0', 'HEAD');
  sh(r, 'checkout', '-q', '--orphan', 'other'); sh(r, 'commit', '-qm', 'second root', '--allow-empty');
  sh(r, 'checkout', '-q', 'main'); sh(r, 'merge', '-q', '--allow-unrelated-histories', '-m', 'm', 'other');
  const roots = sh(r, 'rev-list', '--max-parents=0', 'HEAD').split('\n').sort();
  expect(roots).toContain(root1);
  expect(repoId(r)).toBe(roots[0]);
});

test('tenant: ~/.loom/config.json wins, else $USER; graphName shape', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-h-')); process.env.LOOM_HOME = home;
  expect(tenant()).toBe(process.env.USER);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ tenant: 'abhinav' }));
  expect(tenant()).toBe('abhinav');
  expect(graphName('abhinav', 'f00')).toBe('loom:abhinav:f00');
});

test('config: written once, repoId kept even when history changes; .gitattributes; share:false excludes sessions', () => {
  const r = repo({ 'a.py': 'x = 1\n' });
  ensureLoomDir(r, { repoId: 'r1', dirs: ['.'], excludes: [], testCmd: null, share: false });
  ensureLoomDir(r, { repoId: 'r2', dirs: ['.'], excludes: [], testCmd: null, share: true });
  expect(readConfig(r)!.repoId).toBe('r1');
  expect(readFileSync(join(r, '.loom/.gitattributes'), 'utf8')).toBe('sessions/*.jsonl merge=union\nregions.lock merge=union\n');
  expect(readFileSync(join(r, '.git/info/exclude'), 'utf8')).toMatch(/^\.loom\/sessions\/$/m);
  expect(existsSync(join(r, '.loom/sessions'))).toBe(true);
});
```

- [ ] **Step 3: Run it to see it fail**
Run: `cd /Users/18abhinav07/Documents/loom-v2 && npx vitest run packages/memory/test/ids.test.ts`
Expected: FAIL. "Failed to load url ../src/ids.js".

- [ ] **Step 4: Implement**

`packages/memory/src/git.ts`:
```ts
import { execFileSync, spawnSync } from 'node:child_process';

export const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 }).replace(/\n$/, '');
export function gitTry(cwd: string, ...a: string[]): string | null { try { return git(cwd, ...a); } catch { return null; } }

const anc = new Map<string, boolean>();
/** `a` is an ancestor of (or equal to) `b`. Cached: commits are immutable. */
export function isAncestor(root: string, a: string, b: string): boolean {
  const k = `${a}>${b}`;
  if (!anc.has(k)) anc.set(k, spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root }).status === 0);
  return anc.get(k)!;
}

const ZERO = /^0{40}$/;
/** One blame call per file: each line with the commit that introduced it (null = not committed). */
export function blame(root: string, file: string, ref: string | null): Array<{ commit: string | null; text: string }> {
  const out = git(root, 'blame', '--line-porcelain', ...(ref ? [ref] : []), '--', file);
  const rows: Array<{ commit: string | null; text: string }> = [];
  let sha = '';
  for (const l of out.split('\n')) {
    if (l.startsWith('\t')) rows.push({ commit: ZERO.test(sha) ? null : sha, text: l.slice(1) });
    else if (/^[0-9a-f]{40} \d+ \d+/.test(l)) sha = l.slice(0, 40);
  }
  return rows;
}
```

`packages/memory/src/ids.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gitTry } from './git.js';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastT = -1; let lastR: number[] = [];
/** Monotonic ulid: within one millisecond the random part is incremented, so ids sort in creation order. */
export function ulid(now = Date.now()): string {
  if (now === lastT) { let i = 15; while (lastR[i] === 31) lastR[i--] = 0; lastR[i]++; }
  else { lastT = now; lastR = [...randomBytes(16)].map((b) => b & 31); lastR[0] &= 15; }
  let t = ''; for (let i = 0, x = now; i < 10; i++, x = Math.floor(x / 32)) t = B32[x % 32] + t;
  return t + lastR.map((n) => B32[n]).join('');
}

export function repoId(root: string): string {
  const roots = gitTry(root, 'rev-list', '--max-parents=0', 'HEAD');
  if (!roots) throw new Error('no commits: make a first commit before loom init');
  return roots.split('\n').sort()[0];
}

export const loomHome = () => process.env.LOOM_HOME ?? join(homedir(), '.loom');
export function tenant(): string {
  const p = join(loomHome(), 'config.json');
  const t = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).tenant : undefined;
  return String(t ?? process.env.USER ?? 'local');
}
export const graphName = (tenant: string, repoId: string) => `loom:${tenant}:${repoId}`;
```

`packages/memory/src/config.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './git.js';

export interface LoomConfig { repoId: string; dirs: string[]; excludes: string[]; testCmd: string | null; share: boolean }
export const DEFAULT_EXCLUDES = ['node_modules', '.venv', 'dist', 'build', '.git'];
const ATTRS = 'sessions/*.jsonl merge=union\nregions.lock merge=union\n';

export function readConfig(root: string): LoomConfig | null {
  const p = join(root, '.loom', 'config.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Common dir's info/exclude: shared by every worktree of the clone. */
export function exclude(root: string, line: string) {
  const ex = join(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'exclude');
  mkdirSync(dirname(ex), { recursive: true });
  const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
  if (!cur.split('\n').includes(line)) appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/** Creates `.loom/` once; an existing config is never rewritten (repoId is fixed at first init, §4.1). */
export function ensureLoomDir(root: string, cfg: LoomConfig): LoomConfig {
  mkdirSync(join(root, '.loom', 'sessions'), { recursive: true });
  const cur = readConfig(root) ?? (writeFileSync(join(root, '.loom', 'config.json'), JSON.stringify(cfg, null, 2) + '\n'), cfg);
  writeFileSync(join(root, '.loom', '.gitattributes'), ATTRS);
  if (!cur.share) exclude(root, '.loom/sessions/');
  return cur;
}
```

`packages/memory/src/index.ts`:
```ts
export * from './ids.js';
export * from './config.js';
export * from './git.js';
```

- [ ] **Step 5: Run it to see it pass**
Run: `npx vitest run packages/memory/test/ids.test.ts`
Expected: PASS 4/4.

- [ ] **Step 6:** local commit is deferred (see the constraints at the end of this plan): stage only.

---

### Task 2: Session files and events

**Files:**
- Create: `packages/memory/src/events.ts`, `test/events.test.ts`

**Interfaces:**
- Consumes: `ulid`, `git`, `blame` (Task 1)
- Produces:
  - `type LoomEvent = { v: 1; type: EventType; id: string; at: number } & Record<string, unknown>`
  - `EventType`
  - `sessionFile(root, sid, writer): string` (repo-relative)
  - `appendEvent(root, sid, writer, ev: Omit<LoomEvent,'v'|'id'|'at'> & { id?: string; at?: number }): LoomEvent`
  - `parseEvents(lines: string[]): { events: LoomEvent[]; warnings: string[] }`
  - `fileSession(path): { sid: string; writer: string } | null`

- [ ] **Step 1: Write the failing test** — `packages/memory/test/events.test.ts`
```ts
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { appendEvent, fileSession, parseEvents, sessionFile } from '../src/events.js';
import { ulid } from '../src/ids.js';
import { repo, sh } from './helpers.js';

const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };

test('appendEvent writes one {v,type,id,at} line to <sid>.<writer>.jsonl', () => {
  const r = repo({ 'a.py': 'x = 1\n' }); ensureLoomDir(r, CFG);
  const sid = ulid();
  const e = appendEvent(r, sid, 'main', { type: 'decision', text: 'keyword-only', regions: ['a.py::x::definition#0'] });
  const line = readFileSync(join(r, sessionFile(r, sid, 'main')), 'utf8').trim();
  expect(JSON.parse(line)).toEqual(e);
  expect(e).toMatchObject({ v: 1, type: 'decision', id: expect.stringMatching(/^[0-9A-Z]{26}$/), at: expect.any(Number) });
  expect(fileSession(sessionFile(r, sid, 'agent-a'))).toEqual({ sid, writer: 'agent-a' });
});

test('parseEvents tolerates union-merge leftovers: duplicate ids, a cut line, blank lines, unknown types', () => {
  const ok = { v: 1, type: 'lesson', id: 'L1', at: 1, text: 't', regions: [], source: 'manual' };
  const { events, warnings } = parseEvents([JSON.stringify(ok), '', JSON.stringify(ok), '{"v":1,"type":"vers',
    JSON.stringify({ v: 1, type: 'bogus', id: 'B', at: 1 }), JSON.stringify({ v: 2, type: 'lesson', id: 'F', at: 1 })]);
  expect(events.map((e) => e.id)).toEqual(['L1']);
  expect(warnings).toHaveLength(3);
});

test('two writers on two branches merge without conflict; one file on two branches unions', () => {
  const r = repo({ 'a.py': 'x = 1\n' }); ensureLoomDir(r, CFG);
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'loom');
  const sid = ulid();
  sh(r, 'checkout', '-qb', 'b1'); appendEvent(r, sid, 'agent-a', { type: 'message', kind: 'notice', text: '1' });
  appendEvent(r, sid, 'main', { type: 'message', kind: 'notice', text: 'm1' }); sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'b1');
  sh(r, 'checkout', '-q', 'main'); sh(r, 'checkout', '-qb', 'b2'); appendEvent(r, sid, 'agent-b', { type: 'message', kind: 'notice', text: '2' });
  appendEvent(r, sid, 'main', { type: 'message', kind: 'notice', text: 'm2' }); sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'b2');
  sh(r, 'merge', '-q', '-m', 'm', 'b1');                                              // throws on conflict
  const main = readFileSync(join(r, sessionFile(r, sid, 'main')), 'utf8').trim().split('\n');
  expect(parseEvents(main).events.map((e) => e.text).sort()).toEqual(['m1', 'm2']);
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/events.test.ts`
Expected: FAIL. "Failed to load url ../src/events.js".

- [ ] **Step 3: Implement** — `packages/memory/src/events.ts`
```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ulid } from './ids.js';

export const EVENT_TYPES = ['session', 'agent', 'task', 'version', 'decision', 'evidence', 'lesson', 'message', 'handoff'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type LoomEvent = { v: 1; type: EventType; id: string; at: number } & Record<string, any>;

export const sessionFile = (_root: string, sid: string, writer: string) => `.loom/sessions/${sid}.${writer}.jsonl`;
export function fileSession(path: string): { sid: string; writer: string } | null {
  const m = /(?:^|\/)([0-9A-HJKMNP-TV-Z]{26})\.([\w.-]+)\.jsonl$/.exec(path);
  return m ? { sid: m[1], writer: m[2] } : null;
}

/** One line per event; the file has exactly one writer (§5), so appends never interleave. */
export function appendEvent(root: string, sid: string, writer: string,
  ev: { type: EventType; id?: string; at?: number } & Record<string, unknown>): LoomEvent {
  const e = { v: 1, ...ev, id: ev.id ?? ulid(), at: ev.at ?? Date.now() } as LoomEvent;
  const p = join(root, sessionFile(root, sid, writer));
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(e) + '\n');
  return e;
}

/** Union merge can leave duplicates or a line cut by a hand-resolved conflict: keep the first of each id, skip the rest. */
export function parseEvents(lines: string[]): { events: LoomEvent[]; warnings: string[] } {
  const seen = new Set<string>(); const events: LoomEvent[] = []; const warnings: string[] = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    let e: any;
    try { e = JSON.parse(l); } catch { warnings.push(`line ${i + 1}: not JSON`); return; }
    if (e?.v !== 1 || !EVENT_TYPES.includes(e.type) || typeof e.id !== 'string') { warnings.push(`line ${i + 1}: not a v1 event`); return; }
    if (seen.has(e.id)) return;
    seen.add(e.id); events.push(e);
  });
  return { events, warnings };
}
```
Add `export * from './events.js';` to `src/index.ts`.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/events.test.ts`
Expected: PASS 3/3.

---

### Task 3: Repo schema, indexing, lock, baseline

**Files:**
- Modify: `packages/core/src/schema.ts` (add `REPO_INDEXES`, `ensureRepoSchema`)
- Create: `packages/memory/src/graph.ts`, `src/indexrepo.ts`, `test/indexrepo.test.ts`

**Interfaces:**
- Consumes: `regionize`, `buildEdges`, `diffRegions`, `toLockEntry`, `fromLockEntry`, `parseLock`, `pickEntry`, `serializeLock`, `gitBlobSha` from `@loom/indexer` (P1); `readConfig`, `git` (Task 1)
- Produces:
  - `ensureRepoSchema(g)`
  - `indexRepo(g, root, opts?: { paths?: string[]; baseline?: boolean }): Promise<{ files: number; reparsed: number; regions: number; degraded: string[]; unresolved: number; edges: number }>`
  - `listFiles(root, cfg): string[]`

- [ ] **Step 1: Write the failing test** — `packages/memory/test/indexrepo.test.ts`
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { indexRepo } from '../src/indexrepo.js';
import { closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: ['node_modules', '.venv', 'dist', 'build', '.git'], testCmd: null, share: true };
const FILES = {
  'pkg/text.py': 'import re\n\ndef slugify(v):\n    return re.sub("x", "", v)\n\ndef title(v):\n    return slugify(v).title()\n',
  'tests/test_text.py': 'from pkg.text import slugify\n\ndef test_slugify():\n    assert slugify("a") == "a"\n',
  'node_modules/x.js': 'function nope() {}\n',
};

test('indexRepo writes Regions, CODE edges, the lock, and one baseline Version per region at HEAD', async () => {
  const r = repo(FILES); ensureLoomDir(r, CFG); const g = await testGraph();
  const s = await indexRepo(g, r, { baseline: true });
  expect(s).toMatchObject({ files: 2, reparsed: 2, degraded: [] });
  const [{ n }] = await g.query<{ n: number }>('MATCH (r:Region) RETURN count(r) AS n');
  expect(n).toBe(s.regions);
  const calls = await g.query<{ a: string; b: string }>('MATCH (a:Region)-[:CALLS]->(b:Region) RETURN a.qname AS a, b.qname AS b ORDER BY a');
  expect(calls).toContainEqual({ a: 'title', b: 'slugify' });
  expect(await g.query('MATCH (:Region {qname: "test_slugify"})-[:TESTS]->(:Region {qname: "slugify"}) RETURN 1')).toHaveLength(1);
  const head = sh(r, 'rev-parse', 'HEAD');
  const [{ v }] = await g.query<{ v: number }>('MATCH (r:Region)-[:HEAD]->(x:Version {external: true}) WHERE $h IN x.commits RETURN count(x) AS v', { h: head });
  expect(v).toBe(s.regions);
  expect(readFileSync(join(r, '.loom/regions.lock'), 'utf8')).toMatch(/pkg\/text\.py/);
  await g.drop();
});

test('second run with an unchanged lock reparses nothing; one edited file reparses one and keeps ids', async () => {
  const r = repo(FILES); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true });
  expect((await indexRepo(g, r)).reparsed).toBe(0);
  writeFileSync(join(r, 'pkg/text.py'), FILES['pkg/text.py'].replace('"x"', '"y"'));
  const s = await indexRepo(g, r);
  expect(s.reparsed).toBe(1);
  const ids = await g.query<{ id: string }>('MATCH (r:Region {path: "pkg/text.py"}) WHERE NOT coalesce(r.tombstoned, false) RETURN r.id AS id ORDER BY id');
  expect(ids.map((x) => x.id)).toContain('pkg/text.py::slugify::definition#0');
  await g.drop();
});

test('a deleted function is tombstoned, not deleted; a pure rename gets RENAMED_FROM', async () => {
  const r = repo(FILES); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true });
  writeFileSync(join(r, 'pkg/text.py'), 'import re\n\ndef slugify2(v):\n    return re.sub("x", "", v)\n');
  await indexRepo(g, r);
  const [t] = await g.query<{ tomb: boolean }>('MATCH (r:Region {qname: "title"}) RETURN r.tombstoned AS tomb');
  expect(t.tomb).toBe(true);
  expect(await g.query('MATCH (:Region {qname: "slugify2"})-[:RENAMED_FROM]->(:Region {qname: "slugify"}) RETURN 1')).toHaveLength(1);
  await g.drop();
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/indexrepo.test.ts`
Expected: FAIL. "Failed to load url ../src/indexrepo.js".

- [ ] **Step 3: Implement**

`packages/core/src/schema.ts`: append the following (the `Symbol` list stays, and P3 removes it):
```ts
const REPO_INDEXES = ['Region', 'Version', 'Session', 'Agent', 'Person', 'Task', 'Decision', 'Evidence', 'Lesson', 'Message', 'Thread', 'Handoff', 'Imported']
  .map((l) => `CREATE INDEX FOR (n:${l}) ON (n.id)`)
  .concat(['CREATE INDEX FOR (n:Region) ON (n.path)', 'CREATE INDEX FOR (n:Commit) ON (n.sha)', 'CREATE INDEX FOR (n:Watermark) ON (n.person)']);
export async function ensureRepoSchema(g: LoomGraph): Promise<void> {
  for (const q of REPO_INDEXES) {
    try { await g.query(q); } catch (e) { if (!/already indexed/i.test(String(e))) throw e; }
  }
}
```

`packages/memory/src/graph.ts`:
```ts
import type { LoomGraph } from '@loom/core';
import type { Edge, FileRegions } from '@loom/indexer';

const B = 2000;   // S-24: UNWIND batches of 2,000 write Django's 77k regions in under a second
async function batched<T>(xs: T[], f: (b: T[]) => Promise<unknown>) { for (let i = 0; i < xs.length; i += B) await f(xs.slice(i, i + B)); }

/** Current state of the regions of these files; regions no longer present are tombstoned, never deleted (versions point at them). */
export async function writeRegions(g: LoomGraph, frs: FileRegions[]): Promise<void> {
  const rows = frs.flatMap((fr) => fr.regions.map((r) => ({ id: r.id, path: fr.path, kind: r.kind, qname: r.qname,
    start: r.start, end: r.end, hash: r.hash, sig: r.sig, degraded: fr.degraded })));
  await batched(rows, (rs) => g.query(`UNWIND $rs AS r MERGE (n:Region {id: r.id})
    SET n.path = r.path, n.kind = r.kind, n.qname = r.qname, n.start = r.start, n.end = r.end, n.hash = r.hash,
        n.sig = r.sig, n.degraded = r.degraded, n.tombstoned = false, n.stub = false`, { rs }));
  await g.query(`UNWIND $fs AS f MATCH (n:Region {path: f.path}) WHERE NOT n.id IN f.ids SET n.tombstoned = true`,
    { fs: frs.map((fr) => ({ path: fr.path, ids: fr.regions.map((r) => r.id) })) });
}

/** Code edges are derived state: those leaving the reparsed files are replaced wholesale. */
export async function writeEdges(g: LoomGraph, paths: string[], edges: Edge[]): Promise<void> {
  await g.query(`MATCH (a:Region)-[e:CALLS|IMPORTS|TESTS|CONTAINS]->() WHERE a.path IN $paths DELETE e`, { paths });
  for (const kind of ['CALLS', 'IMPORTS', 'TESTS', 'CONTAINS'] as const) {
    const es = edges.filter((e) => e.kind === kind).map((e) => ({ a: e.from, b: e.to, via: e.via }));
    await batched(es, (b) => g.query(`UNWIND $es AS e MATCH (a:Region {id: e.a}), (b:Region {id: e.b})
      MERGE (a)-[x:${kind}]->(b) SET x.via = e.via`, { es: b }));
  }
}
```

`packages/memory/src/indexrepo.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureRepoSchema, type LoomGraph } from '@loom/core';
import { buildEdges, diffRegions, fromLockEntry, gitBlobSha, parseLock, pickEntry, regionize, serializeLock, toLockEntry,
  type FileRegions } from '@loom/indexer';
import { readConfig, type LoomConfig } from './config.js';
import { git } from './git.js';
import { writeEdges, writeRegions } from './graph.js';

export function listFiles(root: string, cfg: LoomConfig): string[] {
  const ex = cfg.excludes.map((e) => new RegExp(`(^|/)${e.replace(/\./g, '\\.')}(/|$)`));
  return git(root, 'ls-files', '-co', '--exclude-standard', '-z').split('\0')
    .filter((f) => f && !f.startsWith('.loom/') && !ex.some((r) => r.test(f)) && existsSync(join(root, f)));
}

/** §6.1 step 3: blobs that match the lock are loaded from it; only mismatches are reparsed. Edges are rebuilt from all maps. */
export async function indexRepo(g: LoomGraph, root: string, opts: { baseline?: boolean } = {}) {
  const cfg = readConfig(root)!;
  await ensureRepoSchema(g);
  const lockPath = join(root, '.loom', 'regions.lock');
  const lock = existsSync(lockPath) ? parseLock(readFileSync(lockPath, 'utf8')) : new Map();
  const files = listFiles(root, cfg);
  const frs: FileRegions[] = []; const changed: FileRegions[] = []; const entries = [];
  const renames: Array<{ from: string; to: string }> = [];
  for (const f of files) {
    const buf = readFileSync(join(root, f)); const blob = gitBlobSha(buf);
    const hit = pickEntry(lock.get(f), blob);
    const prev = lock.get(f)?.[0];
    const fr = hit ? fromLockEntry(hit, buf.toString('utf8')) : await regionize(f, buf);
    frs.push(fr);
    if (!hit) {
      changed.push(fr);
      if (prev) for (const { from, to } of diffRegions(fromLockEntry(prev, '').regions, fr.regions).renamed) renames.push({ from, to });
    }
    entries.push(toLockEntry(fr, blob));
  }
  const fresh = !(await g.query('MATCH (r:Region) RETURN r LIMIT 1')).length;
  await writeRegions(g, fresh ? frs : changed);
  const { edges, unresolved } = buildEdges(frs);
  await writeEdges(g, (fresh ? frs : changed).map((f) => f.path), edges.filter((e) => fresh || changed.some((c) => e.from.startsWith(`${c.path}::`))));
  if (renames.length) await g.query(`UNWIND $rs AS x MATCH (n:Region {id: x.to}), (o:Region {id: x.from}) MERGE (n)-[:RENAMED_FROM]->(o)`, { rs: renames });
  writeFileSync(lockPath, serializeLock(entries));
  if (opts.baseline) await baseline(g, root);
  return { files: files.length, reparsed: changed.length, regions: frs.reduce((n, f) => n + f.regions.length, 0),
    degraded: frs.filter((f) => f.degraded).map((f) => f.path), unresolved, edges: edges.length };
}
/** §6.1 step 4: one external Version per live region at HEAD; HEAD points at it. */
async function baseline(g: LoomGraph, root: string) {
  const head = git(root, 'rev-parse', 'HEAD'); const at = Number(git(root, 'show', '-s', '--format=%ct', head)) * 1000;
  const email = git(root, 'show', '-s', '--format=%ae', head);
  await g.query(`MERGE (p:Person {id: $email}) MERGE (c:Commit {sha: $head}) SET c.at = $at
    WITH p, c MATCH (r:Region) WHERE NOT r.tombstoned
    MERGE (v:Version {id: 'ext:' + $head + ':' + r.id})
    SET v.region = r.id, v.hash = r.hash, v.sig = r.sig, v.deleted = false, v.degraded = r.degraded, v.external = true,
        v.commits = [$head], v.at = $at, v.baseline = true
    MERGE (v)-[:OF]->(r) MERGE (v)-[:IN]->(c) MERGE (v)-[:BY]->(p)
    WITH r, v OPTIONAL MATCH (r)-[h:HEAD]->() DELETE h MERGE (r)-[:HEAD]->(v)`, { head, at, email });
}
```

Add `export * from './indexrepo.js'; export * from './graph.js';` to the barrel, and export `ensureRepoSchema` from `@loom/core`'s index (`export * from './schema.js'` already does this).

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/indexrepo.test.ts`
Expected: PASS 3/3.

- [ ] **Step 5: Scale check (gate evidence for P2-11)**
Run: `cd /Users/18abhinav07/Documents/loom-v2/packages/memory && npx tsx -e "import {LoomDb} from '@loom/core'; import {ensureLoomDir, indexRepo, repoId} from './src/index.ts'; const r='/Users/18abhinav07/Documents/loom-v2/bench/cache/django-src'; const db=await LoomDb.connect(); const g=db.graph('loom:smoke:dj'); ensureLoomDir(r,{repoId:repoId(r),dirs:['.'],excludes:['node_modules','.venv','dist','build','.git'],testCmd:null,share:true}); let t=Date.now(); console.log(await indexRepo(g,r,{baseline:true}), Date.now()-t,'ms'); t=Date.now(); console.log((await indexRepo(g,r)).reparsed, Date.now()-t,'ms'); await g.drop(); await db.close()"` and afterwards `rm -rf /Users/18abhinav07/Documents/loom-v2/bench/cache/django-src/.loom`.
Expected: first run under 30 s, second run `reparsed 0` under 10 s. Record both numbers in ledger row P2-11.

---

### Task 4: Import, versions, current per ref

**Files:**
- Create: `packages/memory/src/importer.ts`, `src/versions.ts`, `test/importer.test.ts`

**Interfaces:**
- Consumes: `blame`, `git`, `gitTry`, `isAncestor` (Task 1); `parseEvents`, `fileSession` (Task 2)
- Produces:
  - `importSessions(g, root, ref: string | null): Promise<{ files: number; skipped: number; events: number; warnings: string[] }>`
  - `currentVersion(g, root, region, ref): Promise<string | null>`
  - `history(g, region): Promise<Array<{ id; ord; by; person; task; decision; commits; at; external }>>`

- [ ] **Step 1: Write the failing test** — `packages/memory/test/importer.test.ts`
```ts
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { appendEvent } from '../src/events.js';
import { ulid } from '../src/ids.js';
import { importSessions } from '../src/importer.js';
import { currentVersion, history } from '../src/versions.js';
import { closeDb, repo, sh, testGraph, write } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const R = 'a.py::f::definition#0';
const count = async (g: any, q: string) => (await g.query(q))[0].n as number;

function seed() {
  const r = repo({ 'a.py': 'def f():\n    return 1\n' }); ensureLoomDir(r, CFG);
  const sid = ulid();
  appendEvent(r, sid, 'main', { type: 'session', person: 'a@t', kind: 'interactive', base: sh(r, 'rev-parse', 'HEAD'), upstream: 'origin/main' });
  appendEvent(r, sid, 'main', { type: 'agent', name: 'main', model: 'sonnet' });
  const v1 = appendEvent(r, sid, 'main', { type: 'version', region: R, hash: 'h1', sig: 'f()', deleted: false, degraded: false, prev: [], by: 'main', task: null });
  appendEvent(r, sid, 'main', { type: 'decision', text: 'return 1 on purpose', regions: [R], by: 'main', led_to: [v1.id] });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'c1');
  return { r, sid, v1 };
}

test('import is idempotent and maps events to nodes and edges', async () => {
  const { r, sid, v1 } = seed(); const g = await testGraph();
  const a = await importSessions(g, r, null);
  const b = await importSessions(g, r, null);
  expect(a).toMatchObject({ files: 1, skipped: 0, events: 4 });
  expect(b).toMatchObject({ files: 1, skipped: 1, events: 0 });
  expect(await count(g, 'MATCH (n) RETURN count(n) AS n')).toBe(await count(g, 'MATCH (n) RETURN count(n) AS n'));
  expect(await g.query(`MATCH (:Person {id: 'a@t'})-[:STARTED]->(:Session {id: $sid})-[:RAN]->(:Agent {id: $ag})
    <-[:BY]-(:Version {id: $v})-[:OF]->(:Region {id: $R}) RETURN 1`, { sid, ag: `${sid}/main`, v: v1.id, R })).toHaveLength(1);
  expect(await g.query(`MATCH (:Decision)-[:LED_TO]->(:Version {id: $v}) RETURN 1`, { v: v1.id })).toHaveLength(1);
  await g.drop();
});

test('commit association: committed line → its commit; uncommitted → []; after amend the new sha joins commits[]', async () => {
  const { r, sid, v1 } = seed(); const g = await testGraph();
  const c1 = sh(r, 'rev-parse', 'HEAD');
  const v2 = appendEvent(r, sid, 'main', { type: 'version', region: R, hash: 'h2', sig: 'f()', deleted: false, degraded: false, prev: [v1.id], by: 'main', task: null });
  await importSessions(g, r, null);
  const get = async (id: string) => (await g.query<{ c: string[] }>('MATCH (v:Version {id: $id}) RETURN v.commits AS c', { id }))[0].c;
  expect(await get(v1.id)).toEqual([c1]);
  expect(await get(v2.id)).toEqual([]);
  expect(await currentVersion(g, r, R, 'HEAD')).toBe(v1.id);
  sh(r, 'add', '-A'); sh(r, 'commit', '-q', '--amend', '--no-edit');
  const c1b = sh(r, 'rev-parse', 'HEAD');
  await importSessions(g, r, null);
  expect((await get(v1.id)).sort()).toEqual([c1, c1b].sort());
  expect(await currentVersion(g, r, R, 'HEAD')).toBe(v2.id);
  expect((await history(g, R)).map((h) => [h.id, h.ord])).toEqual([[v1.id, 1], [v2.id, 2]]);
  await g.drop();
});

test('import from a ref reads records with git show, without checking it out', async () => {
  const { r } = seed(); const g = await testGraph();
  sh(r, 'checkout', '-qb', 'side'); const sid = ulid();
  appendEvent(r, sid, 'main', { type: 'lesson', text: 'run SlugifyTests', regions: [R], source: 'manual' });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'side'); sh(r, 'checkout', '-q', 'main');
  await importSessions(g, r, 'side');
  expect(await g.query(`MATCH (:Lesson {text: 'run SlugifyTests'})-[:ON]->(:Region {id: $R}) RETURN 1`, { R })).toHaveLength(1);
  await g.drop();
});

test('current per ref: diverged branches each see their own version; merge sees both as PREV', async () => {
  const { r, sid, v1 } = seed(); const g = await testGraph();
  sh(r, 'checkout', '-qb', 'x');
  const vx = appendEvent(r, sid, 'main', { type: 'version', region: R, hash: 'hx', sig: 'f()', deleted: false, degraded: false, prev: [v1.id], by: 'main', task: null });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'x');
  sh(r, 'checkout', '-q', 'main'); const s2 = ulid();
  const vy = appendEvent(r, s2, 'main', { type: 'version', region: R, hash: 'hy', sig: 'f()', deleted: false, degraded: false, prev: [v1.id], by: 'main', task: null });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'y');
  await importSessions(g, r, null); await importSessions(g, r, 'x');
  expect(await currentVersion(g, r, R, 'x')).toBe(vx.id);
  expect(await currentVersion(g, r, R, 'main')).toBe(vy.id);
  await g.drop();
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/importer.test.ts`
Expected: FAIL. "Failed to load url ../src/importer.js".

- [ ] **Step 3: Implement**

`packages/memory/src/importer.ts`:
```ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { gitBlobSha } from '@loom/indexer';
import { readFileSync } from 'node:fs';
import { parseEvents, fileSession, type LoomEvent } from './events.js';
import { blame, git, gitTry } from './git.js';

const DIR = '.loom/sessions';
function list(root: string, ref: string | null): string[] {
  if (!ref) return existsSync(join(root, DIR)) ? readdirSync(join(root, DIR)).filter((f) => f.endsWith('.jsonl')).map((f) => `${DIR}/${f}`) : [];
  return (gitTry(root, 'ls-tree', '--name-only', `${ref}`, `${DIR}/`) ?? '').split('\n').filter((f) => f.endsWith('.jsonl'));
}

/** §5.2: MERGE on event id; (:Imported {id: file@blob@lastCommit}) skips unchanged files — the commit part re-keys after a rewrite. */
export async function importSessions(g: LoomGraph, root: string, ref: string | null) {
  const out = { files: 0, skipped: 0, events: 0, warnings: [] as string[] };
  for (const f of list(root, ref)) {
    const fs = fileSession(f); if (!fs) continue;
    out.files++;
    const blob = ref ? git(root, 'rev-parse', `${ref}:${f}`) : gitBlobSha(readFileSync(join(root, f)));
    const last = gitTry(root, 'rev-list', '-1', ref ?? 'HEAD', '--', f) ?? '';
    const key = `${f}@${blob}@${last}`;
    if ((await g.query('MATCH (i:Imported {id: $key}) RETURN i', { key })).length) { out.skipped++; continue; }
    const rows = gitTry(root, 'ls-files', '--error-unmatch', f) !== null || ref ? blame(root, f, ref)
      : readFileSync(join(root, f), 'utf8').split('\n').map((text) => ({ commit: null, text }));
    const commitOf = new Map<string, string | null>();
    const { events, warnings } = parseEvents(rows.map((r, i) => { const id = /"id":"([^"]+)"/.exec(r.text)?.[1]; if (id && !commitOf.has(id)) commitOf.set(id, r.commit); return r.text; }));
    out.warnings.push(...warnings.map((w) => `${f}: ${w}`));
    for (const e of events) { await apply(g, root, fs.sid, fs.writer, e, commitOf.get(e.id) ?? null); out.events++; }
    await g.query('MERGE (i:Imported {id: $key}) SET i.file = $f, i.blob = $blob', { key, f, blob });
  }
  return out;
}

const commitNode = (root: string, sha: string) => ({
  sha, at: Number(git(root, 'show', '-s', '--format=%ct', sha)) * 1000,
  author: git(root, 'show', '-s', '--format=%ae', sha), message: git(root, 'show', '-s', '--format=%s', sha) });

async function apply(g: LoomGraph, root: string, sid: string, writer: string, e: LoomEvent, commit: string | null) {
  const p = { ...e, sid, writer, ag: `${sid}/${e.by ?? e.from ?? writer}`, c: commit ? commitNode(root, commit) : null };
  const Q: Record<string, string> = {
    session: `MERGE (s:Session {id: $sid}) SET s.person = $person, s.kind = $kind, s.base = $base, s.upstream = $upstream, s.started = $at
      MERGE (p:Person {id: $person}) MERGE (p)-[:STARTED]->(s)`,
    agent: `MERGE (s:Session {id: $sid}) MERGE (a:Agent {id: $sid + '/' + $name}) SET a.model = $model, a.name = $name MERGE (s)-[:RAN]->(a)`,
    task: `MERGE (t:Task {id: $id}) SET t.title = $title, t.status = $status, t.claimed_by = $ag, t.at = $at
      WITH t UNWIND coalesce($scope, []) AS rid MERGE (r:Region {id: rid}) ON CREATE SET r.stub = true MERGE (t)-[:SCOPE]->(r)`,
    version: `MERGE (v:Version {id: $id}) SET v.region = $region, v.hash = $hash, v.sig = $sig, v.deleted = $deleted,
        v.degraded = $degraded, v.at = $at, v.external = false, v.commits = coalesce(v.commits, []), v.renamed_from = $renamed_from
      MERGE (r:Region {id: $region}) ON CREATE SET r.stub = true MERGE (v)-[:OF]->(r)
      MERGE (a:Agent {id: $ag}) MERGE (v)-[:BY]->(a)
      WITH v UNWIND coalesce($prev, []) AS pid MERGE (pv:Version {id: pid}) MERGE (v)-[:PREV]->(pv)`,
    decision: `MERGE (d:Decision {id: $id}) SET d.text = $text, d.at = $at MERGE (a:Agent {id: $ag}) MERGE (d)-[:BY]->(a)
      WITH d UNWIND coalesce($regions, []) AS rid MERGE (r:Region {id: rid}) ON CREATE SET r.stub = true MERGE (d)-[:ABOUT]->(r)
      WITH DISTINCT d UNWIND coalesce($led_to, []) AS vid MERGE (v:Version {id: vid}) MERGE (d)-[:LED_TO]->(v)`,
    evidence: `MERGE (x:Evidence {id: $id}) SET x.test = $test, x.result = $result, x.at = $at
      WITH x UNWIND coalesce($versions, []) AS vid MERGE (v:Version {id: vid}) MERGE (x)-[:VERIFIES]->(v)`,
    lesson: `MERGE (l:Lesson {id: $id}) SET l.text = $text, l.source = $source, l.at = $at
      WITH l UNWIND coalesce($regions, []) AS rid MERGE (r:Region {id: rid}) ON CREATE SET r.stub = true MERGE (l)-[:ON]->(r)`,
    message: `MERGE (m:Message {id: $id}) SET m.kind = $kind, m.text = $text, m.at = $at
      MERGE (f:Agent {id: $ag}) MERGE (m)-[:FROM]->(f)
      FOREACH (_ IN CASE WHEN $thread IS NULL THEN [] ELSE [1] END | MERGE (t:Thread {id: $thread}) MERGE (m)-[:IN_THREAD]->(t))`,
    handoff: `MERGE (h:Handoff {id: $id}) SET h.summary = $summary, h.open_leases = $open_leases, h.at = $at
      MERGE (s:Session {id: $sid}) MERGE (h)-[:FROM]->(s)
      WITH h UNWIND coalesce($open_tasks, []) AS tid MERGE (t:Task {id: tid}) MERGE (h)-[:LEAVES]->(t)`,
  };
  const defaults = { person: null, kind: null, base: null, upstream: null, name: null, model: null, title: null, status: null, scope: null,
    region: null, hash: null, sig: null, deleted: false, degraded: false, prev: null, renamed_from: null, text: null, regions: null,
    led_to: null, test: null, result: null, versions: null, source: null, thread: null, summary: null, open_leases: null, open_tasks: null };
  await g.query(Q[e.type], { ...defaults, ...p });
  if (e.type === 'version' && p.c) await g.query(`MATCH (v:Version {id: $id}) MERGE (c:Commit {sha: $c.sha})
      SET c.at = $c.at, c.author = $c.author, c.message = $c.message MERGE (v)-[:IN]->(c)
      SET v.commits = CASE WHEN $c.sha IN v.commits THEN v.commits ELSE v.commits + $c.sha END`, { id: e.id, c: p.c });
  if (e.type === 'version' && e.task) await g.query('MATCH (v:Version {id: $id}) MERGE (t:Task {id: $task}) MERGE (v)-[:FOR]->(t)', { id: e.id, task: e.task });
}
```
> If FalkorDB rejects `$c.sha` inside `MERGE (c:Commit {sha: $c.sha})`, pass `sha`, `cat`, `author` and `message` as flat parameters. Record it as a ruling.

`packages/memory/src/versions.ts`:
```ts
import type { LoomGraph } from '@loom/core';
import { isAncestor } from './git.js';

/** §4.3: newest Version of R with any commit reachable from `ref`; null when none (uncommitted work). */
export async function currentVersion(g: LoomGraph, root: string, region: string, ref: string): Promise<string | null> {
  const vs = await g.query<{ id: string; commits: string[] }>(`MATCH (v:Version)-[:OF]->(:Region {id: $region})
    WHERE size(coalesce(v.commits, [])) > 0 RETURN v.id AS id, v.commits AS commits ORDER BY v.at DESC, v.id DESC`, { region });
  return vs.find((v) => v.commits.some((c) => isAncestor(root, c, ref)))?.id ?? null;
}

export interface HistoryRow { id: string; ord: number; at: number; external: boolean; commits: string[]; prev: string[];
  by: string | null; person: string | null; task: string | null; decisions: string[] }
/** The version DAG of one region, oldest first; ord = max(prev.ord) + 1 computed here (ruling 5). */
export async function history(g: LoomGraph, region: string): Promise<HistoryRow[]> {
  const rows = await g.query<Omit<HistoryRow, 'ord'>>(`MATCH (v:Version)-[:OF]->(:Region {id: $region})
    OPTIONAL MATCH (v)-[:PREV]->(p:Version) OPTIONAL MATCH (v)-[:BY]->(b) OPTIONAL MATCH (s:Session)-[:RAN]->(b)
    OPTIONAL MATCH (v)-[:FOR]->(t:Task) OPTIONAL MATCH (d:Decision)-[:LED_TO]->(v)
    RETURN v.id AS id, v.at AS at, coalesce(v.external, false) AS external, coalesce(v.commits, []) AS commits,
      collect(DISTINCT p.id) AS prev, b.id AS by, coalesce(s.person, b.id) AS person, t.id AS task, collect(DISTINCT d.text) AS decisions
    ORDER BY v.at, v.id`, { region });
  const ord = new Map<string, number>();
  const of = (id: string, seen = new Set<string>()): number => {
    if (ord.has(id)) return ord.get(id)!;
    const r = rows.find((x) => x.id === id); if (!r || seen.has(id)) return 0;
    seen.add(id); const n = Math.max(0, ...r.prev.map((p) => of(p, seen))) + 1; ord.set(id, n); return n;
  };
  return rows.map((r) => ({ ...r, ord: of(r.id) }));
}
```
Add both modules to the barrel.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/importer.test.ts`
Expected: PASS 4/4.

---

### Task 5: Git hooks installer

**Files:**
- Create: `packages/memory/src/githooks.ts`, `test/githooks.test.ts`

**Interfaces:**
- Produces:
  - `GIT_HOOKS = ['pre-commit','post-commit','post-merge','post-checkout','post-rewrite']`
  - `installGitHooks(root, loomCmd: string): { dir: string; chained: string[] }`

- [ ] **Step 1: Write the failing test** — `packages/memory/test/githooks.test.ts`
```ts
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { installGitHooks } from '../src/githooks.js';
import { repo, sh, write } from './helpers.js';

/** A fake loom that logs its argv and stdin, so the test sees exactly what each hook passed. */
function fakeLoom(r: string) {
  const p = join(r, '..', `fake-loom-${Date.now()}.sh`);
  writeFileSync(p, `#!/bin/sh\necho "LOOM $* $(cat)" >> "${r}.log"\n`); chmodSync(p, 0o755); return p;
}

test('installs five hooks; an existing hook is kept as .pre-loom and runs first; idempotent', () => {
  const r = repo({ 'a.py': 'x = 1\n' }); const loom = fakeLoom(r);
  writeFileSync(join(r, '.git/hooks/post-commit'), `#!/bin/sh\necho MINE >> "${r}.log"\n`); chmodSync(join(r, '.git/hooks/post-commit'), 0o755);
  installGitHooks(r, loom); const second = installGitHooks(r, loom);
  expect(second.chained).toEqual([]);
  expect(readFileSync(join(r, '.git/hooks/post-commit.pre-loom'), 'utf8')).toMatch(/MINE/);
  write(r, { 'b.py': 'y = 2\n' }); sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'two');
  const log = readFileSync(`${r}.log`, 'utf8').trim().split('\n');
  expect(log[0]).toBe('MINE');
  expect(log.filter((l) => l.startsWith('LOOM hook git pre-commit'))).toHaveLength(1);
  expect(log.filter((l) => l.startsWith('LOOM hook git post-commit'))).toHaveLength(1);
});

test('post-rewrite: the rewrite map on stdin reaches both the old hook and loom', () => {
  const r = repo({ 'a.py': 'x = 1\n' }); const loom = fakeLoom(r);
  writeFileSync(join(r, '.git/hooks/post-rewrite'), `#!/bin/sh\necho "OLD $(cat)" >> "${r}.log"\n`); chmodSync(join(r, '.git/hooks/post-rewrite'), 0o755);
  installGitHooks(r, loom);
  sh(r, 'commit', '-q', '--amend', '-m', 'amended');
  const log = readFileSync(`${r}.log`, 'utf8');
  expect(log).toMatch(/OLD [0-9a-f]{40} [0-9a-f]{40}/);
  expect(log).toMatch(/LOOM hook git post-rewrite amend [0-9a-f]{40} [0-9a-f]{40}/);
});

test('core.hooksPath (husky): hooks go into that directory; a failing loom never blocks the commit', () => {
  const r = repo({ 'a.py': 'x = 1\n' });
  mkdirSync(join(r, '.husky')); sh(r, 'config', 'core.hooksPath', '.husky');
  const bad = join(r, '..', `bad-loom-${Date.now()}.sh`); writeFileSync(bad, '#!/bin/sh\nexit 3\n'); chmodSync(bad, 0o755);
  const { dir } = installGitHooks(r, bad);
  expect(dir).toBe(join(r, '.husky'));
  expect(existsSync(join(r, '.husky/pre-commit'))).toBe(true);
  write(r, { 'b.py': 'y = 2\n' }); sh(r, 'add', '-A');
  expect(() => sh(r, 'commit', '-qm', 'ok')).not.toThrow();
});

test('an existing hook that fails still blocks the commit (we do not swallow the user\'s hook)', () => {
  const r = repo({ 'a.py': 'x = 1\n' }); const loom = fakeLoom(r);
  writeFileSync(join(r, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n'); chmodSync(join(r, '.git/hooks/pre-commit'), 0o755);
  installGitHooks(r, loom);
  write(r, { 'b.py': 'y = 2\n' }); sh(r, 'add', '-A');
  expect(() => sh(r, 'commit', '-qm', 'no')).toThrow();
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/githooks.test.ts`
Expected: FAIL. "Failed to load url ../src/githooks.js".

- [ ] **Step 3: Implement** — `packages/memory/src/githooks.ts`
```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { git, gitTry } from './git.js';

export const GIT_HOOKS = ['pre-commit', 'post-commit', 'post-merge', 'post-checkout', 'post-rewrite'] as const;
const MARK = '# loom-hook v1';

/** The user's hook runs first and keeps its exit status; loom runs after it and never fails the hook (fail-open, R17). */
const script = (name: string, loom: string) => `#!/bin/sh
${MARK}
in=$(cat 2>/dev/null)
if [ -x "$0.pre-loom" ]; then printf '%s' "$in" | "$0.pre-loom" "$@" || exit $?; fi
printf '%s' "$in" | ${loom} hook git ${name} "$@" >&2 || echo "[loom] ${name} hook failed; continuing" >&2
exit 0
`;

export function installGitHooks(root: string, loomCmd: string): { dir: string; chained: string[] } {
  const hp = gitTry(root, 'config', 'core.hooksPath');
  const dir = hp ? (isAbsolute(hp) ? hp : join(root, hp)) : join(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'hooks');
  mkdirSync(dir, { recursive: true });
  const chained: string[] = [];
  for (const h of GIT_HOOKS) {
    const p = join(dir, h);
    if (existsSync(p) && readFileSync(p, 'utf8').includes(MARK)) continue;
    if (existsSync(p)) { renameSync(p, `${p}.pre-loom`); chained.push(h); }
    writeFileSync(p, script(h, loomCmd)); chmodSync(p, 0o755);
  }
  return { dir, chained };
}
```
> `post-rewrite`'s argument (`amend`/`rebase`) comes through `"$@"`. The other hooks get no stdin; `cat` returns empty, and on a terminal stdin it would block. Git runs hooks with stdin not attached to a tty, so this is safe. The test runs it non-interactively too.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/githooks.test.ts`
Expected: PASS 4/4.

---

### Task 6: pre-commit, post-commit, post-rewrite

**Files:**
- Create: `packages/memory/src/session.ts` (only the active-session file part here), `src/commit.ts`, `test/commit.test.ts`

**Interfaces:**
- Consumes: `regionize`, `diffRegions`, `parseLock`, `serializeLock`, `toLockEntry`, `pickEntry`, `fromLockEntry`, `gitBlobSha` (P1); `appendEvent`, `sessionFile` (Task 2); `importSessions`, `currentVersion` (Task 4)
- Produces:
  - `ActiveSession { sid: string; writer: string; by: string; task: string | null }`
  - `writeActive(root, a)`, `readActive(root): ActiveSession | null`, `clearActive(root)`
  - `preCommit(root, g: LoomGraph | null): Promise<{ versions: number }>`
  - `postCommit(root, g): Promise<void>`
  - `refreshHead(g, root, regions?: string[])`

- [ ] **Step 1: Write the failing test** — `packages/memory/test/commit.test.ts`
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { parseEvents, sessionFile } from '../src/events.js';
import { ulid } from '../src/ids.js';
import { indexRepo } from '../src/indexrepo.js';
import { postCommit, preCommit } from '../src/commit.js';
import { writeActive } from '../src/session.js';
import { closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const SRC = 'def f():\n    return 1\n\ndef g():\n    return 2\n';

async function setup() {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG);
  const g = await testGraph(); await indexRepo(g, r, { baseline: true });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'loom init');
  const sid = ulid(); writeActive(r, { sid, writer: 'main', by: 'main', task: 'T1' });
  return { r, g, sid };
}
const events = (r: string, sid: string) => parseEvents(readFileSync(join(r, sessionFile(r, sid, 'main')), 'utf8').split('\n')).events;

test('pre-commit versions the INDEX text (partial staging), stages the session file and the lock', async () => {
  const { r, g, sid } = await setup();
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 10'));
  sh(r, 'add', 'a.py');
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 10').replace('return 2', 'return 20'));   // unstaged
  const out = await preCommit(r, g);
  expect(out.versions).toBe(1);
  const [v] = events(r, sid).filter((e) => e.type === 'version');
  expect(v).toMatchObject({ region: 'a.py::f::definition#0', by: 'main', task: 'T1', deleted: false });
  expect(v.prev).toEqual([(await g.query<{ id: string }>(`MATCH (:Region {id: 'a.py::f::definition#0'})-[:HEAD]->(v) RETURN v.id AS id`))[0].id]);
  const staged = sh(r, 'diff', '--cached', '--name-only').split('\n');
  expect(staged).toEqual(expect.arrayContaining(['.loom/regions.lock', sessionFile(r, sid, 'main'), 'a.py']));
  await g.drop();
});

test('real commit through installed hooks: post-commit links versions to the Commit and moves HEAD', async () => {
  const { r, g, sid } = await setup();
  writeFileSync(join(r, 'a.py'), SRC.replace('return 2', 'return 3'));
  sh(r, 'add', 'a.py'); await preCommit(r, g); sh(r, 'commit', '-qm', 'edit g'); await postCommit(r, g);
  const head = sh(r, 'rev-parse', 'HEAD');
  const [row] = await g.query<{ id: string; c: string[] }>(`MATCH (:Region {id: 'a.py::g::definition#0'})-[:HEAD]->(v)-[:IN]->(:Commit {sha: $head})
    RETURN v.id AS id, v.commits AS c`, { head });
  expect(row.id).toBe(events(r, sid).find((e) => e.type === 'version')!.id);
  await g.drop();
});

test('graph down (g = null): pre-commit still writes version events (prev empty) and exits cleanly', async () => {
  const { r, sid } = await setup();
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 5')); sh(r, 'add', 'a.py');
  expect((await preCommit(r, null)).versions).toBe(1);
  expect(events(r, sid).find((e) => e.type === 'version')!.prev).toEqual([]);
});

test('no active session → pre-commit writes nothing (the commit is reconciled as external at sync)', async () => {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG); const g = await testGraph(); await indexRepo(g, r, { baseline: true });
  writeFileSync(join(r, 'a.py'), SRC.replace('return 1', 'return 5')); sh(r, 'add', 'a.py');
  expect((await preCommit(r, g)).versions).toBe(0);
  await g.drop();
});

test('deleting a function writes deleted:true; a pure rename writes renamed_from', async () => {
  const { r, g, sid } = await setup();
  writeFileSync(join(r, 'a.py'), 'def f2():\n    return 1\n'); sh(r, 'add', 'a.py');
  await preCommit(r, g);
  const vs = events(r, sid).filter((e) => e.type === 'version');
  expect(vs).toContainEqual(expect.objectContaining({ region: 'a.py::g::definition#0', deleted: true }));
  expect(vs).toContainEqual(expect.objectContaining({ region: 'a.py::f2::definition#0', renamed_from: 'a.py::f::definition#0' }));
  await g.drop();
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/commit.test.ts`
Expected: FAIL. "Failed to load url ../src/commit.js".

- [ ] **Step 3: Implement**

`packages/memory/src/session.ts` (first part):
```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.js';

export interface ActiveSession { sid: string; writer: string; by: string; task: string | null }
/** Per worktree: git-dir (not common dir), so two worktrees never share an active session (ruling 6). */
const activePath = (root: string) => join(git(root, 'rev-parse', '--path-format=absolute', '--git-dir'), 'loom', 'session.json');
export function writeActive(root: string, a: ActiveSession) { const p = activePath(root); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(a)); }
export function readActive(root: string): ActiveSession | null { const p = activePath(root); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; }
export function clearActive(root: string) { rmSync(activePath(root), { force: true }); }
```

`packages/memory/src/commit.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoomGraph } from '@loom/core';
import { diffRegions, fromLockEntry, gitBlobSha, parseLock, pickEntry, regionize, serializeLock, toLockEntry } from '@loom/indexer';
import { appendEvent, sessionFile } from './events.js';
import { git, gitTry } from './git.js';
import { importSessions } from './importer.js';
import { currentVersion } from './versions.js';
import { readActive } from './session.js';

const show = (root: string, spec: string) => gitTry(root, 'show', spec);

/** §6.2 step 5: parse the staged (index) text of each staged file, write a version event per changed region, rewrite the lock, stage both. */
export async function preCommit(root: string, g: LoomGraph | null): Promise<{ versions: number }> {
  const act = readActive(root); if (!act) return { versions: 0 };
  const staged = git(root, 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD').split('\0').filter((f) => f && !f.startsWith('.loom/'));
  const lockPath = join(root, '.loom', 'regions.lock');
  const lock = existsSync(lockPath) ? parseLock(readFileSync(lockPath, 'utf8')) : new Map();
  const mergeHead = gitTry(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD');
  let versions = 0;
  for (const f of staged) {
    const idx = show(root, `:${f}`); const old = show(root, `HEAD:${f}`);
    const before = old === null ? [] : (await regionize(f, old)).regions;
    const after = idx === null ? null : await regionize(f, idx);
    const d = diffRegions(before, after?.regions ?? []);
    const byId = new Map((after?.regions ?? []).map((r) => [r.id, r]));
    const renamedTo = new Map(d.renamed.map((x) => [x.to, x.from]));
    const changed = [...d.updated, ...d.created].map((id) => ({ id, deleted: false })).concat(d.tombstoned.map((id) => ({ id, deleted: true })));
    for (const c of after?.degraded ? [] : changed) {               // §3.6: no Versions from degraded maps; lock still updated
      const r = byId.get(c.id);
      const prev = g ? (await Promise.all(['HEAD', ...(mergeHead ? [mergeHead] : [])].map((ref) => currentVersion(g, root, renamedTo.get(c.id) ?? c.id, ref))))
        .filter((x): x is string => !!x) : [];
      appendEvent(root, act.sid, act.writer, { type: 'version', region: c.id, hash: r?.hash ?? null, sig: r?.sig ?? null, deleted: c.deleted,
        degraded: false, prev: [...new Set(prev)], by: act.by, task: act.task, renamed_from: renamedTo.get(c.id) ?? null });
      versions++;
    }
    lock.set(f, idx === null ? [] : [toLockEntry(after!, gitBlobSha(idx))]);   // replaces union-merge leftovers
  }
  writeFileSync(lockPath, serializeLock([...lock.values()].flat()));
  git(root, 'add', '--', lockPath, ...(versions ? [join(root, sessionFile(root, act.sid, act.writer))] : []));
  return { versions };
}

/** HEAD edge of each region → its current version on the local HEAD (§4.3). */
export async function refreshHead(g: LoomGraph, root: string, regions?: string[]) {
  const ids = regions ?? (await g.query<{ id: string }>('MATCH (r:Region) RETURN r.id AS id')).map((r) => r.id);
  for (const id of ids) {
    const v = await currentVersion(g, root, id, 'HEAD'); if (!v) continue;
    await g.query('MATCH (r:Region {id: $id}), (v:Version {id: $v}) OPTIONAL MATCH (r)-[h:HEAD]->() DELETE h MERGE (r)-[:HEAD]->(v)', { id, v });
  }
}

/** §6.2 step 5 post-commit: import the now-committed lines (blame gives HEAD), then move HEAD on the regions they name. */
export async function postCommit(root: string, g: LoomGraph): Promise<void> {
  await importSessions(g, root, null);
  const head = git(root, 'rev-parse', 'HEAD');
  const rs = await g.query<{ id: string }>('MATCH (v:Version)-[:IN]->(:Commit {sha: $head}) RETURN DISTINCT v.region AS id', { head });
  await refreshHead(g, root, rs.map((r) => r.id));
}
```

Add `session.js` and `commit.js` to the barrel.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/commit.test.ts`
Expected: PASS 5/5.

---

### Task 7: Reconcile external versions

**Files:**
- Create: `packages/memory/src/reconcile.ts`, `test/reconcile.test.ts`

**Interfaces:**
- Consumes: `regionize`, `diffRegions` (P1); `git`, `gitTry` (Task 1)
- Produces: `reconcile(g, root, from: string | null, to: string, cap = 200): Promise<{ commits: number; versions: number; capped: boolean }>`

- [ ] **Step 1: Write the failing test** — `packages/memory/test/reconcile.test.ts`
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { indexRepo } from '../src/indexrepo.js';
import { importSessions } from '../src/importer.js';
import { reconcile } from '../src/reconcile.js';
import { as, closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const SRC = 'def f():\n    return 1\n\ndef g():\n    return 2\n';

test('a commit made outside Loom becomes an external Version BY the git author; idempotent', async () => {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true }); const base = sh(r, 'rev-parse', 'HEAD');
  writeFileSync(join(r, 'a.py'), SRC.replace('return 2', 'return 9')); as('bob')(r, 'commit', '-qam', 'bob edits g', '--no-verify');
  const c = sh(r, 'rev-parse', 'HEAD');
  expect(await reconcile(g, r, base, 'HEAD')).toMatchObject({ commits: 1, versions: 1, capped: false });
  expect(await reconcile(g, r, base, 'HEAD')).toMatchObject({ versions: 0 });
  expect(await g.query(`MATCH (v:Version {id: $id, external: true})-[:BY]->(:Person {id: 'bob@t'}) MATCH (v)-[:OF]->(:Region {id: 'a.py::g::definition#0'}) RETURN 1`,
    { id: `ext:${c}:a.py::g::definition#0` })).toHaveLength(1);
  await g.drop();
});

test('a region already versioned by a .loom event in that commit gets no external version', async () => {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true }); const base = sh(r, 'rev-parse', 'HEAD');
  const { appendEvent } = await import('../src/events.js'); const { ulid } = await import('../src/ids.js');
  writeFileSync(join(r, 'a.py'), SRC.replace('return 2', 'return 9'));
  appendEvent(r, ulid(), 'main', { type: 'version', region: 'a.py::g::definition#0', hash: 'h', sig: 'g()', deleted: false, degraded: false, prev: [], by: 'main', task: null });
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'loom edit');
  await importSessions(g, r, null);
  expect((await reconcile(g, r, base, 'HEAD')).versions).toBe(0);
  await g.drop();
});

test('past the cap: one external version per region for the whole range, by "N authors"', async () => {
  const r = repo({ 'a.py': SRC }); ensureLoomDir(r, CFG); const g = await testGraph();
  await indexRepo(g, r, { baseline: true }); const base = sh(r, 'rev-parse', 'HEAD');
  for (let i = 0; i < 5; i++) { writeFileSync(join(r, 'a.py'), SRC.replace('return 1', `return ${i + 10}`)); as(i % 2 ? 'x' : 'y')(r, 'commit', '-qam', `c${i}`); }
  const out = await reconcile(g, r, base, 'HEAD', 3);
  expect(out).toMatchObject({ capped: true, versions: 1 });
  expect(await g.query(`MATCH (v:Version {external: true, range: true})-[:BY]->(p:Person {id: '2 authors'}) RETURN 1`)).toHaveLength(1);
  await g.drop();
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/reconcile.test.ts`
Expected: FAIL. "Failed to load url ../src/reconcile.js".

- [ ] **Step 3: Implement** — `packages/memory/src/reconcile.ts`
```ts
import type { LoomGraph } from '@loom/core';
import { diffRegions, regionize } from '@loom/indexer';
import { git, gitTry } from './git.js';

async function changedRegions(root: string, a: string, b: string): Promise<Map<string, { hash: string | null; sig: string | null; deleted: boolean }>> {
  const out = new Map();
  for (const line of git(root, 'diff', '--name-status', '-M', a, b, '--', '.', ':!.loom').split('\n').filter(Boolean)) {
    const [st, p1, p2] = line.split('\t'); const f = p2 ?? p1;
    const old = st === 'A' ? null : gitTry(root, 'show', `${a}:${p1}`); const neu = st === 'D' ? null : gitTry(root, 'show', `${b}:${f}`);
    const before = old === null ? [] : (await regionize(p1, old)).regions; const after = neu === null ? null : await regionize(f, neu);
    if (after?.degraded) continue;
    const d = diffRegions(before, after?.regions ?? []); const by = new Map((after?.regions ?? []).map((r) => [r.id, r]));
    for (const id of [...d.updated, ...d.created]) out.set(id, { hash: by.get(id)!.hash, sig: by.get(id)!.sig, deleted: false });
    for (const id of d.tombstoned) out.set(id, { hash: null, sig: null, deleted: true });
  }
  return out;
}

/** §4.6 + §6.3 step 4: regions a commit changed with no .loom version in that commit get Version {external} BY the git author. */
export async function reconcile(g: LoomGraph, root: string, from: string | null, to: string, cap = 200) {
  const range = from ? `${from}..${to}` : to;
  const commits = (gitTry(root, 'rev-list', '--reverse', '--no-merges', range) ?? '').split('\n').filter(Boolean);
  if (!commits.length) return { commits: 0, versions: 0, capped: false };
  const write = async (id: string, region: string, v: { hash: string | null; sig: string | null; deleted: boolean }, sha: string, by: string, at: number, isRange = false) => {
    const [r] = await g.query<{ n: number }>(`OPTIONAL MATCH (x:Version {id: $id}) RETURN count(x) AS n`, { id }); if (r.n) return 0;
    await g.query(`MERGE (p:Person {id: $by}) MERGE (c:Commit {sha: $sha}) MERGE (rg:Region {id: $region}) ON CREATE SET rg.stub = true
      CREATE (v:Version {id: $id, region: $region, hash: $hash, sig: $sig, deleted: $deleted, degraded: false, external: true,
        commits: [$sha], at: $at, range: $isRange}) CREATE (v)-[:OF]->(rg) CREATE (v)-[:IN]->(c) CREATE (v)-[:BY]->(p)`,
    { id, region, ...v, sha, by, at, isRange });
    return 1;
  };
  let versions = 0;
  if (commits.length > cap) {
    const authors = new Set(commits.map((c) => git(root, 'show', '-s', '--format=%ae', c)));
    const last = commits.at(-1)!; const at = Number(git(root, 'show', '-s', '--format=%ct', last)) * 1000;
    for (const [region, v] of await changedRegions(root, `${commits[0]}^`, last))
      versions += await write(`ext:${commits[0]}..${last}:${region}`, region, v, last, `${authors.size} authors`, at, true);
    return { commits: commits.length, versions, capped: true };
  }
  for (const c of commits) {
    const loomed = new Set((await g.query<{ r: string }>('MATCH (v:Version {external: false})-[:IN]->(:Commit {sha: $c}) RETURN v.region AS r', { c })).map((x) => x.r));
    const by = git(root, 'show', '-s', '--format=%ae', c); const at = Number(git(root, 'show', '-s', '--format=%ct', c)) * 1000;
    for (const [region, v] of await changedRegions(root, `${c}^`, c))
      if (!loomed.has(region)) versions += await write(`ext:${c}:${region}`, region, v, c, by, at);
  }
  return { commits: commits.length, versions, capped: false };
}
```
> The root commit has no `^` parent. `rev-list from..to` with a non-null `from` never yields it. When `from` is null, skip the first commit if `git rev-parse <c>^` fails, because the init baseline already covers it.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/reconcile.test.ts`
Expected: PASS 3/3.

---

### Task 8: News, briefing, sync

**Files:**
- Create: `packages/memory/src/news.ts`, `src/sync.ts`, `test/sync.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7
- Produces:
  - `NewsItem { kind: 'version'|'decision'|'task'|'handoff'|'lesson'; id; region: string | null; path: string | null; text: string; by: string; person: string; task: string | null; at: number; score: number; upstreamOnly: boolean }`
  - `news(g, root, me: string, since: number, upstream: string | null): Promise<NewsItem[]>`
  - `renderBriefing(h: { from: string; to: string; upstream: string | null; ahead: number; people: number; sessions: number; items: NewsItem[]; degraded: string[] }): string`
  - `sync(g, root, o: { me: string; fetch?: boolean; quiet?: boolean }): Promise<{ briefing: string; imported: number; reconciled: number; fetched: boolean | null }>`
  - `upstreamRef(root): string | null`

- [ ] **Step 1: Write the failing test** — `packages/memory/test/sync.test.ts`
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { appendEvent } from '../src/events.js';
import { ulid } from '../src/ids.js';
import { indexRepo } from '../src/indexrepo.js';
import { renderBriefing, type NewsItem } from '../src/news.js';
import { sync } from '../src/sync.js';
import { as, closeDb, pair, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const SRC = { 'pkg/text.py': 'def slugify(v):\n    return v\n\ndef title(v):\n    return slugify(v).title()\n', 'pkg/other.py': 'def z():\n    return 0\n' };
const SLUG = 'pkg/text.py::slugify::definition#0';

test('X2 mechanics: B learns of A\'s pushed change and decision BEFORE pulling', async () => {
  const { a, b } = pair(SRC);
  for (const c of [a, b]) { ensureLoomDir(c, CFG); }
  as('A')(a, 'add', '-A'); as('A')(a, 'commit', '-qm', 'loom'); as('A')(a, 'push', '-q');
  as('B')(b, 'pull', '-q');
  const gb = await testGraph(); await indexRepo(gb, b, { baseline: true });
  await sync(gb, b, { me: 'B@t', fetch: true });                            // B's first sync: watermark set
  const sid = ulid();
  appendEvent(a, sid, 'main', { type: 'session', person: 'A@t', kind: 'interactive', base: '', upstream: 'origin/main' });
  const v = appendEvent(a, sid, 'main', { type: 'version', region: SLUG, hash: 'h', sig: 'slugify(v, *, strict)', deleted: false, degraded: false, prev: [], by: 'main', task: 'T4' });
  appendEvent(a, sid, 'main', { type: 'decision', text: 'strict is keyword-only', regions: [SLUG], by: 'main', led_to: [v.id] });
  writeFileSync(join(a, 'pkg/text.py'), SRC['pkg/text.py'].replace('slugify(v)', 'slugify(v, *, strict=False)'));
  as('A')(a, 'add', '-A'); as('A')(a, 'commit', '-qm', 'strict slugify'); as('A')(a, 'push', '-q');
  const out = await sync(gb, b, { me: 'B@t', fetch: true });
  expect(out.fetched).toBe(true);
  expect(out.briefing).toMatch(/slugify \(pkg\/text\.py\) changed on origin\/main by A@t.*not in your branch yet/);
  expect(out.briefing).toMatch(/strict is keyword-only/);
  expect(sh(b, 'rev-parse', 'HEAD')).not.toBe(sh(b, 'rev-parse', 'origin/main'));   // B never pulled
  await gb.drop();
});

test('scores: 3 scope > 2 within 2 hops > 1 file I touched; top 10; tie → newer first', () => {
  const item = (o: Partial<NewsItem>): NewsItem => ({ kind: 'version', id: 'x', region: SLUG, path: 'pkg/text.py', text: '', by: 'b', person: 'B@t',
    task: null, at: 1, score: 1, upstreamOnly: false, ...o });
  const items = Array.from({ length: 14 }, (_, i) => item({ id: `v${i}`, at: i, score: i === 3 ? 3 : i === 7 ? 2 : 1, text: `v${i}` }));
  const txt = renderBriefing({ from: 'abc1234', to: 'def5678', upstream: 'origin/main', ahead: 3, people: 2, sessions: 3, items, degraded: [] });
  const lines = txt.split('\n');
  expect(lines.length).toBeLessThanOrEqual(25);
  expect(lines[0]).toBe('[loom] Since your last sync (abc1234 → def5678; upstream origin/main +3), 2 people, 3 sessions:');
  const order = lines.filter((l) => l.startsWith('- ') && !l.startsWith('- Degraded')).map((l) => /v\d+/.exec(l)![0]);
  expect(order.slice(0, 3)).toEqual(['v3', 'v7', 'v13']);
  expect(order).toHaveLength(10);
  expect(lines.at(-2)).toBe('- Degraded: none.');
  expect(lines.at(-1)).toBe('Ask: history(region) · why(region) · changes_since(commit)');
  expect(renderBriefing({ from: 'abc1234', to: 'def5678', upstream: 'origin/main', ahead: 3, people: 2, sessions: 3, items, degraded: [] })).toBe(txt);
});

test('fresh init: news is only the latest handoff of each other person', async () => {
  const { a, b } = pair(SRC);
  ensureLoomDir(a, CFG);
  for (const [i, s] of [ulid(), ulid()].entries()) {
    appendEvent(a, s, 'main', { type: 'session', person: 'A@t', kind: 'interactive', base: '', upstream: 'origin/main' });
    appendEvent(a, s, 'main', { type: 'handoff', summary: `handoff ${i}`, open_tasks: [], open_leases: [] });
  }
  as('A')(a, 'add', '-A'); as('A')(a, 'commit', '-qm', 'records'); as('A')(a, 'push', '-q'); as('B')(b, 'pull', '-q');
  ensureLoomDir(b, CFG); const g = await testGraph(); await indexRepo(g, b, { baseline: true });
  const { briefing } = await sync(g, b, { me: 'B@t', fetch: false });
  expect(briefing).toMatch(/handoff 1/); expect(briefing).not.toMatch(/handoff 0/);
  await g.drop();
});

test('offline: fetch to an unreachable remote is bounded (≤ 6 s) and sync still completes', async () => {
  const { b } = pair(SRC); ensureLoomDir(b, CFG);
  sh(b, 'remote', 'set-url', 'origin', 'https://10.255.255.1/x.git');
  const g = await testGraph(); await indexRepo(g, b, { baseline: true });
  const t = Date.now(); const out = await sync(g, b, { me: 'B@t', fetch: true });
  expect(Date.now() - t).toBeLessThan(8000);
  expect(out.fetched).toBe(false);
  await g.drop();
}, 15000);
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/sync.test.ts`
Expected: FAIL. "Failed to load url ../src/news.js".

- [ ] **Step 3: Implement**

`packages/memory/src/news.ts`:
```ts
import type { LoomGraph } from '@loom/core';
import { isAncestor } from './git.js';

export interface NewsItem { kind: 'version' | 'decision' | 'task' | 'handoff' | 'lesson'; id: string; region: string | null; path: string | null;
  text: string; by: string; person: string; task: string | null; at: number; score: number; upstreamOnly: boolean }

/** §6.3 step 5. `me` is a person id (git email). */
export async function news(g: LoomGraph, root: string, me: string, since: number, upstream: string | null): Promise<NewsItem[]> {
  const scope = new Set((await g.query<{ r: string }>(`MATCH (t:Task)-[:SCOPE]->(r:Region) WHERE t.status IN ['open','claimed']
    MATCH (s:Session {person: $me})-[:RAN]->(a:Agent) WHERE t.claimed_by = a.id RETURN DISTINCT r.id AS r`, { me })).map((x) => x.r));
  const near = new Set((await g.query<{ r: string }>(`MATCH (s:Region)-[:CALLS|IMPORTS*1..2]-(r:Region) WHERE s.id IN $ids RETURN DISTINCT r.id AS r`,
    { ids: [...scope] })).map((x) => x.r));
  const mine = new Set((await g.query<{ p: string }>(`MATCH (s:Session {person: $me}) WITH s ORDER BY s.started DESC LIMIT 3
    MATCH (s)-[:RAN]->(:Agent)<-[:BY]-(v:Version)-[:OF]->(r:Region) RETURN DISTINCT r.path AS p`, { me })).map((x) => x.p));
  const rows = await g.query<Omit<NewsItem, 'score' | 'upstreamOnly'> & { commits: string[] }>(`
    MATCH (v:Version)-[:OF]->(r:Region), (v)-[:BY]->(b) WHERE v.at > $since AND NOT coalesce(v.baseline, false)
    OPTIONAL MATCH (s:Session)-[:RAN]->(b) WITH v, r, b, coalesce(s.person, b.id) AS person WHERE person <> $me
    OPTIONAL MATCH (v)-[:FOR]->(t:Task) OPTIONAL MATCH (d:Decision)-[:LED_TO]->(v)
    RETURN 'version' AS kind, v.id AS id, r.id AS region, r.path AS path, coalesce(r.qname, r.id) + CASE WHEN d IS NULL THEN '' ELSE ' | ' + d.text END AS text,
      b.id AS by, person, t.id AS task, v.at AS at, coalesce(v.commits, []) AS commits
    UNION ALL
    MATCH (l:Lesson)-[:ON]->(r:Region) WHERE l.at > $since
    RETURN 'lesson' AS kind, l.id AS id, r.id AS region, r.path AS path, l.text AS text, '' AS by, '' AS person, null AS task, l.at AS at, [] AS commits
    UNION ALL
    MATCH (h:Handoff)-[:FROM]->(s:Session) WHERE h.at > $since AND s.person <> $me
    RETURN 'handoff' AS kind, h.id AS id, null AS region, null AS path, h.summary AS text, s.id AS by, s.person AS person, null AS task, h.at AS at, [] AS commits
    UNION ALL
    MATCH (t:Task) WHERE t.at > $since MATCH (a:Agent {id: t.claimed_by})<-[:RAN]-(s:Session) WHERE s.person <> $me
    RETURN 'task' AS kind, t.id AS id, null AS region, null AS path, t.title + ' (' + t.status + ')' AS text, a.id AS by, s.person AS person, t.id AS task, t.at AS at, [] AS commits`,
  { me, since });
  return rows.map(({ commits, ...r }) => ({ ...r,
    score: r.region && scope.has(r.region) ? 3 : r.region && near.has(r.region) ? 2 : r.path && mine.has(r.path) ? 1 : 0,
    upstreamOnly: r.kind === 'version' && commits.length > 0 && !commits.some((c) => isAncestor(root, c, 'HEAD')) }));
}

/** §6.4: deterministic, at most 25 lines. */
export function renderBriefing(h: { from: string; to: string; upstream: string | null; ahead: number; people: number; sessions: number;
  items: NewsItem[]; degraded: string[] }): string {
  const top = [...h.items].sort((a, b) => b.score - a.score || b.at - a.at || a.id.localeCompare(b.id)).slice(0, 10);
  const up = h.upstream ? `; upstream ${h.upstream} +${h.ahead}` : '';
  const out = [`[loom] Since your last sync (${h.from.slice(0, 7)} → ${h.to.slice(0, 7)}${up}), ${h.people} people, ${h.sessions} sessions:`];
  for (const i of top) {
    const [what, decision] = i.text.split(' | ');
    if (i.kind === 'version') {
      out.push(`- ${what} (${i.path}) changed${i.upstreamOnly && h.upstream ? ` on ${h.upstream}` : ''} by ${i.person}/${i.by.split('/').pop()}${i.task ? ` for ${i.task}` : ''}${i.upstreamOnly ? ' — not in your branch yet.' : '.'} [${i.id}]`);
      if (decision) out.push(`  Decision: "${decision}".`);
    } else if (i.kind === 'handoff') out.push(`- Handoff from ${i.person}: ${i.text} [${i.id}]`);
    else if (i.kind === 'lesson') out.push(`- Lesson on ${i.path}: "${i.text}" [${i.id}]`);
    else out.push(`- Task ${i.task} by ${i.person}: ${i.text} [${i.id}]`);
  }
  out.push(`- Degraded: ${h.degraded.length ? h.degraded.slice(0, 5).join(', ') : 'none'}.`);
  out.push('Ask: history(region) · why(region) · changes_since(commit)');
  return out.slice(0, 23).concat(out.length > 23 ? out.slice(-2) : []).join('\n');
}
```
> The `[${i.id}]` suffix on each news line keeps the test's `/v\d+/` order check valid and gives agents a handle for `history`. The §6.4 example omits ids. Ledger that as a ruling: ids are what make `why`/`history` callable from the briefing.

`packages/memory/src/sync.ts`:
```ts
import { spawnSync } from 'node:child_process';
import type { LoomGraph } from '@loom/core';
import { git, gitTry } from './git.js';
import { importSessions } from './importer.js';
import { indexRepo } from './indexrepo.js';
import { news, renderBriefing } from './news.js';
import { reconcile } from './reconcile.js';
import { refreshHead } from './commit.js';
import { ulid } from './ids.js';

export function upstreamRef(root: string): string | null {
  const u = gitTry(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  if (u) return u;
  const d = gitTry(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  return d ?? (gitTry(root, 'rev-parse', '--verify', '-q', 'origin/main') ? 'origin/main' : null);
}

/** §6.3. Never throws on network trouble; `fetched` is null when fetch was not asked for. */
export async function sync(g: LoomGraph, root: string, o: { me: string; fetch?: boolean; quiet?: boolean }) {
  const up = upstreamRef(root);
  let fetched: boolean | null = null;
  if (o.fetch !== false && up) {
    const r = spawnSync('git', ['fetch', '-q', up.split('/')[0]], { cwd: root, timeout: 5000, stdio: 'ignore' });
    fetched = r.status === 0;
    if (!fetched && !o.quiet) process.stderr.write(`[loom] fetch ${up} failed (${r.error?.message ?? `exit ${r.status}`}); syncing locally\n`);
  }
  const [wm] = await g.query<{ commit: string; at: number }>('MATCH (w:Watermark {person: $me}) RETURN w.commit AS commit, w.at AS at', { me: o.me });
  const head = git(root, 'rev-parse', 'HEAD');
  let imported = (await importSessions(g, root, null)).events;
  if (up) imported += (await importSessions(g, root, up)).events;
  await indexRepo(g, root);
  let reconciled = (await reconcile(g, root, wm?.commit ?? head, 'HEAD')).versions;
  if (up) reconciled += (await reconcile(g, root, head, up)).versions;
  await refreshHead(g, root);
  const items = await news(g, root, o.me, wm?.at ?? 0, up);
  const fresh = !wm;
  const shown = fresh ? latestHandoffPerPerson(items) : items.filter((i) => i.score > 0 || i.kind === 'handoff' || i.upstreamOnly);
  const people = new Set(shown.map((i) => i.person).filter(Boolean)).size;
  const sessions = new Set(shown.map((i) => i.by.split('/')[0]).filter(Boolean)).size;
  const degraded = (await g.query<{ p: string }>('MATCH (r:Region {degraded: true}) WHERE NOT r.tombstoned RETURN DISTINCT r.path AS p ORDER BY p')).map((x) => x.p);
  const ahead = up ? Number(gitTry(root, 'rev-list', '--count', `HEAD..${up}`) ?? 0) : 0;
  const briefing = renderBriefing({ from: wm?.commit ?? head, to: head, upstream: up, ahead, people, sessions, items: shown, degraded });
  await g.query(`CREATE (:Message {id: $id, kind: 'briefing', text: $briefing, at: $at})
    MERGE (w:Watermark {person: $me}) SET w.commit = $head, w.at = $at`, { id: ulid(), briefing, at: Date.now(), me: o.me, head });
  if (!o.quiet) console.log(briefing);
  return { briefing, imported, reconciled, fetched };
}

function latestHandoffPerPerson<T extends { kind: string; person: string; at: number }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const i of items) if (i.kind === 'handoff' && (!best.has(i.person) || best.get(i.person)!.at < i.at)) best.set(i.person, i);
  return [...best.values()];
}
```
> **Ruling to ledger:** news filters out items with score 0 unless they are handoffs or upstream-only. §6.3 says "select from other people … score … top 10" and does not say whether score 0 shows. Without the filter, a busy repo's briefing fills with unrelated work. *Cost if wrong:* someone misses unrelated news, which `changes_since` still returns.

Add `news.js` and `sync.js` to the barrel.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/sync.test.ts`
Expected: PASS 4/4.

---

### Task 9: Repo-scoped lessons, session start and finish

**Files:**
- Create: `packages/memory/src/lessons.ts`, `test/lessons.test.ts`
- Modify: `packages/memory/src/session.ts` (add `startSession`, `finishSession`)

**Interfaces:**
- Produces:
  - `addLesson(g, root, act: ActiveSession | null, region: string, text: string, source: 'manual'|'mined'): Promise<string>`
  - `lessonsFor(g, regions: string[], limit = 3): Promise<Array<{ id; text; region }>>`
  - `startSession(g, root, o: { person: string; kind: 'interactive'|'run'; writer?: string; model?: string }): Promise<{ sid: string; briefing: string }>`
  - `finishSession(g, root, o: { transcriptPath?: string; commit?: boolean }): Promise<{ handoff: string; uncommitted: boolean }>`

- [ ] **Step 1: Write the failing test** — `packages/memory/test/lessons.test.ts`
```ts
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { indexRepo } from '../src/indexrepo.js';
import { addLesson, lessonsFor } from '../src/lessons.js';
import { finishSession, readActive, startSession } from '../src/session.js';
import { closeDb, repo, sh, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };
const R = 'a.py::f::definition#0';

test('a lesson is a .loom event and a graph node ON the region; it only exists in its own repo graph (C1)', async () => {
  const r1 = repo({ 'a.py': 'def f():\n    return 1\n' }); ensureLoomDir(r1, CFG);
  const r2 = repo({ 'a.py': 'def f():\n    return 1\n' }); ensureLoomDir(r2, CFG);
  const g1 = await testGraph(); const g2 = await testGraph();
  await indexRepo(g1, r1); await indexRepo(g2, r2);
  await addLesson(g1, r1, null, R, 'run test_f after changing f', 'manual');
  expect((await lessonsFor(g1, [R])).map((l) => l.text)).toEqual(['run test_f after changing f']);
  expect(await lessonsFor(g2, [R])).toEqual([]);                    // same region id, other repo: nothing leaks
  expect(sh(r1, 'status', '--porcelain')).toMatch(/\.loom\/sessions\//);
  await g1.drop(); await g2.drop();
});

test('startSession writes session+agent events and the active file; finishSession writes a handoff from the transcript and clears it', async () => {
  const r = repo({ 'a.py': 'def f():\n    return 1\n' }); ensureLoomDir(r, CFG); const g = await testGraph(); await indexRepo(g, r, { baseline: true });
  const { sid, briefing } = await startSession(g, r, { person: 'a@t', kind: 'interactive' });
  expect(readActive(r)).toMatchObject({ sid, writer: 'main' });
  expect(briefing).toMatch(/^\[loom\] Since your last sync/);
  const tp = join(r, '..', `t-${sid}.jsonl`);
  writeFileSync(tp, [JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done: f now returns 1. Left: tests.' }] } })].join('\n'));
  const out = await finishSession(g, r, { transcriptPath: tp });
  expect(out.uncommitted).toBe(true);
  expect(readActive(r)).toBeNull();
  const lines = readFileSync(join(r, `.loom/sessions/${sid}.main.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type)).toEqual(['session', 'agent', 'handoff']);
  expect(lines[2].summary).toBe('Done: f now returns 1. Left: tests.');
  const c = await finishSession(g, r, { commit: true });
  expect(c.uncommitted).toBe(false);
  expect(sh(r, 'log', '-1', '--format=%s')).toBe(`loom: session ${sid} records`);
  expect(sh(r, 'show', '--name-only', '--format=', 'HEAD').split('\n').every((f) => f.startsWith('.loom/'))).toBe(true);
  await g.drop();
});
```

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/memory/test/lessons.test.ts`
Expected: FAIL. "Failed to load url ../src/lessons.js".

- [ ] **Step 3: Implement**

`packages/memory/src/lessons.ts`:
```ts
import type { LoomGraph } from '@loom/core';
import { appendEvent } from './events.js';
import { ulid } from './ids.js';
import type { ActiveSession } from './session.js';

/** §6.10: the lesson lives in this repo's graph and in this repo's .loom/ — never in a shared graph (C1). */
export async function addLesson(g: LoomGraph, root: string, act: ActiveSession | null, region: string, text: string, source: 'manual' | 'mined') {
  const e = appendEvent(root, act?.sid ?? ulid(), act?.writer ?? 'main', { type: 'lesson', text, regions: [region], source });
  await g.query(`MERGE (l:Lesson {id: $id}) SET l.text = $text, l.source = $source, l.at = $at
    MERGE (r:Region {id: $region}) ON CREATE SET r.stub = true MERGE (l)-[:ON]->(r)`, { id: e.id, text, source, at: e.at, region });
  return e.id;
}

export function lessonsFor(g: LoomGraph, regions: string[], limit = 3) {
  if (!regions.length) return Promise.resolve([]);
  return g.query<{ id: string; text: string; region: string }>(`MATCH (l:Lesson)-[:ON]->(r:Region) WHERE r.id IN $regions
    RETURN l.id AS id, l.text AS text, r.id AS region ORDER BY l.at DESC LIMIT ${Math.max(1, Math.floor(limit))}`, { regions });
}
```

Append to `packages/memory/src/session.ts`:
```ts
import type { LoomGraph } from '@loom/core';
import { appendEvent, sessionFile } from './events.js';
import { ulid } from './ids.js';
import { sync } from './sync.js';
import { gitTry } from './git.js';

export async function startSession(g: LoomGraph, root: string, o: { person: string; kind: 'interactive' | 'run'; writer?: string; model?: string }) {
  const sid = ulid(); const writer = o.writer ?? 'main';
  appendEvent(root, sid, writer, { type: 'session', person: o.person, kind: o.kind, base: gitTry(root, 'rev-parse', 'HEAD'), upstream: null });
  appendEvent(root, sid, writer, { type: 'agent', name: writer, model: o.model ?? null });
  writeActive(root, { sid, writer, by: writer, task: null });
  const { briefing } = await sync(g, root, { me: o.person, fetch: true, quiet: true });
  return { sid, briefing };
}

/** Last assistant text in a Claude Code transcript (jsonl); '' when unreadable. */
function lastAssistant(path?: string): string {
  if (!path || !existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').trim().split('\n').reverse();
  for (const l of lines) {
    try {
      const m = JSON.parse(l); if (m.type !== 'assistant') continue;
      const t = (m.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
      if (t) return t.slice(0, 500);
    } catch { /* skip */ }
  }
  return '';
}

/** §6.2 step 6. `commit: true` makes a commit that touches only .loom/ (`git commit -- .loom` with the pathspec). */
export async function finishSession(g: LoomGraph, root: string, o: { transcriptPath?: string; commit?: boolean }) {
  const act = readActive(root);
  let handoff = '';
  if (act) {
    const open = await g.query<{ id: string }>(`MATCH (t:Task) WHERE t.claimed_by STARTS WITH $sid AND t.status IN ['open','claimed'] RETURN t.id AS id`, { sid: act.sid });
    handoff = appendEvent(root, act.sid, act.writer, { type: 'handoff', summary: lastAssistant(o.transcriptPath), open_tasks: open.map((t) => t.id), open_leases: [] }).id;
    clearActive(root);
  }
  const dirty = () => !!gitTry(root, 'status', '--porcelain', '--', '.loom/');
  if (o.commit && dirty()) {
    const sid = act?.sid ?? /sessions\/(\w+)\./.exec(gitTry(root, 'status', '--porcelain', '--', '.loom/sessions') ?? '')?.[1] ?? 'unknown';
    gitTry(root, 'add', '--', '.loom'); gitTry(root, 'commit', '-q', '--no-verify', '-m', `loom: session ${sid} records`, '--', '.loom');
  } else if (dirty()) process.stderr.write('[loom] session records not committed: `loom finish --commit` commits only .loom/\n');
  return { handoff, uncommitted: dirty() };
}
```
Fix the imports at the top of `session.ts` to include `readFileSync` and `existsSync`. `open_leases: []` stays empty until P3 adds region leases.
> The second `finishSession(g, r, { commit: true })` in the test runs with no active session. It must find the session id from the dirty `.loom/sessions/` path. The regex above does this.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/memory/test/lessons.test.ts`
Expected: PASS 2/2.

---

### Task 10: Daemon repo resolution, interactive hooks, I1 gate

**Files:**
- Create: `packages/daemon/src/repo.ts`, `packages/daemon/test/i1.test.ts`
- Modify: `packages/daemon/src/server.ts` (SessionStart/SessionEnd for repos with `.loom/config.json`; lessons from the repo graph; no `lessonsGraph` option)
- Modify: `packages/daemon/package.json` (+ `"@loom/memory": "workspace:*"`)
- Modify: `packages/hook/src/loom-hook.ts` (2 s / 10 s timeouts)

**Interfaces:**
- Consumes: `readConfig`, `tenant`, `graphName`, `startSession`, `finishSession`, `lessonsFor` (memory)
- Produces:
  - `resolveRepo(db, cwd): Promise<{ root: string; graph: LoomGraph; tenant: string } | null>`, the only place a repo graph name is built
  - Routes: `POST /hook/claude/SessionStart` → `{hookSpecificOutput:{hookEventName:'SessionStart', additionalContext: briefing}}`; `POST /hook/claude/SessionEnd` → `{}`; `GET /repo/lessons?region=` (resolved from header `x-loom-cwd`)

- [ ] **Step 1: Read the server's hook dispatch first.** Run `sed -n 60,130p packages/daemon/src/server.ts` and `grep -n "lessons" packages/daemon/src/*.ts`. Note every place that names `'lessons'` or `opts.lessonsGraph`.

- [ ] **Step 2: Write the failing test** — `packages/daemon/test/i1.test.ts`
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { ensureLoomDir, graphName, indexRepo, repoId, addLesson } from '@loom/memory';
import { startServer } from '../src/server.js';
import { gitTree, tmpRecord } from './helpers.js';

let db: LoomDb; let srv: { port: number; close(): Promise<void> }; let url: string;
beforeAll(async () => { db = await LoomDb.connect(); srv = await startServer({ port: 0, db, uiPort: null, recordDir: tmpRecord() }); url = `http://127.0.0.1:${srv.port}`; });
afterAll(async () => { await srv.close(); await db.close(); });

const hook = (ev: string, cwd: string, home: string, extra: object = {}) => fetch(`${url}/hook/claude/${ev}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-loom-home': home }, body: JSON.stringify({ hook_event_name: ev, cwd, session_id: 's', ...extra }) });
const home = (t: string) => { const h = mkdtempSync(join(tmpdir(), 'loom-home-')); writeFileSync(join(h, 'config.json'), JSON.stringify({ tenant: t })); return h; };

test('I1: two tenants on the same repo get two graphs; lessons and briefings never cross; C1 lesson leak is closed', async () => {
  const r = gitTree({ 'a.py': 'def f():\n    return 1\n' });
  const cfg = ensureLoomDir(r, { repoId: repoId(r), dirs: ['.'], excludes: [], testCmd: null, share: true });
  const [ha, hb] = [home('ta'), home('tb')];
  const [ga, gb] = [db.graph(graphName('ta', cfg.repoId)), db.graph(graphName('tb', cfg.repoId))];
  await indexRepo(ga, r, { baseline: true }); await indexRepo(gb, r, { baseline: true });
  await addLesson(ga, r, null, 'a.py::f::definition#0', 'TENANT-A-SECRET', 'manual');
  const sa = await (await hook('SessionStart', r, ha)).json();
  const sb = await (await hook('SessionStart', r, hb)).json();
  expect(sa.hookSpecificOutput.additionalContext).toMatch(/^\[loom\]/);
  expect(JSON.stringify(sb)).not.toMatch(/TENANT-A-SECRET/);
  const lb = await (await fetch(`${url}/repo/lessons?region=a.py::f::definition%230`, { headers: { 'x-loom-cwd': r, 'x-loom-home': hb } })).json();
  expect(lb).toEqual([]);
  const la = await (await fetch(`${url}/repo/lessons?region=a.py::f::definition%230`, { headers: { 'x-loom-cwd': r, 'x-loom-home': ha } })).json();
  expect(la.map((l: any) => l.text)).toEqual(['TENANT-A-SECRET']);
  // forged graph names are ignored: no route accepts one
  const forged = await (await fetch(`${url}/repo/lessons?region=a.py::f::definition%230&graph=${graphName('ta', cfg.repoId)}`,
    { headers: { 'x-loom-cwd': r, 'x-loom-home': hb, 'x-loom-run': graphName('ta', cfg.repoId) } })).json();
  expect(forged).toEqual([]);
  expect((await db.list()).filter((n) => n === 'lessons')).toEqual([]);           // no global lessons graph is created
  await ga.drop(); await gb.drop();
});

test('a repo without .loom/config.json: SessionStart answers {} (v1 behaviour kept), never 500', async () => {
  const r = gitTree({ 'a.py': 'x = 1\n' });
  const res = await hook('SessionStart', r, home('tc'));
  expect(res.status).toBe(200);
});
```
> `x-loom-home` exists for tests only. The hook binary never sends it, and the daemon falls back to `LOOM_HOME` and then `~/.loom`. It is a stand-in for the second OS user that tenants model. Ledger it as a ruling: a tenant is "who runs the daemon", and the header lets one test process act as two. The daemon still never accepts a *graph name*.

- [ ] **Step 3: Run it to see it fail**
Run: `npx vitest run packages/daemon/test/i1.test.ts`
Expected: FAIL. The SessionStart response has no `hookSpecificOutput`, or `/repo/lessons` returns 404.

- [ ] **Step 4: Implement**

`packages/daemon/src/repo.ts`:
```ts
import type { LoomDb, LoomGraph } from '@loom/core';
import { git, graphName, readConfig } from '@loom/memory';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** I1: the only place a repo graph name is built — from the session's cwd and the tenant, never from request input. */
export async function resolveRepo(db: LoomDb, cwd: string, home?: string): Promise<{ root: string; graph: LoomGraph; tenant: string } | null> {
  let root: string;
  try { root = dirname(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')); } catch { return null; }
  const cfg = readConfig(root); if (!cfg) return null;
  const hp = join(home ?? process.env.LOOM_HOME ?? join(process.env.HOME ?? '', '.loom'), 'config.json');
  const tenant = String((existsSync(hp) ? JSON.parse(readFileSync(hp, 'utf8')).tenant : undefined) ?? process.env.USER ?? 'local');
  return { root, graph: db.graph(graphName(tenant, cfg.repoId)), tenant };
}
```
> `root` is the main checkout, taken from the common dir. Session files and the active-session file are written in the *worktree* (`cwd`'s toplevel), so pass `git(cwd,'rev-parse','--show-toplevel')` to `startSession`/`finishSession`. The two are the same for a non-worktree clone.

In `server.ts`, at the top of the `/hook/claude/<event>` handler, before the run/coordinator lookup:
```ts
if (harness === 'claude' && (event === 'SessionStart' || event === 'SessionEnd')) {
  const repo = await resolveRepo(opts.db, input.cwd, req.headers['x-loom-home'] as string | undefined);
  if (repo && !req.headers['x-loom-run']) {
    const top = git(input.cwd, 'rev-parse', '--show-toplevel');
    try {
      if (event === 'SessionStart') {
        const person = gitTry(top, 'config', 'user.email') ?? 'unknown';
        const { briefing } = await startSession(repo.graph, top, { person, kind: 'interactive' });
        return send(200, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: briefing } });
      }
      await finishSession(repo.graph, top, { transcriptPath: (input as any).transcript_path });
      return send(200, {});
    } catch (e) { console.error(`[loom] ${event}: ${String(e)}`); return send(200, {}); }   // fail open
  }
}
```
Add the route:
```ts
if (req.method === 'GET' && path === '/repo/lessons') {
  const repo = await resolveRepo(opts.db, String(req.headers['x-loom-cwd'] ?? ''), req.headers['x-loom-home'] as string | undefined);
  return send(200, repo ? await lessonsFor(repo.graph, [String(u.searchParams.get('region'))], 10) : []);
}
```
Remove `lessonsGraph` from the `startServer` options. Replace `new Lessons(opts.db.graph(opts.lessonsGraph ?? 'lessons'))` with a per-run `Lessons` on `opts.db.graph(<run graph>)`. This is an interim step: P3 moves runs into the repo graph, and lessons go with them. Then delete every caller of the global `'lessons'` graph, and run `grep -rn "'lessons'" packages/` until it prints nothing.

`packages/hook/src/loom-hook.ts`: change the timeout line to
```ts
signal: AbortSignal.timeout(Number(event === 'SessionStart' ? (process.env.LOOM_HOOK_TIMEOUT_MS_START ?? 10000) : (process.env.LOOM_HOOK_TIMEOUT_MS ?? 2000))),
```

- [ ] **Step 5: Run it to see it pass, then the whole daemon suite**
Run: `npx vitest run packages/daemon/test/i1.test.ts && npx vitest run packages/daemon`
Expected: PASS 2/2. The full daemon suite stays green; the lessons tests in `coordinator.test.ts` move to run-graph lessons. If one asserted a cross-run leak (v1 C1 behaviour), it is now deliberately inverted: rename it `lessons stay in their graph (C1 fixed)` and record a ruling.

- [ ] **Step 6: Fail-open test for the hook binary**
Add to `packages/daemon/test/attach.test.ts` (it already spawns the bundled hook), or create `packages/hook/test/failopen.test.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { expect, test } from 'vitest';
test('hook fails open within the 2 s budget when the daemon hangs', async () => {
  const s = createServer(() => {}).listen(0); const port = (s.address() as any).port;     // accepts, never answers
  const t = Date.now();
  const r = spawnSync('npx', ['tsx', 'packages/hook/src/loom-hook.ts', 'claude', 'PreToolUse'], { input: '{}', env: { ...process.env, LOOM_URL: `http://127.0.0.1:${port}` }, encoding: 'utf8' });
  s.close();
  expect(r.status).toBe(0); expect(r.stdout).toBe('');
  expect(Date.now() - t).toBeLessThan(2000 + 3000);                                       // 2 s budget + tsx start-up
});
```
Run: `npx vitest run packages/hook` and expect PASS.

---

### Task 11: CLI — `init` (§6.1), `sync`, `brief`, `finish`, `hook git`, `lesson`

**Files:**
- Modify: `packages/cli/src/loom.ts`, `packages/cli/package.json` (+ `@loom/memory`), `packages/cli/test/init.test.ts`
- Create: `packages/cli/test/memory-cli.test.ts`

**Interfaces:**
- Consumes: the memory barrel
- Produces: `initRepo(cwd, o: { hookCmd: string; mcpPath?: string; loomCmd: string; tenant?: string; testCmd?: string; db?: LoomDb }): Promise<{ summary: string }>`. It is async now, so callers await it.

- [ ] **Step 1: Write the failing test** — `packages/cli/test/memory-cli.test.ts`
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { LoomDb } from '@loom/core';
import { graphName, readConfig, repoId, tenant } from '@loom/memory';
import { initRepo, main } from '../src/loom.js';

let db: LoomDb;
afterAll(async () => { await db?.close(); });
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=a@t', '-c', 'user.name=A', ...a], { cwd, encoding: 'utf8' }).trim();
import { mkdtempSync, mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os';
function repo() { const d = mkdtempSync(join(tmpdir(), 'loom-cli2-')); mkdirSync(join(d, 'pkg')); writeFileSync(join(d, 'pkg/a.py'), 'def f():\n    return 1\n');
  g(d, 'init', '-q', '-b', 'main'); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'base'); return d; }

test('init: refuses no commits; writes config with repoId; lock; baseline; git hooks; Claude hooks with Bash matcher; idempotent', async () => {
  db = await LoomDb.connect();
  const empty = mkdtempSync(join(tmpdir(), 'loom-e2-')); g(empty, 'init', '-q');
  await expect(initRepo(empty, { hookCmd: 'node /x/h.cjs', loomCmd: 'node /x/loom.cjs', db })).rejects.toThrow(/no commits/);
  const r = repo();
  const a = await initRepo(r, { hookCmd: 'node /x/h.cjs', loomCmd: 'node /x/loom.cjs', db });
  const b = await initRepo(r, { hookCmd: 'node /x/h.cjs', loomCmd: 'node /x/loom.cjs', db });
  expect(readConfig(r)!.repoId).toBe(repoId(r));
  expect(existsSync(join(r, '.loom/regions.lock'))).toBe(true);
  expect(readFileSync(join(r, '.git/hooks/pre-commit'), 'utf8')).toMatch(/node \/x\/loom\.cjs hook git pre-commit/);
  const s = JSON.parse(readFileSync(join(r, '.claude/settings.local.json'), 'utf8'));
  expect(s.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|Bash');
  expect(Object.keys(s.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart']);
  expect(a.summary).toMatch(/files: 1 · regions: \d+ · degraded: 0 · unresolved calls: \d+ · sessions: 0 · people: 1/);
  expect(b.summary).toMatch(/reparsed: 0/);
  await db.graph(graphName(tenant(), repoId(r))).drop();
});

test('loom sync --json and loom lesson add/list run against the repo graph', async () => {
  const r = repo(); await initRepo(r, { hookCmd: 'h', loomCmd: 'l', db });
  const cwd = process.cwd(); process.chdir(r);
  try {
    expect(await main(['lesson', 'add', 'pkg/a.py::f::definition#0', 'keep f pure'])).toBe(0);
    const log: string[] = []; const orig = console.log; console.log = (s: string) => log.push(s);
    try { expect(await main(['lesson', 'list', '--json'])).toBe(0); expect(await main(['sync', '--no-fetch', '--json'])).toBe(0); } finally { console.log = orig; }
    expect(JSON.parse(log[0]).map((l: any) => l.text)).toEqual(['keep f pure']);
    expect(JSON.parse(log[1])).toMatchObject({ briefing: expect.stringMatching(/^\[loom\]/) });
  } finally { process.chdir(cwd); await db.graph(graphName(tenant(), repoId(r))).drop(); }
});
```
Update `packages/cli/test/init.test.ts` to the new async signature and the new matcher. The old `.loom/config.json` `{run, dirs, daemon}` shape becomes `LoomConfig` plus the v1 fields that the run mode still reads (`run`, `daemon`). Keep both sets of keys in the file until P3 removes `run`.

- [ ] **Step 2: Run it to see it fail**
Run: `npx vitest run packages/cli/test/memory-cli.test.ts`
Expected: FAIL. `initRepo` is not async / has no `loomCmd`.

- [ ] **Step 3: Implement**

In `loom.ts`:
- `EVENTS` becomes `[['SessionStart', undefined], ['PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit|Bash'], ['PostToolUse', '*'], ['SessionEnd', undefined]]`. Keep `UserPromptSubmit` and `Stop` only if `run.ts` relies on them (`grep -n "Stop\|UserPromptSubmit" packages/daemon/src/server.ts`); if it does, keep them and adjust the test's key list. Record a ruling.
- `initRepo` (async) runs:
  1. `repoId(root)` (throws on an empty repo).
  2. `ensureLoomDir(root, { repoId, dirs, excludes: DEFAULT_EXCLUDES, testCmd: o.testCmd ?? detectTestCmd(root), share: true, ...v1 run/daemon keys })`.
  3. `const g = db.graph(graphName(o.tenant ?? tenant(), cfg.repoId))`.
  4. `const s = await indexRepo(g, root, { baseline: !hadLock })`.
  5. `installGitHooks(root, o.loomCmd)`.
  6. `mergeHooks(...)`, plus the `.mcp.json` merge as today.
  7. `await importSessions(g, root, null)`; `await reconcile(g, root, null, 'HEAD', 200)` only when the lock pre-existed (a clone of a Loom repo).
  8. The summary: `files: N · regions: N · degraded: N · unresolved calls: N · sessions: N · people: N · reparsed: N`.
- `detectTestCmd`: `pyproject.toml` or `setup.cfg` → `python -m pytest -q`; `package.json` with `scripts.test` → `npm test`; else `null`.
- New commands, each with `--json`:
  - `sync [--quiet] [--no-fetch]` → `sync(g, root, { me: git config user.email, fetch: !noFetch, quiet })`;
  - `brief` → the latest `Message {kind:'briefing'}` text;
  - `finish [--commit]` → `finishSession`;
  - `hook git <name> [args]` → `pre-commit`: `preCommit(top, g | null)` (connect with a 1.5 s race, null on failure); `post-commit`: `postCommit`; `post-merge`/`post-checkout`/`post-rewrite`: `sync(…, { fetch: false, quiet: true })`. It always exits 0 and prints errors to stderr.
  - `lesson add <region> <text>` / `lesson list [region]` → the memory lessons on the repo graph.
- Repo graph resolution in the CLI mirrors `daemon/src/repo.ts`. Import `resolveRepo` from `@loom/daemon` so the name is built in one place only.

- [ ] **Step 4: Run it to see it pass**
Run: `npx vitest run packages/cli`
Expected: PASS, all CLI tests including the updated `init.test.ts`.

- [ ] **Step 5: Bundle smoke (P1-10 style)**
Run: `pnpm build:cli && cd /private/tmp/claude-501/-Users-18abhinav07-Documents-Brain-10-Projects/50197c36-9a7e-41cf-9454-d11503a74c36/scratchpad && rm -rf p2cli && mkdir p2cli && cd p2cli && git init -q -b main && printf 'def f():\n    return 1\n' > a.py && git add -A && git -c user.email=a@t -c user.name=A commit -qm base && node /Users/18abhinav07/Documents/loom-v2/packages/cli/dist/loom.cjs init && printf 'def f():\n    return 2\n' > a.py && git add a.py && git -c user.email=a@t -c user.name=A commit -qm edit && node /Users/18abhinav07/Documents/loom-v2/packages/cli/dist/loom.cjs sync --no-fetch`
Expected: init prints the summary line. The commit succeeds (no active session means pre-commit writes nothing). sync prints a briefing that lists nothing from other people and contains `Degraded: none.`

---

### Task 12: L0 memory gate, I1 gate, ledger

**Files:**
- Create: `packages/memory/test/l0-memory.test.ts` (the end-to-end two-clone gate)
- Modify: `docs/proofs/LEDGER.md`

- [ ] **Step 1: Write the gate test.** Two clones with real git hooks installed through `initRepo`, and the CLI run with `npx tsx packages/cli/src/loom.ts`. All of the following in one file:
  1. A starts a session (`startSession`), edits `slugify`, commits through the real hooks. The version event is in the commit, and `Version.commits` = [that sha].
  2. A pushes. B's `sync` (fetch on) shows A's change as `not in your branch yet` (X2 mechanics, deterministic).
  3. B pulls. post-merge sync moves `Region.HEAD` to A's version, and the next briefing no longer says `not in your branch yet` for it.
  4. B commits on `slugify` with `--no-verify`. The next sync in A creates `ext:<sha>:<slugify>` BY `B@t`.
  5. A and B both append to their own session files on diverging branches and merge: no conflict, and import counts every event once (re-import is a no-op).
  6. A rebases its branch. Re-import adds the rebased sha to `commits[]`, and current-per-ref on the rebased HEAD finds A's version.
  7. With FalkorDB unreachable (`FALKORDB_URL=redis://127.0.0.1:1`), `git commit` still succeeds and prints `[loom] … continuing`.
- [ ] **Step 2: Run the gate and keep the output**
Run: `npx vitest run packages/memory packages/daemon/test/i1.test.ts packages/hook 2>&1 | tee bench/results/l0-memory.txt | tail -20`
Expected: every test passes. Record the counts.
- [ ] **Step 3: Ledger rows** (status set only by the evidence above):

| ID | Claim | Phase | Settled by |
|---|---|---|---|
| P2-1 | repoId is computed once and survives history change / shallow clone | P2 | ids.test |
| P2-2 | Import is idempotent (re-import adds 0 nodes) | P2 | importer.test, l0-memory step 5 |
| P2-3 | Commit association survives amend and rebase (commits[] + rekeyed import) | P2 | importer.test, l0-memory step 6 |
| P2-4 | One-writer files + union merge: diverging branches merge their records without conflict | P2 | events.test, l0-memory step 5 |
| P2-5 | pre-commit versions the index text under partial staging | P2 | commit.test |
| P2-6 | Edits outside Loom (`--no-verify`, humans) become external versions by the git author | P2 | reconcile.test, l0-memory step 4 |
| P2-7 | B sees A's pushed change and decision before pulling | P2 | sync.test, l0-memory step 2 |
| P2-8 | Briefing is deterministic and ≤ 25 lines | P2 | sync.test |
| P2-9 | Hooks fail open: claude hook ≤ 2 s, git commit succeeds with Loom down | P2 | hook failopen test, githooks.test, l0-memory step 7 |
| P2-10 | I1: 2 tenants on one repo, 0 cross-reads; C1 lesson leak closed | P2 | i1.test |
| P2-11 | `loom init` on Django: first-run time, and second run reparses 0 files | P2 | Task 3 Step 5 numbers |
| P2-12 | Reconcile is capped at 200 commits per ref with a range version | P2 | reconcile.test |

- [ ] **Step 4:** Run the whole suite: `npx vitest run 2>&1 | tail -5`. Expected: all green, with the count recorded in the ledger.

---

## Commit plan (after 16:30, real timestamps, on `feat/p2-memory`)

One commit per task, message `feat(memory): <task title>` (`feat(daemon)`, `feat(cli)` or `test(gate)` where that fits), each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. One PR, `feat/p2-memory` → `main`. Abhinav merges.

## Self-review

- **Spec coverage:** §4.1 → T1, T10. §4.2–4.4 → T3, T4, and T6 (Region, Version, Commit, Person, Session, Agent, Task, Decision, Evidence, Lesson, Message, Thread, Handoff, Watermark nodes and their edges; `WAITS_ON`/`LEASED` are P3). §4.6 → T7. §5 → T1, T2. §5.1 → T2, T4. §5.2 → T4. §6.1 → T11. §6.2 steps 1, 5, 6 → T6, T9, T10 (steps 2–4 are P3). §6.3 → T8. §6.4 → T8. §6.10 scope → T9, T10. L0 memory parts and I1 → T12.
- **Deliberately not in P2:** leases on Region, the version check (§6.5), PostToolUse Change/notices, unleased_write detection, the run coordinator moving into the repo graph. All of these are P3.
