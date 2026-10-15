import type { LoomGraph } from './db.js';

const INDEXES = [
  'CREATE INDEX FOR (n:Symbol) ON (n.id)',
  'CREATE INDEX FOR (n:Symbol) ON (n.file)',
  'CREATE INDEX FOR (n:Agent) ON (n.id)',
  'CREATE INDEX FOR (n:Change) ON (n.id)',
  'CREATE INDEX FOR (n:Notice) ON (n.id)',
  'CREATE INDEX FOR (n:Notice) ON (n.agent)',
  'CREATE INDEX FOR (n:Task) ON (n.id)',
  'CREATE INDEX FOR (n:Decision) ON (n.id)',
  'CREATE INDEX FOR (n:Commit) ON (n.sha)',
  'CREATE FULLTEXT INDEX FOR (n:Symbol) ON (n.name, n.doc)',
];

/** Setup-time only (never at runtime): index creation is not something to race with writers. */
export async function ensureSchema(g: LoomGraph): Promise<void> {
  for (const q of INDEXES) {
    try { await g.query(q); } catch (e) { if (!/already indexed/i.test(String(e))) throw e; }
  }
}

/** Repo graph (`loom:<tenant>:<repoId>`, §4.1). The Symbol list above stays until P3's migration. */
const REPO_INDEXES = ['Region', 'Version', 'Session', 'Agent', 'Person', 'Task', 'Decision', 'Evidence', 'Lesson', 'Message', 'Thread', 'Handoff', 'Imported']
  .map((l) => `CREATE INDEX FOR (n:${l}) ON (n.id)`)
  .concat(['CREATE INDEX FOR (n:Region) ON (n.path)', 'CREATE INDEX FOR (n:Commit) ON (n.sha)', 'CREATE INDEX FOR (n:Watermark) ON (n.person)']);
export async function ensureRepoSchema(g: LoomGraph): Promise<void> {
  for (const q of REPO_INDEXES) {
    try { await g.query(q); } catch (e) { if (!/already indexed/i.test(String(e))) throw e; }
  }
}
