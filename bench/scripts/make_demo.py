"""Build demo/run-1 from the recorded loom-demo pair run: events.jsonl, meta.json, and the pinned django/ tree.

Recordings made before the daemon stored edit diffs carry no patch for Bash edits; this adds one per agent,
taken from what that agent finally landed, on its first Bash event that changed a file under django/.
usage: bench/.venv/bin/python bench/scripts/make_demo.py [~/.loom/runs/loom-mv7y0ybo] [~/Documents/loom-demo]
"""
import json, os, subprocess, sys

src = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/.loom/runs/loom-mv7y0ybo')
repo = os.path.expanduser(sys.argv[2] if len(sys.argv) > 2 else '~/Documents/loom-demo')
out = os.path.join(os.path.dirname(__file__), '..', '..', 'demo', 'run-1')
os.makedirs(out, exist_ok=True)
git = lambda *a: subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True, check=True).stdout
events = [json.loads(l) for l in open(os.path.join(src, 'events.jsonl'))]
adm = next(e['body'] for e in events if e['route'] == '/admin/runs')
base = adm['baseKey'].split('@')[1]
landed = {e['body']['agent']: e['body']['sha'] for e in events if e['route'] == '/admin/landed'}
done = set()
for e in events:
    b = e['body']; i = b.get('input') or {}
    if e['route'] != '/hook/claude/PostToolUse' or i.get('tool_name') != 'Bash' or b['agent'] in done or 'patch' in b:
        continue
    sha = landed.get(b['agent'])
    if not sha: continue
    files = [f for f in git('diff', '--name-only', base, sha, '--', 'django').split() if f.endswith('.py')]
    if not any(f.split('/')[-1] in i['tool_input']['command'] or f in i['tool_input']['command'] for f in files): continue
    b['patchFiles'] = files; b['patch'] = git('diff', base, sha, '--', *files); done.add(b['agent'])
with open(os.path.join(out, 'events.jsonl'), 'w') as f:
    for e in events: f.write(json.dumps(e) + '\n')
json.dump({'commit': base, 'dirs': adm['dirs'], 'root': adm['root'], 'source': os.path.basename(src), 'bashPatches': sorted(done)},
          open(os.path.join(out, 'meta.json'), 'w'), indent=1)
subprocess.run(f"git -C {repo} archive --format=tar {base} django | gzip -9 > {os.path.join(out, 'repo.tar.gz')}", shell=True, check=True)
print('wrote', os.path.abspath(out), 'bash patches for', sorted(done))
