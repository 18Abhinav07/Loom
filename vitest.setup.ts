// Each test file gets its own lessons graph: lessons are global by design, and one file's T1 must not be injected into another's hooks.
import { afterAll } from 'vitest';
import { LoomDb } from './packages/core/src/db.js';

process.env.LOOM_LESSONS_GRAPH = `test:lessons:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
afterAll(async () => {
  const db = await LoomDb.connect();
  try { await db.graph(process.env.LOOM_LESSONS_GRAPH!).drop(); } catch { /* never written */ } finally { await db.close(); }
});
