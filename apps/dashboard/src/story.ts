// Story screen view model: bench/results/e1-story.json → scoreboard tiles and the words of one pair's two lanes.
export interface Lane { broke: boolean; seconds: number; error?: string; passed?: string; a_changed_s?: number | null; told_s?: number | null; notice?: string }
export interface Pair { id: string; func: string; mech: string; change: string; blind: Lane | null; live: Lane | null }
export interface StoryData { pairs: Pair[]; model: string | null; records: string }
export interface Tile { id: string; func: string; state: 'broke' | 'ok' | 'none' }
export interface Step { text: string; tone: 'plain' | 'loom' | 'bad' | 'good' }

const tile = (p: Pair, l: Lane | null): Tile => ({ id: p.id, func: p.func, state: !l ? 'none' : l.broke ? 'broke' : 'ok' });

export function scoreboard(s: StoryData) {
  const blind = s.pairs.map((p) => tile(p, p.blind)); const live = s.pairs.map((p) => tile(p, p.live));
  const count = (ts: Tile[], st: Tile['state']) => ts.filter((t) => t.state === st).length;
  return { blind, live, blindBroke: count(blind, 'broke'), blindN: blind.length - count(blind, 'none'),
    liveBroke: count(live, 'broke'), liveN: live.length - count(live, 'none') };
}

const at = (s: number | null | undefined) => (s == null ? '' : ` (t+${s} s)`);
const outcome = (l: Lane): Step => (l.broke ? { text: `Breaks: ${l.error || 'tests fail after the merge'}`, tone: 'bad' }
  : { text: `Works: ${l.passed?.match(/Ran (\d+) tests?/) ? `all ${l.passed.match(/\d+/)![0]} tests pass` : 'tests pass'}`, tone: 'good' });

/** The four steps of one lane; [] when that lane never ran. */
export function steps(p: Pair, side: 'blind' | 'live'): Step[] {
  const l = p[side];
  if (!l) return [];
  if (side === 'blind') return [
    { text: `Agent A changes ${p.func} — ${p.change}`, tone: 'plain' },
    { text: 'Agent B writes its feature. Nobody tells it.', tone: 'plain' },
    { text: 'Both branches merge.', tone: 'plain' }, outcome(l)];
  return [
    { text: `Agent A changes ${p.func} — ${p.change}${at(l.a_changed_s)}`, tone: 'plain' },
    l.told_s == null ? { text: 'Loom did not reach B before it finished.', tone: 'plain' }
      : { text: `Loom tells B${at(l.told_s)}: ${l.notice ?? ''}`.trimEnd(), tone: 'loom' },
    { text: l.broke ? 'Both branches merge.' : 'B adapts its code; both branches merge.', tone: 'plain' }, outcome(l)];
}
