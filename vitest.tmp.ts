// Every test run leaves nothing behind. Temp dirs: tests (and the git, daemon and fake-claude processes they start) create
// them through os.tmpdir(), which reads TMPDIR, so the run gets one temp root and removes it. Graphs: the run uses its own
// FalkorDB keyspace (database 9), emptied before and after, so a real `loom` daemon's graphs in database 0 are never touched.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoomDb } from './packages/core/src/db.js';

const TEST_DB = 'redis://127.0.0.1:6379/9';

async function emptyTestDb() {
  const db = await LoomDb.connect(TEST_DB);
  try { for (const g of await db.list()) await db.graph(g).drop().catch(() => {}); } finally { await db.close(); }
}

export default async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'loom-test-'));
  const prev = { TMPDIR: process.env.TMPDIR, FALKORDB_URL: process.env.FALKORDB_URL };
  process.env.TMPDIR = root;
  process.env.FALKORDB_URL ??= TEST_DB;
  if (process.env.FALKORDB_URL === TEST_DB) await emptyTestDb();
  return async () => {
    if (process.env.FALKORDB_URL === TEST_DB) await emptyTestDb();
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  };
}
