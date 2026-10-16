# E5 results: blind vs Loom with real agents (pre-registered in PREREG.md)

Loom build 5a6cb6e. Claude Code subscription, headless `claude`, same prompts and repo per arm. Each rep is three agents
(two for f1) working in parallel on Django. Runs: `bench/runs/e5/20261016-115933/` (t1, x1), `20261016-115751/` (f1).

| scenario | cond  | all_pass | broken merged | merge conflicts | wall s (sum) | cost USD | turns |
|----------|-------|----------|---------------|-----------------|--------------|----------|-------|
| t1_slugpath (signature change vs new callers) | blind | 0/3 | 3 | 0 | 104 | 0.59 | 54 |
|          | loom  | **3/3** | 0 | 0 | 203 | 0.97 | 80 |
| x1_textlist (overlapping edits, a dependency) | blind | 0/3 | 0 | 3 | 158 | 1.02 | 122 |
|          | loom  | **3/3** | 0 | 0 | 279 | 1.90 | 176 |
| f1_oldcall (fault injection, not counted) | blind | 0/1 | 1 | 0 | 32 | 0.14 | 14 |
|          | loom  | 1/1 | 0 | 0 | 56 | 0.26 | 17 |

**Counted: Loom 6/6, blind 0/6.** Blind merged semantically broken code in every t1 rep (each agent's work passes alone,
fails merged) and hit a textual conflict in every x1 rep. **f1 pass condition met**: the loom rep ended a landing in
`contract_break` and the landed branch has no call that misfits `slugify`'s merged signature.

## Which mechanism did the work (per agent: landing outcomes in order, from the run's `lands`)
| rep | t1 | x1 |
|-----|----|----|
| r0 | a: contract_break→landed (resumed 1) | a: landed, 2 lease denials · b: tests_failed→landed · c: contract_break→conflict→landed |
| r1 | c: contract_break→contract_break→landed (parked, then resumed 1) | same as r0 |
| r2 | a: contract_break→landed · c: contract_break→landed with **0 resumes** (parked, relanded after a landed) | same as r0 |

- Contract check (call sites vs the merged signature) fired in all 6 counted loom reps and in f1.
- Covering tests at landing caught b in every x1 rep; b fixed and landed.
- Lease denials fired (a: 2 per x1 rep); wake notices delivered (t1: a and b; x1: a 2, c 1).
- Parking (wait for the agent that lands the missing callee) fired with real agents in t1 r1 and r2.

## Bugs real agents found, fixed before these runs (each with a test that failed first)
Earlier runs on the prior build (`20261016-114037`, `20261016-113848`) are discarded per PREREG addendum 2, kept on disk.
They scored loom 2/3 on t1 and 2/3 on x1 (blind 0/3 both), and exposed:
- **04847e3**: t1 loom r2 landed `[*map(slugify, head)]` after `strict` became required; functions passed to
  `map`/`filter`/`key=` were not seen as calls.
- **5a6cb6e**: x1 loom r0, c called `k` before b had landed it and was resumed three times on a checkout with nothing new;
  its work never landed. A worker missing only a not-yet-landed callee now waits for other agents' landings.

An earlier version of this file (x1 only, build 733ca4e) said lease denials did not fire. That was a harness counting bug
(fixed in e916b94); those runs did have denials.

## Costs and limits
- Loom costs ~1.7-1.9× in USD and ~1.8-2× summed wall time: serial landing, test runs, resumes.
- n = 3 per arm per scenario, two counted scenarios, one repo (Django), one model. These show the mechanism works on
  hand-built collision tasks; they do not estimate how often such collisions happen in normal work.
- b's solo check fails in blind x1 by design (it codes against a's not-yet-landed helper); that is a dependency, not breakage.
