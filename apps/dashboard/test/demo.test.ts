import { expect, it } from 'vitest';
import { demoModel } from '../src/Demo';
import { initial, reduce, type LoomEvent } from '../src/stream';

const N = (id: string, file: string) => ({ id, qname: id.split('::')[1], file, kind: 'function' });
const snap = { nodes: [N('p/utils/text.py::slugify', 'p/utils/text.py'), N('p/utils/text.py::capfirst', 'p/utils/text.py'), N('p/utils/html.py::strip', 'p/utils/html.py')], edges: [], agents: [], leases: [], notices: [] };
const ev = (type: string, agent: string | undefined, data: Record<string, unknown> = {}, at = 1): LoomEvent => ({ type, at, run: 'r', agent, data });
const play = (...es: LoomEvent[]) => es.reduce(reduce, { ...initial(), snap });
const SL = 'p/utils/text.py::slugify';

it('an agent that holds a function is shown editing it, with the lock on that row', () => {
  const m = demoModel(play(ev('agent.registered', 'a'), ev('task.claimed', 'a', { task: 'a', title: 'strict slugify' }), ev('lease.granted', 'a', { symbols: [SL], mode: 'write' })));
  expect(m.agents[0]).toMatchObject({ id: 'a', name: 'strict slugify', status: 'editing', note: 'editing slugify()' });
  expect(m.files).toEqual([{ file: 'utils/text.py', rows: [{ name: 'slugify()', holder: 'a', waiter: undefined }] }]);
  expect(m.locked).toBe(1);
});

it('a denied lease makes the asker wait on the holder, shown on the row, and the caption says why', () => {
  const m = demoModel(play(ev('agent.registered', 'a'), ev('agent.registered', 'c'), ev('lease.granted', 'a', { symbols: [SL], mode: 'write' }), ev('lease.denied', 'c', { symbols: [SL], holder: 'a' })));
  expect(m.agents.find((a) => a.id === 'c')).toMatchObject({ status: 'waiting', note: 'waits for a on slugify()' });
  expect(m.files[0].rows[0]).toMatchObject({ holder: 'a', waiter: 'c' });
  expect(m.waiting).toBe(1);
  expect(m.caption).toBe('c needs slugify(), which a holds. c waits its turn instead of colliding.');
});

it('a landed agent is counted once and a notice tells the callers', () => {
  const m = demoModel(play(ev('agent.registered', 'a'), ev('agent.registered', 'b'), ev('notice.created', 'b', { id: 'n', author: 'a', symbol: SL }), ev('change.landed', 'a'), ev('change.landed', 'a'), ev('agent.state', 'a', { state: 'exited' })));
  expect(m.landed).toBe(1);
  expect(m.agents.find((a) => a.id === 'a')?.status).toBe('landed');
  expect(m.agents.find((a) => a.id === 'b')?.note).toBe('told: slugify() changed');
});
