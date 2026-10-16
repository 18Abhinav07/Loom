---
title: Loom — product design (lead, team, collaborators, data)
date: 2026-10-16
status: draft, awaiting approval
supersedes: the product/flow parts of docs/specs/2026-10-15-loom-v2-design.md §6, §8, §9 (regions, graph, lock and language packs in that spec stay in force)
---

# Loom — product design

## 0. The product in one paragraph

Loom is a coordination layer for Claude Code on one codebase. You run `loom init` once. It opens a **lead**: your normal `claude` session in the terminal, which you can also chat with from the Loom dashboard. The lead finds or writes a **team plan** with you. When the plan is ready, it starts **N agents** that build in parallel without breaking each other: per-function locks, waits, warnings when code they call changes, and landing checks (merge, callers, tests, compiler). Everything that happens is recorded in `.loom/`: who did what, why, which agents, every collision. That record travels through git, so every collaborator's lead and agents get it. The dashboard shows all of it.

**Principle: simple to use, deep on demand.** The user only needs `loom init` and a conversation. Everything else (sync, status, team control, history, collisions, the collaboration graph) is one click in the dashboard, or one command for terminal users. Everything Loom sees is recorded, so any view can be drawn later.

### What Loom still does not promise
- No real-time coordination between machines. Collaborators are asynchronous through git.
- No history before `loom init`.
- No full transcripts in git (§4.4).

## 1. Who and what

| Actor | What it is |
|---|---|
| **Person** | A human, keyed by `git config user.email`. Display name from `user.name`. |
| **Lead** | One interactive `claude` session per person per working period. It plans, starts the team, talks to agents, reports. |
| **Agent** | One headless `claude` that Loom starts for one task of a team plan, in its own worktree. |
| **Team** | One execution of a team plan: one lead plus N agents. Called a *run* in the code. |
| **Session** | Any Claude session Loom saw: a lead, a plain interactive session, or an agent. |

It's N + 1: one lead orchestrates N agents. A person can also just work in a plain session with no team; Loom still gives briefings, locks and memory.

## 2. Surfaces

| Surface | Used for |
|---|---|
| **Terminal** | `loom init` (always), the lead conversation (optional), every other command (optional). |
| **Dashboard** | The lead conversation (optional), every command after init, every view. |

**Parity rule:** every capability after init exists both as a daemon route (for the dashboard) and as a CLI command. The CLI is a thin client of the daemon wherever the daemon is up.

## 3. Flows

### 3.1 `loom init`

It detects the repo's state and does only what that state needs. Every step is idempotent; running init twice changes nothing the second time.

| State | What init does |
|---|---|
| **A. No commits** | Makes an initial commit (`.loom/` plus a `.gitignore` if missing), then continues as B. |
| **B. Has commits, no `.loom/`** | Creates the config, detects the languages and the test/compile commands, indexes, writes the lock and the baseline, installs the hooks and the MCP/channel server, then commits `.loom/` (asking first). |
| **C. Has `.loom/`** (a clone or an older init) | Keeps the config and baseline. Re-reads only files whose hash differs from the lock. Imports every session file. Catches up on missed commits (up to 200). Reinstalls hooks if missing. Upgrades older config versions in place. |

**In every state:**
- Starts FalkorDB and the daemon if they're not running.
- Prints the summary: files, regions per language, degraded files, sessions, people, last activity.
- Ends with `Start the lead now? [Y/n]`. Yes replaces the init process with the lead (§3.2), in the same terminal.
- `loom init --no-lead` skips the question (for CI and scripts).

### 3.2 The lead: one conversation, two surfaces

**How it starts.** `loom lead`, or the end of init, runs:

```
claude --dangerously-load-development-channels server:loom
```

in the repo root. `loom-mcp` (the existing tool server) is registered in `.mcp.json` and declares two Claude Code channel capabilities: `claude/channel` and `claude/channel/permission`. Channels are a Claude Code research preview; this flag is documented in code.claude.com/docs/en/channels-reference. Claude Code shows a one-time confirmation when the session starts.

**Dashboard → session.**
1. The dashboard POSTs the message to the daemon.
2. The daemon forwards it to the session's `loom-mcp` over a localhost socket.
3. `loom-mcp` emits a `notifications/claude/channel` event with `meta.from = "dashboard"`.

