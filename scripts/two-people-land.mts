// Helper for scripts/two-people.sh: write one person's session records (what their agent's hooks would write) or drop a graph.
//   tsx scripts/two-people-land.mts land <repo> <email> <region>      writes session + agent + version; prints nothing
//   tsx scripts/two-people-land.mts drop <tenant> <repoId>
import { LoomDb } from '../packages/core/src/index.js';
import { appendEvent, graphName, ulid } from '../packages/memory/src/index.js';

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'land') {
  const sid = ulid();
  appendEvent(a, sid, 'main', { type: 'session', person: b, kind: 'interactive', base: '', upstream: 'origin/main' });
  appendEvent(a, sid, 'main', { type: 'agent', name: 'main', model: 'm' });
  appendEvent(a, sid, 'main', { type: 'version', region: c, hash: b, sig: 'slugify(v)', deleted: false, degraded: false, prev: [], by: 'main', task: null });
} else if (cmd === 'drop') {
  const db = await LoomDb.connect();
  await db.graph(graphName(a, b)).drop().catch(() => {});
  await db.close();
}
