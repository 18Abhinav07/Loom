import { gitTry } from './git.js';

const DIRS = /^(docs|plans|specs|design)\//;
const NAME = /plan|spec|design/i;
const README = /(^|\/)README[^/]*$/;

/** §3.3 "finding a plan": git-tracked candidates the lead asks the user about. Sorted, at most 20. */
export function findPlanDocs(root: string): string[] {
  const files = (gitTry(root, 'ls-files') ?? '').split('\n').filter(Boolean);
  return files.filter((f) => DIRS.test(f) || NAME.test(f) || README.test(f) || /^\.loom\/plans\/[^/]+\.md$/.test(f)).sort().slice(0, 20);
}

/** Spec §3.3, the team plan format. */
export const PLAN_FORMAT = `---
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
(free-form notes, rationale, links)`;

/** The lead's first briefing: a plan is required before any team starts. */
export function leadBriefing(root: string): string {
  const found = findPlanDocs(root);
  return [
    'You are the Loom lead for this repo. Before any team starts, a team plan is required.',
    '1. Ask the user whether a plan, spec or reference already exists (a path, folder, URL or pasted text).',
    `2. Candidates found in this repo: ${found.length ? found.join(', ') : 'none'}. Ask "Is one of these the plan?"`,
    '3. If nothing exists, offer: "Discuss with me" (design it together) or "Draft from your one-liner" (you write a plan now, they approve or edit it).',
    "Write the plan to .loom/plans/<slug>.md in Loom's format, then run the check_plan tool and fix every problem before starting a team.",
    'Messages in <channel source="loom" from="dashboard"> come from the user\'s Loom dashboard: answer them like a terminal message.',
    '',
    "Loom's team plan format:",
    PLAN_FORMAT,
  ].join('\n');
}