Claude Code queues these and delivers them in order when the session is free ("Events queue into the session and are processed in order", channels-reference). The terminal shows them as channel messages.

**Session → dashboard: a live mirror.**
- `UserPromptSubmit` hook → the user's terminal message.
- `PreToolUse` / `PostToolUse` hooks → tool calls and results.
- `Stop` hook → the final reply of each turn.
- Tailing the session's `transcript_path` → mid-turn text. The format is internal to Claude Code, so Loom's parser is tolerant, and the hook payloads are the source of truth.

The daemon broadcasts all of these on the event stream, so both surfaces show the same conversation.

**Permissions.**
- `loom-mcp` relays `permission_request` events to the daemon.
- The dashboard shows Allow/Deny; the terminal shows Claude's own prompt.
- The first answer wins.

**Security.**
- `loom-mcp` accepts channel input only from the daemon's socket.
- The daemon accepts dashboard input only from localhost, with a per-repo token written to `.git/loom-token`. That file is not shared.

**Degraded mode.** If the session was started without the flag, there is no channel. The dashboard still mirrors it through the hooks, and shows "read-only: restart the lead with `loom lead` to chat here".

**Many sessions.** Every Claude session in the repo shows up in the dashboard, mirrored. Only sessions started with the channel can be chatted with. The lead is whichever session was started by `loom lead` or init. A person can start a fresh lead at any time; the old one becomes a past session.

### 3.3 The plan rule

**A plan is always required to start a team. A discussion is not.**

**Finding a plan.** The lead's first briefing tells it, before any team starts, to:
1. Ask the user whether a plan, spec or reference already exists. It can be a path, a folder, a URL, or pasted text.
2. Otherwise, scan the repo for candidates: `docs/`, `plans/`, `specs/`, `design/`, files matching `*PLAN*`, `*SPEC*`, `*DESIGN*` (any case), the README, and `.loom/plans/`. Then ask "Is one of these the plan?"
3. If nothing exists, offer two paths:
   - **Discuss with me:** design it together.
   - **Draft from your one-liner:** the lead writes a plan straight away, and the user approves or edits it.

Loom never requires any folder of the user's.

**The team plan** is a Markdown file at `.loom/plans/<slug>.md`, with a YAML front matter block that Loom validates. User documents are linked, not copied.

```yaml
---
goal: Hyperledger Fabric network for multiple clients
sources: [docs/design.md, https://…]          # whatever the plan was built from
test: npm test
compile: npx tsc --noEmit                      # optional; from init's detection
base: main
tasks:
  - id: chaincode
    title: Asset chaincode
    owns: [chaincode/asset/**]                 # files or modules this agent may create/change
    reads: [shared/types.ts]                   # interfaces it depends on
    after: []                                  # task ids that must land first
    done: chaincode unit tests pass; exports AssetContract
    prompt: |
      …full instructions for the agent…
  - id: client-sdk
    …
---
(free-form notes, rationale, links)
```

**The plan checker** is `loom plan check <file>`, also exposed as the `check_plan` tool and the `POST /plans/check` route. It refuses a team start and names each problem if any of these is true:
- a task lacks `id`, `title`, `owns`, `done` or `prompt`;
- two tasks `own` overlapping paths with no `after` ordering between them;
- a task `reads` a path that neither exists nor is `owned` by an earlier task;
- `after` has a cycle or an unknown id;
- `test` is missing;
- the repo has no code under any `reads` path, and no scaffold task comes first. This is the **empty-repo rule**: the lead scaffolds the shared skeleton, alone or as task 0, before parallel work.

It warns, without refusing:
- `owns` globs that match more than 40% of the indexed regions;
- tasks with no `reads`.

### 3.4 The team

Started by the lead's `start_team(plan)` tool, the dashboard's Start button, or `loom team start <plan>`. All three call the same daemon route.

- **One agent per task**, each in its own worktree, started when its `after` tasks have landed.
- Agents are `claude -p --input-format stream-json --output-format stream-json`. Their stdin stays open, so the daemon can send a running agent a message (from `message_agent`, the dashboard, or `loom team msg`). The existing PreToolUse notice path stays as the fallback.
- Locks, waits, warnings, version checks, the landing queue and landing checks work as today (spec §6.6). Landing also runs `compile` when the plan sets it; only errors the base didn't have block.
- The lead's tools:
  - `start_team(plan)`, `team_status()`, `message_agent(agent, text)`, `stop_team()`;
  - `stop_agent(agent)`, `restart_agent(agent, note?)`.
