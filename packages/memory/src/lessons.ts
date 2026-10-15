import type { LoomGraph } from '@loom/core';
import { appendEvent } from './events.js';
import { ulid } from './ids.js';
import type { ActiveSession } from './session.js';

/** §6.10: the lesson lives in this repo's graph and in this repo's .loom/ — never in a shared graph (C1). */
export async function addLesson(g: LoomGraph, root: string, act: ActiveSession | null, region: string, text: string, source: 'manual' | 'mined') {
  const e = appendEvent(root, act?.sid ?? ulid(), act?.writer ?? 'main', { type: 'lesson', text, regions: [region], source });
  await g.query(`MERGE (l:Lesson {id: $id}) SET l.text = $text, l.source = $source, l.at = $at
    MERGE (r:Region {id: $region}) ON CREATE SET r.stub = true MERGE (l)-[:ON]->(r)`, { id: e.id, text, source, at: e.at, region });
  return e.id;
}

export function lessonsFor(g: LoomGraph, regions: string[], limit = 3) {
  if (!regions.length) return Promise.resolve([]);
  return g.query<{ id: string; text: string; region: string }>(`MATCH (l:Lesson)-[:ON]->(r:Region) WHERE r.id IN $regions
    RETURN l.id AS id, l.text AS text, r.id AS region ORDER BY l.at DESC LIMIT ${Math.max(1, Math.floor(limit))}`, { regions });
}
