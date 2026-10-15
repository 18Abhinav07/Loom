"""Rewrite the README's bench block from bench/results/*.json; a result not on disk says so instead of a number.
usage (from bench/): .venv/bin/python readme.py   — regen.sh runs it last."""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
README = os.path.join(HERE, '..', 'README.md')
res = lambda n: (lambda p: json.load(open(p)) if os.path.exists(p) else None)(os.path.join(HERE, 'results', f'{n}.json'))
MISSING = '_not run yet — `bench/regen.sh`_'


def table(head, rows):
    return '\n'.join(['| ' + ' | '.join(head) + ' |', '|' + '---|' * len(head)] + ['| ' + ' | '.join(map(str, r)) + ' |' for r in rows])


def block():
    out = []
    e1 = res('e1')
    conds = {c: v for c, v in (e1 or {}).get('conds', {}).items()}
    size = f"{max(v['n'] for v in conds.values())} pairs × {len(conds)} conditions" if conds else 'core set'
    out.append(f'**E1 — STALE-bench Django, {size}** (agent B\'s patch merged with A\'s; interference = passes alone, fails merged)\n')
    if e1:
        out.append(table(['condition', 'n', 'B solo pass', 'merged pass', 'interference', 'rate', 'Δ vs blind', 'mean B s'],
                         [[c, v['n'], v['solo_pass'], v['merged_pass'], v['interference'], f"{v['interference_rate']:.0%}",
                           '—' if v.get('delta_vs_blind') is None else f"{v['delta_vs_blind']:+.0%}", v['mean_b_seconds']]
                          for c, v in e1['conds'].items()]))
        if e1.get('excluded'): out.append(f"\n{e1['excluded']} records excluded (B's run itself errored).")
    else: out.append(MISSING)
    e3 = res('e3')
    out.append('\n**E3 — notice precision (live condition)**: a notice is precise when it names the helper the pair conflicts on and the blind twin interfered.\n')
    out.append(table(['delivered', 'precise', 'precision', 'notices / agent-hour', 'excluded (no blind twin)'],
                     [[e3['delivered'], e3['precise'], f"{e3['precision']:.0%}" if e3['precision'] is not None else '—',
                       e3['notices_per_agent_hour'], e3['no_twin']]]) if e3 else MISSING)
    e2, ctl = res('e2'), res('e2-control')
    out.append('\n**E2 — lease race** (50 agents × 200 lease attempts on 20 symbols, one connection each; the control empties the CAS conflict matrix)\n')
    rows = [[n, r['attempts'], r['granted'], r['double_grants'], r['graph_violations'], r['throughput_per_s'], r['p50_ms'], r['p99_ms']]
            for n, r in (('Loom CAS lease', e2), ('control: no conflict check', ctl)) if r]
    out.append(table(['', 'attempts', 'granted', 'double grants', 'graph violations', 'ops/s', 'p50 ms', 'p99 ms'], rows) if rows else MISSING)
    h, ix = res('e4-hooks'), res('e4-indexer')
    out.append('\n**E4 — latency an agent feels**\n')
    rows = [[f'hook {k}', v['total']['p50'], v['total']['p95'], v['daemon']['p50'], v['daemon']['p95']] for k, v in (h or {}).get('events', {}).items()]
    out.append(table(['path', 'end-to-end p50 ms', 'p95', 'daemon p50 ms', 'p95'], rows) if rows else MISSING)
    if ix:
        out.append(f"\nRe-index on edit over all of django ({ix['graph_symbols']} symbols, base index {ix['base_index_s']} s): "
                   f"p50 {ix['onEdit']['p50']} ms, p95 {ix['onEdit']['p95']} ms over {ix['onEdit']['n']} edits.")
    return '\n'.join(out)


s = open(README).read()
s = re.sub(r'(<!-- bench:start -->).*?(<!-- bench:end -->)', lambda m: f'{m.group(1)}\n{block()}\n{m.group(2)}', s, flags=re.S)
open(README, 'w').write(s)
print('README bench block rewritten')