- Agent replies and landings are delivered to the lead as channel events (`meta.from = "agent:<name>"`), so the lead hears what happens without polling.
- **Finish:** landed work collects on `loom/<team>/landed`. The lead reports. The user reviews and merges it, or asks the lead to merge it (`loom team merge`).

**Team sizes** are all the same machinery. "One agent" is a one-task plan. "Two" and "many" differ only in how many tasks there are.

### 3.5 Plain sessions

Any `claude` started in the repo (no channel, no team) gets:
- the hooks, the briefing and the version check;
- locks against running teams;
- a handoff at the end.

It is recorded like every other session.

### 3.6 Collaborators

- Person A works (lead, team, plain sessions), commits and pushes. Person B pulls, or clicks Sync.
- `loom sync` imports A's session files, rebuilds the graph, writes B's briefing, and detects collisions (§4.3).
- B's sessions and agents get A's decisions in their briefings, and are denied with A's reason when they edit a function A changed that B hasn't pulled.
- Nothing needs a server. Git is the transport.

## 4. `.loom/`: one folder, many people, no conflicts

### 4.1 Layout

```
.loom/
  .gitattributes          # union merge for the lock and the session files
  config.json             # fixed at first init; versioned ("v": 2)
  regions.lock            # spec §3.11
  plans/<slug>.md         # team plans (§3.3); normal git merges
  sessions/<sid>.<writer>.jsonl
```

### 4.2 Why many people never conflict

- **One file per session and writer.** `sid` is a ULID minted on the person's machine. `writer` is `lead`, `main` (a plain session), or the agent's task id.
- **Every file has exactly one writer, ever, and is append-only.** Two people (or two agents) never write the same file, so git merges are additions only.
- Union merge on `sessions/*.jsonl` is the safety net. Import dedupes by event id.
- **Each agent is its own session.** Its `session` event names `kind: "agent"`, `parent: <lead sid>`, `team: <team id>`, `plan: <slug>`, `task: <id>`. So "A's lead → its 3 agents → what each changed" is a direct walk.
- **Person** comes from the `session` event's `person` (git email), written by whoever started the session. An agent inherits its lead's person.
- **The lock** is union-merged and checked per region (spec §3.11). **Config** never changes after init.

### 4.3 Events: record everything Loom sees

There is still one JSON object per line, `{v:1, type, id, at, …}`. The existing types stay: `session`, `agent`, `task`, `version`, `decision`, `evidence`, `lesson`, `message`, `handoff`. The `session` event gains the fields `parent`, `team`, `plan`, `task` and `surface` (terminal | dashboard | headless).

New types:

| Type | Fields | Written when |
|---|---|---|
| `turn` | `from` (user \| dashboard \| claude \| agent:<n>), `text` (≤ 4 000 chars; longer is cut, with `cut:true`), `tools` (names and counts) | every user message and every final reply, in lead and plain sessions |
| `tool` | `name`, `target` (path or region), `ok`, `ms` | every PostToolUse, in every session |
| `plan` | `slug`, `action` (created \| edited \| checked \| approved), `problems[]` | plan lifecycle |
| `team` | `team`, `plan`, `action` (started \| agent_started \| agent_landed \| agent_rejected \| stopped \| merged), `agent?`, `detail` | team lifecycle, written by the lead's writer |
| `collision` | `kind` (incl. `out_of_scope`, §11.2), `region[]`, `parties[]` ({person, session, agent}), `outcome`, `waited_ms?`, `detail` | see the next list |

**Collision kinds.** Every time two lines of work met is one record:
- `lock_wait`: an agent waited for a lock someone else held.
- `lock_denied`: a session was denied a lock.
- `caller_warning`: a signature changed under someone's caller.
- `stale_version`: the version check denied an edit to a function another person changed.
- `merge_conflict`: a git conflict at landing or pull, mapped to regions with `loom conflict`.
- `landing_rejected`: callers, tests or compiler failed after merge.
- `divergence`: sync found two people changed the same region since their common base.

**`outcome`:** waited | adapted | acked | resolved | rejected | open.

