// Dashboard view models: what the Story and Live screens say, as pure functions over the data they are given.
import { expect, test } from 'vitest';
import { scoreboard, steps, type StoryData } from '../src/story';
import { focusIds, plain } from '../src/plain';

const lane = (broke: boolean, extra = {}) => ({ broke, seconds: 20, ...(broke ? { error: "TypeError: f() missing 'strict'" } : { passed: 'Ran 20 tests' }), ...extra });
const data: StoryData = { model: 'sonnet', records: 'runs/e1/x', pairs: [
  { id: 'f__signature', func: 'f', mech: 'signature', change: 'adds a required `strict` argument', blind: lane(true),
    live: lane(false, { a_changed_s: 8.3, told_s: 12.7, notice: '[loom] agent A changed f' }) },
  { id: 'g__rename', func: 'g', mech: 'rename', change: 'renames it (old name gone)', blind: lane(true), live: null },
  { id: 'h__rettype', func: 'h', mech: 'rettype', change: 'changes what it returns', blind: lane(false), live: lane(false, { a_changed_s: 2, told_s: null }) },
] };

test('6.1 scoreboard counts only pairs that ran; a missing lane is "none", never a pass', () => {
  const s = scoreboard(data);
  expect(s.blind.map((t) => t.state)).toEqual(['broke', 'broke', 'ok']);
  expect(s.live.map((t) => t.state)).toEqual(['ok', 'none', 'ok']);
  expect([s.blindBroke, s.blindN, s.liveBroke, s.liveN]).toEqual([2, 3, 0, 2]);
});

test('6.2 lane steps tell the pair in plain words, from the record only', () => {
  const [p, , h] = data.pairs;
  expect(steps(p, 'blind').map((x) => x.text)).toEqual([
    'Agent A changes f — adds a required `strict` argument', 'Agent B writes its feature. Nobody tells it.', 'Both branches merge.',
    "Breaks: TypeError: f() missing 'strict'"]);
  expect(steps(p, 'live').map((x) => x.text)).toEqual([
    'Agent A changes f — adds a required `strict` argument (t+8.3 s)', 'Loom tells B (t+12.7 s): [loom] agent A changed f',
    'B adapts its code; both branches merge.', 'Works: all 20 tests pass']);
  expect(steps(p, 'blind').at(-1)!.tone).toBe('bad');
  expect(steps(h, 'live')[1].text).toBe('Loom did not reach B before it finished.');
  expect(steps(data.pairs[1], 'live')).toEqual([]);
});

const ev = (type: string, agent: string, data: Record<string, unknown>) => ({ type, at: 1, run: 'r', agent, data });

test('6.3 plain() says coordination in English and drops the agent\'s own steps', () => {
  expect(plain(ev('change.recorded', 'a', { symbol: 'd/t.py::slugify', kind: 'contract', after: 'def slugify(v, *, strict)' })))
    .toBe('a changed slugify — its callers must change too');
  expect(plain(ev('change.recorded', 'b', { symbol: 'd/t.py::title_slug', kind: 'behavior' }))).toBe('b edited title_slug');
  expect(plain(ev('notice.created', 'b', { symbol: 'd/t.py::slugify', author: 'a' }))).toBe('Loom told b: a changed slugify, which b depends on');
  expect(plain(ev('notice.resolved', 'b', { ids: ['n'] }))).toBe('b adapted to the change');
  expect(plain(ev('lease.denied', 'c', { symbols: ['d/t.py::slugify'], holder: 'a' }))).toBe('c was stopped from editing slugify — a is changing it');
  expect(plain(ev('commit.recorded', 'a', { sha: 'abc', message: 'strict slugify' }))).toBe('a committed "strict slugify"');
  expect(plain(ev('step.recorded', 'a', { tool: 'Read' }))).toBeNull();
  expect(plain(ev('lease.granted', 'a', { symbols: ['x'] }))).toBeNull();
});

test('6.4 focusIds = leased, changed and notice-path symbols plus one CALLS hop; nothing hot → whole map', () => {
  const snap = { nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, qname: id, file: '', kind: 'function' })),
    edges: [{ from: 'b', to: 'a' }, { from: 'c', to: 'b' }, { from: 'e', to: 'd' }], agents: [], notices: [],
    leases: [{ agent: 'x', symbol: 'a', mode: 'write', contract: false, expires: 0 }] };
  expect([...focusIds(snap, {}, [])!].sort()).toEqual(['a', 'b']);
  expect([...focusIds(snap, { d: 1 }, [{ kind: 'pulse', ids: ['c'], at: 0 }])!].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(focusIds({ ...snap, leases: [] }, {}, [])).toBeNull();
});
