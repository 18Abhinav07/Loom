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