**Collision ids are deterministic:** a hash of `kind`, the sorted parties, the region and the triggering version. When both people's machines detect the same divergence, the two records collapse into one on import.

### 4.4 Shared vs local

| Data | Where |
|---|---|
| Everything in §4.3 | `.loom/sessions/` (shared through git; `share:false` keeps it local) |
| Full transcripts | Not copied. Claude Code already keeps them in `~/.claude/projects/…`. The local graph stores the path, so the dashboard can open the full conversation for sessions on this machine. |
| Per-step traces of agents (every stream-json line) | `.git/loom/runs/<team>/` (local), as today |
| Tokens and secrets | Never written. `turn.text` passes through a redaction step (common key patterns, `.env` values) before it is written. |

## 5. The graph: what the dashboard can ask

All views are queries over nodes the import already builds:
- Person, Session, Agent, Task, Region, Version, Decision, Evidence, Lesson, Message, Handoff;
- plus the new Plan, Team, Turn and Collision nodes.

New edges:
- `Person-RAN->Session`
- `Session-CHILD->Session` (lead → agents)
- `Session-IN->Team`
- `Team-OF->Plan`
- `Collision-AT->Region`
- `Collision-BETWEEN->Session`

| Question (one per view) | Answered by |
|---|---|
| What changed since I last synced, and why? | Version / Decision since the watermark (exists) |
| What's live right now? | Sessions without `handoff`; teams `started` and not `stopped`; live locks |
| Past sessions: who, when, what, the handoff, the turns | Session + Turn + Version + Handoff |
| People: each person → sessions → agents → regions changed | Person-RAN-Session-CHILD-Session-…-Version-Region |
| Collaboration graph: who works near whom | People linked by regions they both changed, or by shared collisions, weighted by count |
| Collisions: where people and agents meet most | Collision grouped by region and by pair of people, by kind and outcome |
| One function's story | Region → Versions (by, task, decision, commit) → Collisions |
| How the map grew | Versions bucketed by commit (or day): regions added, changed, removed per person |
| A team | Team → Plan → agent Sessions → collisions → landings |

## 6. Languages

| Language | Regions (locks, history) | Landing checks |
|---|---|---|
| Python | Loom's reader (exists) | merge, callers, tests |
| TypeScript / TSX / JavaScript | tree-sitter packs (exist in `indexer/src/regions/packs/`). Init indexes these files too, not only Python folders. | merge, callers, tests; TS also `tsc --noEmit`, with only new errors blocking |
| Go, Rust, Java | whole-file regions (spec §3.7 fallback) | merge, tests, plus the compiler (`go vet` / `cargo check` / `javac` via the build tool), new errors only |
| Markdown, JSON | heading and key regions (spec §3.7) | merge |

Init detects languages by file count and sets `compile` per detected typed language. Plain JS has no compiler gate. A file in a language with no pack is still locked, just whole-file.

## 7. Commands and routes

Every capability after init exists in both places (§2).

| Capability | CLI | Daemon route | Lead tool |
|---|---|---|---|
| set up a repo | `loom init` | — | — |
| start or attach the lead | `loom lead` | — (terminal only) | — |
| chat with a session | (the terminal itself) | `POST /sessions/:sid/messages` | — |
| sync with teammates | `loom sync` | `POST /sync` | `sync` |
| status | `loom status` | `GET /status` | `team_status` |
| briefing | `loom brief` | `GET /brief` | (injected) |
| plan: list, show, check | `loom plan ls\|show\|check` | `GET /plans`, `GET /plans/:slug`, `POST /plans/check` | `check_plan` |
| team: start, stop, merge | `loom team start\|stop\|merge` | `POST /teams`, `POST /teams/:id/stop`, `POST /teams/:id/merge` | `start_team`, `stop_team` |
| message, stop or restart an agent | `loom team msg\|stop-agent\|restart-agent` | `POST /teams/:id/agents/:a/(messages\|stop\|restart)` | `message_agent`, `stop_agent`, `restart_agent` |
| permission answer | (terminal prompt) | `POST /sessions/:sid/permissions/:rid` | — |
| sessions, people, collisions, region history, growth, teams | `loom sessions\|people\|collisions\|history\|growth` | `GET /sessions`, `/sessions/:sid`, `/people`, `/collab`, `/collisions`, `/regions/:id`, `/growth`, `/teams/:id` | `why`, `who_is_touching`, `impact` (exist) |
| why, conflict, lessons, verify | existing commands | existing / new routes | existing tools |
| live events | `loom watch` | `GET /events` (SSE or WebSocket) | — |

