# B3 proof: the lead, dashboard chat, permission relay, the plan gate

Run on 2026-10-16 with `claude` 2.1.301, model haiku, subscription login, and every `CLAUDE*`/`ANTHROPIC_*` variable removed from the lead's env.
The daemon was this checkout (`LOOM_UI_PORT=4327 loom up`).
Driver: `python3 scripts/proof-b3.py <workdir>`. It runs `git init -b main` with one Python file, then `loom init --no-lead`, then `loom lead --model haiku --permission-mode default` in a pty. All checks go through the daemon's HTTP API and `/events`.
Full event record: [b3-lead-events.jsonl](b3-lead-events.jsonl). The plan the lead wrote: [b3-lead-plan.md](b3-lead-plan.md).

## Result: 16/16

```
PASS the lead session is live with a channel — sid 01M52R7ZXKFNXA9FJQCYMWK0J4
PASS 1. terminal message mirrored as turn from:user — 'Reply with exactly the word MANGO and nothing else.'
PASS 1. reply mirrored as turn from:claude — 'MANGO'
PASS 2. idle session: dashboard message sent — (200, {'status': 'sent'})
PASS 2. busy session: second message held — (200, {'status': 'held'})
PASS 3. Bash permission request reached /events — {"rid": "fdapw", "tool": "Bash", "description": "Create made-by-bash.txt and wait 5 seconds", ...}
PASS 3. permission answered over HTTP — (200, {'ok': True})
PASS 3. a second answer is refused
PASS 3. the allowed command ran: made-by-bash.txt exists
PASS 2. first message answered — 'FIRST'
PASS 2. held message delivered after Stop as its own turn — seq 17 'Reply with exactly the word SECOND and nothing else.'
PASS 2. held message answered — 'SECOND'
PASS 4. the lead wrote .loom/plans/<slug>.md — ['fabric-multi-client-network.md']
PASS 4. the lead ran the check_plan tool — {"name": "mcp__loom__check_plan", "target": null, "ok": true, "ms": 63}
ok: 3 task(s); a team can start from this plan
PASS 4. loom plan check passes — exit 0
problem: test is missing
not ok: 1 problem(s); fix them before a team starts
PASS 4. without test: the check refuses with "test is missing" — exit 1
16/16 checks passed
```

## The event order that proves the held path (items 2 and 3)

```
7  channel     {"sent": "Use the Bash tool to run exactly: touch made-by-bash.txt && sleep 5 — then reply with the word FIRST."}
8  channel     {"held": "Reply with exactly the word SECOND and nothing else.", "queue": 1}
9  turn        {"from": "dashboard", "text": "Use the Bash tool ... FIRST."}
11 permission  {"rid": "fdapw", "tool": "Bash", ...}
12 permission  {"rid": "fdapw", "behavior": "allow"}          ← POST /sessions/:sid/permissions/fdapw
13 tool        {"name": "Bash", "target": "touch made-by-bash.txt && sleep 5", "ok": true, "ms": 5688}
14 turn        {"from": "claude", "text": "FIRST", "tools": {"Bash": 1}}
   (Stop: busy → false)
16 channel     {"sent": "Reply with exactly the word SECOND and nothing else."}
17 turn        {"from": "dashboard", "text": "Reply with exactly the word SECOND and nothing else."}
19 turn        {"from": "claude", "text": "SECOND"}
```

The second message was held while the first turn ran. It went in only after that turn's Stop, as its own turn, and got its own answer.

## Item 4: the plan gate

The lead got the B3 briefing, which requires a plan before any team starts. It was then given the one-liner. It wrote `.loom/plans/fabric-multi-client-network.md` in Loom's format (3 tasks: `network`, then `chaincode` after it, then `client-sdk`) and ran `check_plan` itself.
Its Bash, Write and `check_plan` permission requests were all answered over HTTP, as a dashboard would answer them.
`loom plan check` passes. With the `test:` line removed it refuses with `test is missing` (exit 1). The script then puts the line back.

## Item 5: the thin chat page (built-in browser, the run before)

The page was `http://127.0.0.1:4327/lead`, with the lead held up (`--hold`). It listed the live lead (`lead · proof@loom.test · chat`) with its turns.
A message typed in the page returned `sent`. The Bash permission card appeared, and clicking **Allow** sent the answer. The page then showed the tool line `Bash touch from-page.txt` and the reply `PAGEOK`, and `from-page.txt` existed on disk:

```
39 channel     {"sent": "Use the Bash tool to run exactly: touch from-page.txt — then reply with the word PAGEOK."}
40 turn        {"from": "dashboard", ...}
42 permission  {"rid": "cuewq", "tool": "Bash", "description": "Create from-page.txt in the working directory", ...}
43 permission  {"rid": "cuewq", "behavior": "allow"}
44 tool        {"name": "Bash", "target": "touch from-page.txt", "ok": true, "ms": 38}
45 turn        {"from": "claude", "text": "PAGEOK", "tools": {"Bash": 1}}
```

Screenshot: [b3-lead-page.jpg](b3-lead-page.jpg).

## What the runs found and fixed

- **The MCP prompt defaulted to "Continue without using this MCP server".** Run 2 pressed Enter on that default, and the lead came up with no channel. Fix: `loom init` now pre-approves the server in `.claude/settings.local.json` (`enabledMcpjsonServers: ["loom"]`). init.test asserts this; it went RED, then GREEN. The driver has no MCP-prompt handler, so the 16/16 run proves no prompt appeared.
- **The trust prompt defaults to "No, exit".** This is the driver's concern only (a person picks "Yes"). The driver presses ↓ and then Enter.
- **Run 3 was 15/16 because of a wrong check in the script.** It looked for the held message as `from:user`, but channel turns are mirrored as `from:dashboard` (seq 19 in that run). The check was corrected to `from:dashboard`, plus "after the FIRST reply". Run 4 above is 16/16.
