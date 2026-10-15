import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ensureLoomDir } from '../src/config.js';
import { appendEvent, fileSession, parseEvents, sessionFile } from '../src/events.js';
import { ulid } from '../src/ids.js';
import { repo, sh } from './helpers.js';

const CFG = { repoId: 'r', dirs: ['.'], excludes: [], testCmd: null, share: true };

test('appendEvent writes one {v,type,id,at} line to <sid>.<writer>.jsonl', () => {
  const r = repo({ 'a.py': 'x = 1\n' }); ensureLoomDir(r, CFG);
  const sid = ulid();
  const e = appendEvent(r, sid, 'main', { type: 'decision', text: 'keyword-only', regions: ['a.py::x::definition#0'] });
  const line = readFileSync(join(r, sessionFile(r, sid, 'main')), 'utf8').trim();
  expect(JSON.parse(line)).toEqual(e);
  expect(e).toMatchObject({ v: 1, type: 'decision', id: expect.stringMatching(/^[0-9A-Z]{26}$/), at: expect.any(Number) });
  expect(fileSession(sessionFile(r, sid, 'agent-a'))).toEqual({ sid, writer: 'agent-a' });
});

test('parseEvents tolerates union-merge leftovers: duplicate ids, a cut line, blank lines, unknown types', () => {
  const ok = { v: 1, type: 'lesson', id: 'L1', at: 1, text: 't', regions: [], source: 'manual' };
  const { events, warnings } = parseEvents([JSON.stringify(ok), '', JSON.stringify(ok), '{"v":1,"type":"vers',
    JSON.stringify({ v: 1, type: 'bogus', id: 'B', at: 1 }), JSON.stringify({ v: 2, type: 'lesson', id: 'F', at: 1 })]);
  expect(events.map((e) => e.id)).toEqual(['L1']);
  expect(warnings).toHaveLength(3);
});

test('two writers on two branches merge without conflict; one file on two branches unions', () => {
  const r = repo({ 'a.py': 'x = 1\n' }); ensureLoomDir(r, CFG);
  sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'loom');
  const sid = ulid();
  sh(r, 'checkout', '-qb', 'b1'); appendEvent(r, sid, 'agent-a', { type: 'message', kind: 'notice', text: '1' });
  appendEvent(r, sid, 'main', { type: 'message', kind: 'notice', text: 'm1' }); sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'b1');
  sh(r, 'checkout', '-q', 'main'); sh(r, 'checkout', '-qb', 'b2'); appendEvent(r, sid, 'agent-b', { type: 'message', kind: 'notice', text: '2' });
  appendEvent(r, sid, 'main', { type: 'message', kind: 'notice', text: 'm2' }); sh(r, 'add', '-A'); sh(r, 'commit', '-qm', 'b2');
  sh(r, 'merge', '-q', '-m', 'm', 'b1');                                              // throws on conflict
  const main = readFileSync(join(r, sessionFile(r, sid, 'main')), 'utf8').trim().split('\n');
  expect(parseEvents(main).events.map((e) => e.text).sort()).toEqual(['m1', 'm2']);
});
