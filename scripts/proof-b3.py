#!/usr/bin/env python3
"""B3 proof: real `claude` as the Loom lead, driven in a pty, checked through the daemon's API.

  python3 scripts/proof-b3.py <workdir> [--model haiku] [--hold]

Needs a Loom daemon on LOOM_URL (default http://127.0.0.1:4318) running this checkout, and a subscription login.
Every CLAUDE*/ANTHROPIC_* variable is removed from the lead's env, as in a user's own terminal.
Makes <workdir>/repo (git init -b main, one Python file, `loom init --no-lead`), starts `loom lead` in a pty and proves:
  1. a typed terminal message is mirrored as turn from:user, with a turn from:claude reply;
  2. a dashboard message sent while the lead is busy is held, then delivered after Stop as its own turn (from:dashboard) and answered;
  3. a Bash permission is answered via POST /sessions/:sid/permissions/:rid and the command's file exists;
  4. "draft from my one-liner" makes .loom/plans/<slug>.md that `loom plan check` passes, and without `test:` it refuses.
With --hold the lead stays up after item 4 until <workdir>/stop exists (for the browser check of /lead).
Writes <workdir>/events.jsonl (every /events record), <workdir>/screen.log (raw pty) and prints one line per check.
"""
import json, os, pty, re, select, signal, subprocess, sys, threading, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, 'packages', 'cli', 'dist', 'loom.cjs')
URL = os.environ.get('LOOM_URL', 'http://127.0.0.1:4318')
HOME = os.environ.get('LOOM_HOME', os.path.expanduser('~/.loom'))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
WORK = os.path.abspath(args[0]); REPO = os.path.join(WORK, 'repo')
MODEL = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'haiku'
HOLD = '--hold' in sys.argv
TOKEN = open(os.path.join(HOME, 'token')).read().strip()
ENV = {k: v for k, v in os.environ.items() if not k.startswith(('CLAUDE', 'ANTHROPIC_'))}
results = []

def check(name, ok, detail=''):
    results.append((name, ok)); print(f"{'PASS' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}", flush=True)

def api(method, path, body=None):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'x-loom-token': TOKEN, 'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as r: return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'null')

# ---- the event stream, recorded in full
events = []; elog = None
def follow():
    req = urllib.request.Request(URL + '/events?since=0', headers={'x-loom-token': TOKEN})
    with urllib.request.urlopen(req) as r:
        for line in r:
            line = line.decode().strip()
            if line.startswith('data: '):
                e = json.loads(line[6:]); events.append(e); elog.write(json.dumps(e) + '\n'); elog.flush()

def until(f, secs, poll=0.5):
    t = time.time()
    while time.time() - t < secs:
        v = f()
        if v: return v
        pump(poll)
    return f()

# ---- the pty
fd = None; screen = b''; slog = None; answered = set()
def clean(b): return re.sub(r'\s+', ' ', re.sub(rb'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07', b' ', b).decode('utf8', 'replace'))
def pump(secs):
    global screen
    t = time.time()
    while time.time() - t < secs:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: return
            screen += d; slog.write(d); slog.flush()
            tail = clean(screen[-6000:])
            # launch prompts. Trust defaults to "No, exit": move down to "Yes, I trust this folder". The channel warning takes the default.
            for key, pat, keys in (('trust', 'Yes, I trust this folder', b'\x1b[B'), ('channels', 'Loading development channels', b'')):   # no MCP prompt: loom init pre-approves the server
                if key not in answered and pat in tail:
                    answered.add(key); time.sleep(0.8)
                    if keys: os.write(fd, keys); time.sleep(0.4)
                    os.write(fd, b'\r')
def type_(text):
    for ch in text: os.write(fd, ch.encode()); time.sleep(0.01)
    time.sleep(0.4); os.write(fd, b'\r')

def turns(sid=None, frm=None):
    return [e for e in events if e.get('kind') == 'turn' and (sid is None or e['sid'] == sid) and (frm is None or e['data']['from'] == frm)]
def lead_row():
    s, rows = api('GET', '/sessions')
    return next((r for r in rows or [] if r['repo'] == REPO and r['writer'] == 'lead' and r['channel']), None) if s == 200 else None
def idle(sid): return until(lambda: not next((r for r in api('GET', '/sessions')[1] if r['sid'] == sid), {'busy': True})['busy'], 120)

