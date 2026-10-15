import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { checkInvariants, regionize, shiftMap, type FileRegions } from '../../src/regions/index.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CORPUS = process.env.LOOM_CORPUS ?? join(ROOT, 'bench/cache/django-src/django');
const SKIP = process.env.LOOM_SKIP_CORPUS === '1' || !existsSync(CORPUS);
if (SKIP) console.warn(`[L-1] corpus skipped (${CORPUS})`);

function walk(d: string, out: string[] = []): string[] {
  for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else if (f.endsWith('.py')) out.push(p); }
  return out;
}
/** Seeded PRNG so failures reproduce. */
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

describe.skipIf(SKIP)('L−1 Django corpus', () => {
  let files: Array<{ path: string; text: string }> = [];
  let maps: FileRegions[] = [];
  beforeAll(async () => {
    files = walk(CORPUS).map((p) => ({ path: relative(join(CORPUS, '..'), p), text: readFileSync(p, 'utf8') }));
    maps = [];
    for (const f of files) maps.push(await regionize(f.path, f.text));
  }, 120_000);

  test('882 files: every invariant, 0 degraded, deterministic', async () => {
    expect(files.length).toBe(882);
    expect(maps.filter((m) => m.degraded).map((m) => m.path)).toEqual([]);
    expect(maps.flatMap((m) => checkInvariants(m).map((v) => `${m.path}: ${v}`))).toEqual([]);
    const again = await regionize(files[100].path, files[100].text);
    expect(again.regions).toEqual(maps[100].regions);
    console.log(`[L-1] regions=${maps.reduce((a, m) => a + m.regions.length, 0)}`);
  }, 120_000);

  test('locality: an integer edit inside one definition changes only its hash; no id changes; later offsets shift by delta', async () => {
    let edits = 0;
    const failures: string[] = [];
    for (const m of maps) {
      const defs = m.regions.filter((r) => r.kind === 'definition');
      for (const r of defs) {
        const body = m.text.slice(r!.start, r!.end);
        const firstNl = body.indexOf('\n');
        const hit = /\b([1-9]\d{0,8}|0)\b/.exec(body.slice(firstNl + 1));
        if (firstNl < 0 || !hit) continue;
        const at = r!.start + firstNl + 1 + hit.index;
        const repl = String(Number(hit[1]) + 1);
        const text = m.text.slice(0, at) + repl + m.text.slice(at + hit[1].length);
        const delta = repl.length - hit[1].length;
        const n = await regionize(m.path, text);
        edits++;
        const bad = n.degraded ? 'degraded'
          : n.regions.map((x) => x.id).join() !== m.regions.map((x) => x.id).join() ? 'ids changed'
          : n.regions.some((x, i) => (x.id === r!.id ? x.hash === m.regions[i].hash : x.hash !== m.regions[i].hash)) ? 'hash set wrong'
          : n.regions.some((x, i) => x.start !== m.regions[i].start + (m.regions[i].start > r!.start ? delta : 0)) ? 'offsets wrong' : null;
        if (bad) failures.push(`${r!.id}: ${bad}`);
      }
    }
    console.log(`[L-1] locality edits=${edits} failures=${failures.length}`);
    expect(edits).toBeGreaterThan(1000);
    expect(failures.slice(0, 10)).toEqual([]);
  }, 120_000);

  test('shifted map under seeded syntax breaks: degraded, same ids, exact cover, only the broken region touched', async () => {
    const rand = rng(20261015);
    let broken = 0, notBroken = 0;
    const failures: string[] = [];
    for (const m of maps.filter((x) => x.regions.some((r) => r.kind === 'definition')).slice(0, 300)) {
      const defs = m.regions.filter((r) => r.kind === 'definition');
      const r = defs[Math.floor(rand() * defs.length)];
      const at = r.end - (m.text[r.end - 1] === '\n' ? 1 : 0);
      const text = `${m.text.slice(0, at)}(${m.text.slice(at)}`;
      const n = await regionize(m.path, text, { lastClean: m });
      if (!n.degraded) { notBroken++; continue; }
      broken++;
      const v = checkInvariants(n);
      if (v.length || n.regions.map((x) => x.id).join() !== m.regions.map((x) => x.id).join() || n.touched?.join() !== r.id)
        failures.push(`${r.id}: ${v[0] ?? 'ids/touched'}`);
    }
    console.log(`[L-1] shift broken=${broken} notBroken=${notBroken} failures=${failures.length}`);
    expect(broken).toBeGreaterThan(250);
    expect(failures.slice(0, 10)).toEqual([]);
    expect(shiftMap(maps[0], maps[0].text, []).regions.map((r) => r.id)).toEqual(maps[0].regions.map((r) => r.id));
  }, 120_000);
});

test('this repo: every tracked TS/TSX/JS/JSON/MD file satisfies the invariants', async () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '*.ts', '*.tsx', '*.js', '*.mjs', '*.json', '*.md'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const bad: string[] = [];
  let degraded = 0;
  for (const f of tracked) {
    if (!existsSync(join(ROOT, f))) continue;
    const fr = await regionize(f, readFileSync(join(ROOT, f)));
    if (fr.degraded) degraded++;
    bad.push(...checkInvariants(fr).map((v) => `${f}: ${v}`));
  }
  console.log(`[L-1] repo files=${tracked.length} degraded=${degraded}`);
  expect(tracked.length).toBeGreaterThan(50);
  expect(bad).toEqual([]);
}, 120_000);
