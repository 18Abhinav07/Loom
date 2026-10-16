// B3 §3.3: the lead's first briefing asks for a plan and names the candidates it found in the repo.
import { afterAll, expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { findPlanDocs } from '../src/plandocs.js';
import { startSession } from '../src/session.js';
import { closeDb, repo, testGraph } from './helpers.js';

afterAll(closeDb);
const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };

test('findPlanDocs: tracked files under docs/plans/specs/design, plan|spec|design names, README, .loom/plans; sorted', () => {
  expect(findPlanDocs(repo({ 'docs/design.md': '# d\n', 'PLAN.md': '# p\n', 'src/x.py': 'x = 1\n' }))).toEqual(['PLAN.md', 'docs/design.md']);
  const r = repo({ 'README.md': 'r\n', 'specs/api.md': 's\n', 'src/specimen.py': 'x\n', '.loom/plans/split.md': '---\n', 'notes/Design-v2.txt': 'n\n', 'lib/a.py': 'a\n' });
  expect(findPlanDocs(r)).toEqual(['.loom/plans/split.md', 'README.md', 'notes/Design-v2.txt', 'specs/api.md', 'src/specimen.py']);
  const many: Record<string, string> = {}; for (let i = 0; i < 30; i++) many[`docs/n${String(i).padStart(2, '0')}.md`] = 'x\n';
  expect(findPlanDocs(repo(many))).toHaveLength(20);
});

test('the lead briefing requires a plan and lists the candidates; a main session gets no lead section', async () => {
  const r = repo({ 'docs/design.md': '# d\n', 'PLAN.md': '# p\n', 'src/x.py': 'x = 1\n' }); ensureLoomDir(r, CFG);
  const g = await testGraph();
  const lead = await startSession(g, r, { person: 'a@t', kind: 'interactive', claudeSid: 'L', writer: 'lead' });
  expect(lead.briefing).toContain('You are the Loom lead for this repo. Before any team starts, a team plan is required.');
  expect(lead.briefing).toContain('2. Candidates found in this repo: PLAN.md, docs/design.md. Ask "Is one of these the plan?"');
  expect(lead.briefing).toContain('then run the check_plan tool');
  expect(lead.briefing).toContain('owns: [chaincode/asset/**]');   // the plan format from spec §3.3
  const main = await startSession(g, r, { person: 'a@t', kind: 'interactive', claudeSid: 'M' });
  expect(main.briefing).not.toContain('a team plan is required');
  const empty = repo({ 'src/x.py': 'x = 1\n' }); ensureLoomDir(empty, CFG);
  expect((await startSession(g, empty, { person: 'a@t', kind: 'interactive', claudeSid: 'E', writer: 'lead' })).briefing)
    .toContain('2. Candidates found in this repo: none. Ask "Is one of these the plan?"');
});