`loom plan "<goal>"`, the one-shot task generator, is removed.

## 8. Build order

**The rule:** the tool is finished and proven before the UI. The one exception is B3: chatting with the lead is the riskiest piece, so it is checked from the existing mock dashboard as soon as it works, using a thin test page and no design work.

Every step ends with an end-to-end test that runs the real CLI, real `claude` and real git (no mocks of Loom itself), and writes its result to `docs/proofs/LEDGER.md`. A step is done when its proof passes. The next step starts after that.

**B0. Base.**
- Merge the open landing fixes:
  - allow agents to run the plan's test, compile, npm, npx and node commands;
  - detect the usage limit and mark the agent "paused: usage limit" instead of failed.
- Update the stale `docs/plans/README.md` status table.
- *Proof:* the existing suites pass.

**B1. Init in all states** (§3.1).
- *Proof:* three repos, one per state (A no commits, B plain, C a clone of B after B ran a team). Each shows the expected summary. A second init changes nothing. State C's session count equals B's.

**B2. Languages** (§6).
- *Proof:*
  - A TS repo: per-function locks are seen. An agent's type break in another file is rejected at landing; an existing base error does not block.
  - A Go repo: whole-file locks, and `go vet` new-errors-only.
  - The Python STALE-bench repo is unchanged.

**B3. The lead** (§3.2, §3.3): channel, mirror, permission relay, token, degraded mode, first briefing, plan finding, `.loom/plans/`, the checker, and `turn`/`tool`/`plan` events.
- *Proof:*
  1. Messages typed in the terminal appear in `GET /events`.
  2. A message POSTed while the lead is busy is delivered after the current turn.
  3. A permission prompt is answered from the route.
  4. The one-liner "Hyperledger Fabric network for multiple clients" produces a plan file. The checker refuses an incomplete version of it and accepts the complete one.
  5. Items 1–3 are repeated from a thin page in the mock dashboard.

**B4. Team from the lead** (§3.4): `start_team` and the other tools, agents with open stdin, `team`/`collision` events (`lock_wait`, `lock_denied`, `caller_warning`, `landing_rejected`), and agent session files linked to the lead.
- *Proof:*
  - a 1-agent plan, a 2-agent plan and a 3-agent plan, each started by the lead;
  - a message reaches a running agent;
  - a collision record exists for every denial in the trace;
  - a fresh clone sees lead → agents → versions.
  - The STALE-bench result is re-run on this build (both arms, all 6 tasks, counted per the PREREG).

**B5. Collaborators** (§3.6, §4.3): sync, `stale_version`, `divergence`, `merge_conflict` records, deterministic collision ids, person inheritance.
- *Proof:*
  - Two clones under two git identities. Each runs a lead with a team on overlapping functions, then they push and pull in turn.
  - Every expected collision is present exactly once on both machines.
  - Each briefing names the other person's work and decisions.
  - `/people` and `/collab` return both people, their agents and their shared regions.

**B6. Data routes** (§5, §7).
- *Proof:* one contract test per route over the B5 repos, asserting the shape and real values; the event stream replays a full B4 team in order.

**B7. The UI** on B6.
- Screens:
  - Home: what Loom does, how it works, "Start a lead" / "Start a team", the briefing, what's live;
  - Lead chat;
  - Plan;
  - Team live;
  - Sessions;
  - People and collaboration graph;
  - Collisions;
  - Function story;
  - Map growth;
  - Bench.
- It's built from the v4/v5 mock's look, wired to real routes. The mock's scripted scenes are removed.
- *Proof:* each screen is shown with the B5 data and checked in the built-in browser.

## 9. Out of scope (this event)

- Real-time sync between machines.
- A hosted service.
- Function-level regions for Go, Rust and Java.
- Ruby and PHP.
- Merging plans automatically across people.
- Resuming a team after the machine restarts. Agents that stopped can be restarted one by one; a whole team cannot be resumed.

## 10. Calls I made (check these)

