# B3 spike: Claude Code channels (2.1.301)

Run on 2026-10-16 against `claude` 2.1.301 (`claude --version`), model haiku, subscription login, every `CLAUDE*`/`ANTHROPIC_*` variable unset (`cleanenv.sh`).
Launch: `claude --model haiku --permission-mode default --dangerously-load-development-channels server:loom`, in a pty, in a scratch git repo whose `.mcp.json` starts a minimal channel server (`chan.cjs`, MCP SDK, capabilities `experimental['claude/channel']` and `experimental['claude/channel/permission']`).
`$SPIKE` is the scratchpad spike directory.

## 1. Channel input works

The server sent `notifications/claude/channel {content: "Reply with exactly the word PINEAPPLE", meta: {from: "dashboard"}}`. The `UserPromptSubmit` and `Stop` hooks logged (fields trimmed to the ones that matter):

```
UserPromptSubmit prompt = "<channel source=\"loom\" from=\"dashboard\">\nReply with exactly the word PINEAPPLE\n</channel>"
Stop last_assistant_message = "PINEAPPLE"
```

So a channel message is a normal turn: it fires `UserPromptSubmit` (the mirror sees it) and ends with `Stop` (the mirror sees the reply).

## 2. A message sent mid-turn is folded into the running turn

Seen in the first spike run: a push sent while a tool was running was injected at the next tool boundary and the model did not answer it as its own turn. The raw log of that run was overwritten by the permission run and was not kept, so this item rests on the observation, not a log line.
Design consequence: the daemon holds dashboard messages while the session is busy (`UserPromptSubmit` → `Stop`) and releases one per `Stop`. Task 18 proves the held path end to end with real claude.

## 3. The permission relay works

Prompt typed in the terminal: `Use the Bash tool to run exactly: touch made-by-bash.txt`. The server received:

```
{"at":1792164349099,"notif":{"jsonrpc":"2.0","method":"notifications/claude/channel/permission_request","params":{"request_id":"wcwpp","tool_name":"Bash","description":"Create empty file made-by-bash.txt","input_preview":"{ \"command\": \"touch made-by-bash.txt\", \"description\": \"Create empty file made-by-bash.txt\" }"}}}
```

It answered `notifications/claude/channel/permission {request_id: "wcwpp", behavior: "allow"}`:

```
{"at":1792164361284,"sent":"/perm","q":"?id=wcwpp&b=allow"}
```

The tool ran. File check after the turn:

```
-rw-r--r--@ 1 18abhinav07  wheel  0 Oct 16 20:56 repo/made-by-bash.txt
```

The terminal also showed its own "Do you want to proceed?" prompt; nobody pressed a key there. The allow went out at 15:26:01.284Z and the transcript records the Bash `tool_result` at 15:26:01.982Z, so the channel answer settled it. Relay needs `--permission-mode default` (in auto/bypass modes no request is sent).

## 4. The dev-channel confirmation shows on every launch

Each launch printed, before the session started:

```
WARNING: Loading development channels
--dangerously-load-development-channels is for local channel development only. ...
Channels: server:loom
Enter to confirm · Esc to cancel
```

`loom lead` tells the user this before it starts Claude.

## 5. The channel server's parent is the `claude` process

`chan.cjs` logged `{"ready":true,"ppid":38932}`; `ps -o pid=,comm= -p 38932` → `38932 claude`.
So the server can register itself under its `ppid`, and the daemon matches it to the hook whose `x-loom-ppids` chain contains that pid (Task 11 sends the chain).