def main():
    global fd, elog, slog
    os.makedirs(REPO, exist_ok=True)
    elog = open(os.path.join(WORK, 'events.jsonl'), 'w'); slog = open(os.path.join(WORK, 'screen.log'), 'wb')
    sh = lambda *c: subprocess.run(c, cwd=REPO, env=ENV, check=True, capture_output=True, text=True).stdout
    sh('git', 'init', '-qb', 'main'); sh('git', 'config', 'user.email', 'proof@loom.test'); sh('git', 'config', 'user.name', 'proof')
    os.makedirs(os.path.join(REPO, 'app'), exist_ok=True)
    open(os.path.join(REPO, 'app', 'core.py'), 'w').write('def add(a, b):\n    return a + b\n')
    sh('git', 'add', '-A'); sh('git', 'commit', '-qm', 'base')
    print(sh('node', CLI, 'init', '--no-lead').strip().splitlines()[-1], flush=True)
    threading.Thread(target=follow, daemon=True).start()

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(REPO); os.execvpe('node', ['node', CLI, 'lead', '--model', MODEL, '--permission-mode', 'default'], ENV)
    import fcntl, termios, struct
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
    try:
        row = until(lead_row, 90)
        check('the lead session is live with a channel', bool(row), row and f"sid {row['sid']}")
        if not row: return
        sid = row['sid']
        pump(3)

        # 1. terminal → mirror
        type_('Reply with exactly the word MANGO and nothing else.')
        u = until(lambda: [t for t in turns(sid, 'user') if 'MANGO' in t['data']['text']], 60)
        c = until(lambda: [t for t in turns(sid, 'claude') if 'MANGO' in t['data']['text']], 90)
        check('1. terminal message mirrored as turn from:user', bool(u), u and repr(u[0]['data']['text']))
        check('1. reply mirrored as turn from:claude', bool(c), c and repr(c[0]['data']['text']))
        idle(sid)

        # 2 + 3. dashboard message that needs Bash; a second message while busy is held; the permission is answered over HTTP
        s1 = api('POST', f'/sessions/{sid}/messages', {'text': 'Use the Bash tool to run exactly: touch made-by-bash.txt && sleep 5 — then reply with the word FIRST.'})
        check('2. idle session: dashboard message sent', s1 == (200, {'status': 'sent'}), str(s1))
        until(lambda: next((r for r in api('GET', '/sessions')[1] if r['sid'] == sid), {}).get('busy'), 10)
        s2 = api('POST', f'/sessions/{sid}/messages', {'text': 'Reply with exactly the word SECOND and nothing else.'})
        check('2. busy session: second message held', s2 == (200, {'status': 'held'}), str(s2))
        perm = until(lambda: next((e for e in events if e.get('kind') == 'permission' and e['sid'] == sid and 'tool' in e['data']), None), 90)
        check('3. Bash permission request reached /events', bool(perm), perm and json.dumps(perm['data'])[:160])
        if perm:
            a = api('POST', f"/sessions/{sid}/permissions/{perm['data']['rid']}", {'behavior': 'allow'})
            check('3. permission answered over HTTP', a[0] == 200, str(a))
            check('3. a second answer is refused', api('POST', f"/sessions/{sid}/permissions/{perm['data']['rid']}", {'behavior': 'deny'})[0] == 409)
        f = until(lambda: os.path.exists(os.path.join(REPO, 'made-by-bash.txt')), 60)
        check('3. the allowed command ran: made-by-bash.txt exists', bool(f))
        first = until(lambda: [t for t in turns(sid, 'claude') if 'FIRST' in t['data']['text']], 90)
        check('2. first message answered', bool(first), first and repr(first[0]['data']['text'][-80:]))
        held_turn = until(lambda: [t for t in turns(sid, 'dashboard') if 'SECOND' in t['data']['text']], 60)   # channel turns are mirrored from:dashboard
        second = until(lambda: [t for t in turns(sid, 'claude') if 'SECOND' in t['data']['text']], 90)
        after_stop = held_turn and any(e['seq'] < held_turn[0]['seq'] for e in turns(sid, 'claude') if 'FIRST' in e['data']['text'])
        check('2. held message delivered after Stop as its own turn', bool(held_turn) and after_stop, held_turn and f"seq {held_turn[0]['seq']} {held_turn[0]['data']['text']!r}")
        check('2. held message answered', bool(second), second and repr(second[0]['data']['text']))
        idle(sid)

        # 4. a plan from a one-liner; every permission the lead asks for is allowed from the "dashboard"
        type_('Hyperledger Fabric network for multiple clients — draft from my one-liner. Write the plan file now without asking me anything.')
        plans = os.path.join(REPO, '.loom', 'plans')
        def plan_done():
            for e in events:
                if e.get('kind') == 'permission' and e['sid'] == sid and 'tool' in e['data'] and e['data']['rid'] not in answered:
                    answered.add(e['data']['rid']); api('POST', f"/sessions/{sid}/permissions/{e['data']['rid']}", {'behavior': 'allow'})
            busy = next((r for r in api('GET', '/sessions')[1] if r['sid'] == sid), {}).get('busy', True)
            files = [x for x in os.listdir(plans) if x.endswith('.md')] if os.path.isdir(plans) else []
            return files if files and not busy else None
        files = until(plan_done, 400, poll=1)
        if not files:   # the lead asked something: answer once
            type_('Yes. Write it to .loom/plans/ now and run check_plan.'); files = until(plan_done, 400, poll=1)
        check('4. the lead wrote .loom/plans/<slug>.md', bool(files), str(files))
        if files:
            slug = files[0][:-3]; path = os.path.join(plans, files[0])
            used = [e for e in events if e.get('kind') == 'tool' and e['sid'] == sid and 'check_plan' in e['data']['name']]
            check('4. the lead ran the check_plan tool', bool(used), used and json.dumps(used[-1]['data']))
            r = subprocess.run(['node', CLI, 'plan', 'check', slug], cwd=REPO, env=ENV, capture_output=True, text=True)
            print(r.stdout.strip()); check('4. loom plan check passes', r.returncode == 0, f'exit {r.returncode}')
            text = open(path).read(); kept = text
            open(path, 'w').write(re.sub(r'(?m)^test:.*\n', '', text, count=1))
            r = subprocess.run(['node', CLI, 'plan', 'check', slug], cwd=REPO, env=ENV, capture_output=True, text=True)
            print(r.stdout.strip() + r.stderr.strip())
            check('4. without test: the check refuses with "test is missing"', r.returncode != 0 and 'test is missing' in r.stdout + r.stderr, f'exit {r.returncode}')
            open(path, 'w').write(kept)

        if HOLD:
            print(f'READY: lead {sid} is up; open http://127.0.0.1:4327/lead — touch {WORK}/stop to end', flush=True)
            until(lambda: os.path.exists(os.path.join(WORK, 'stop')), 3600, poll=1)
    finally:
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
        pump(2)
        n = sum(ok for _, ok in results)
        print(f'{n}/{len(results)} checks passed', flush=True)

main()
sys.exit(0 if results and all(ok for _, ok in results) else 1)