1. **Lead chat uses Claude Code Channels** behind the preview flag. If Channels are disabled for the account (Team/Enterprise orgs need an Owner toggle), the dashboard is read-only for that session.
2. **`turn.text` is capped at 4 000 chars and redacted**, and full transcripts stay in Claude Code's own folder, not in git. That keeps `.loom/` small and keeps secrets out of the repo.
3. **Each agent is its own session file**, linked to the lead by `parent`, rather than sharing the lead's session id.
4. **Plans live in `.loom/plans/`** and link to the user's documents wherever those are.
5. **Go, Rust and Java get whole-file locks** plus compiler checks, not function-level locks, this event.
6. **`loom plan "<goal>"` is removed**; the lead writes plans.
7. **Collisions are written by whoever detects them**, with deterministic ids so duplicates collapse.

## 11. Decisions from the builder review (my calls; check these too)

1. **When an agent is done.**
   - An agent finishes a task by calling `claim_done` (an existing tool), or by ending its turn with a `result`. Either one queues it for landing.
   - Stdin stays open until it lands. If landing rejects the work, the reason goes back on stdin and the agent continues.
   - Once it lands, stdin closes and the process exits. After that, `message_agent` to that agent returns "landed".
   - The plan's `done:` text is instructions for the agent. Loom does not check it. Loom's gates are merge, callers, tests and compile.
2. **`owns` is soft.**
   - Editing outside `owns` is allowed. Loom records a `collision` of kind `out_of_scope` and warns the agent and the lead.
   - Per-function locks stay the hard rule. The checker uses `owns` for its overlap and ordering checks.
3. **Who writes and commits records.**
   - **Each team has its own session id.** The daemon writes team events and the collisions it detects to `.loom/sessions/<teamSid>.coord.jsonl`. `coord` is the writer the v2 spec already names. A team started without a lead still has a coord file. Its `parent` is the lead's sid when there is one.
   - **Agent files** are committed with the agent's work. Agents that are rejected or stopped and never land have their file copied into one final "team record" commit on `loom/<team>/landed`, together with the coord file. No record is lost.
   - **Lead and plain-session files** are staged by the pre-commit hook on every commit the user makes. At SessionEnd, if the file has uncommitted lines, `loom finish` offers to commit it.
4. **`loom run` stays, as a thin client of `POST /teams`.**
   - The STALE-bench tasks become team plans (`bench/plans/*.md`), and the planner package's one-shot `llmPlan` is deleted.
   - A PREREG addendum, written before the B4 re-run, records the procedure change, as was done for earlier fixes.
5. **Deadline: 2026-10-18 23:59 IST.** If time runs short, cut from the end in this order:
   1. the Map growth view;
   2. Go, Rust and Java compiler checks;
   3. the Function story view;
   4. permission relay (the terminal still answers).
   
   Never cut: init in every state, the lead chat from the dashboard, the plan rule, teams from the lead, agent session files, collisions, two-person sync, the bench re-run.
6. **Starting branch.**
   - The landing fixes don't exist yet; B0 writes them.
   - Each step gets its own branch and PR, stacked on `feat/v2` (PR #21). The user merges; nothing is pushed to `main` directly.
7. **B3 starts with a spike.**
   - Prove channel input, queuing and permission relay on Claude Code 2.1.301 before building anything on them.
   - If permission relay fails, the dashboard shows the pending prompt read-only and the terminal answers it (cut item 4 above). If channel input itself fails, stop and bring it to the user before going further.
8. **Scaffold and branches.**
   - `start_team` requires the scaffold to be committed on `base`.
   - The checker's empty-repo test reads the `base` ref, not the working tree.
   - Agents' worktrees branch from `base`. Landed work collects on `loom/<team>/landed`, which starts at `base`. The user's branch is normally `base`.
9. **Sessions are keyed by Claude's `session_id`, not by worktree.**
   - The lead and any number of plain sessions in one checkout each hold their own locks and lock against each other, exactly like agents.
   - `session.ts`'s one-active-session-per-worktree file becomes one file per session.
10. **One daemon per machine, serving many repos.**
    - Routes in §7 are prefixed `/repos/:repoId/…`.
    - The token is per machine, in `~/.loom/token`. The daemon serves the dashboard and injects the token into the page it serves, so other localhost pages can't call the API.
    - The dashboard opens on the repo it was launched for, and has a repo switcher.
