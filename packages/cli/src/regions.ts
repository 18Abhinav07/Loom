import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkInvariants, COMMENT_SYNTAX, regionize, type FileRegions } from '@loom/indexer';

const lineOf = (text: string, i: number) => { let n = 1; for (let k = 0; k < i; k++) if (text.charCodeAt(k) === 10) n++; return n; };

function render(fr: FileRegions): string[] {
  return fr.regions.map((r) => {
    const span = fr.binary ? 'bin' : `${lineOf(fr.text, r.start)}-${lineOf(fr.text, Math.max(r.start, r.end - 1))}`;
    return `${span.padEnd(7)}${r.kind.padEnd(12)}${r.qname}${r.sig ? `  ${r.sig}` : ''}`;
  });
}

export async function regionsCmd(rest: string[], cwd = process.cwd(), log: (s: string) => void = console.log): Promise<number> {
  const json = rest.includes('--json');
  const args = rest.filter((a) => a !== '--json');

  if (args[0] === 'check') {
    const files = args.length > 1 ? args.slice(1) : execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
    let regions = 0, degraded = 0;
    const problems: string[] = [];
    for (const f of files) {
      let buf: Buffer;
      try { buf = readFileSync(resolve(cwd, f)); } catch { continue; }
      const fr = await regionize(f, buf);
      regions += fr.regions.length;
      if (fr.degraded) degraded++;
      problems.push(...checkInvariants(fr).map((v) => `${f}: ${v}`));
    }
    const summary = { files: files.length, regions, degraded, violations: problems.length };
    log(json ? JSON.stringify({ ...summary, problems })
      : [...problems, `files ${summary.files} · regions ${regions} · degraded ${degraded} · violations ${problems.length}`].join('\n'));
    return problems.length ? 1 : 0;
  }

  if (args[0] === 'mark') {
    const [, file, s, e, name] = args;
    const syntax = file ? COMMENT_SYNTAX(file) : null;
    if (!file || !name || !/^\S+$/.test(name) || !syntax) { log('usage: loom regions mark <file> <start-line> <end-line> <name> (file needs line comments)'); return 2; }
    const text = readFileSync(resolve(cwd, file), 'utf8');
    const lines = text.split('\n');
    const last = text.endsWith('\n') ? lines.length - 1 : lines.length;
    const a = Number(s), b = Number(e);
    if (!(a >= 1 && b >= a && b <= last)) { log(`line range ${s}-${e} outside 1-${last}`); return 2; }
    const indent = /^[ \t]*/.exec(lines[a - 1])![0];
    const [open, close] = syntax;
    lines.splice(b, 0, `${indent}${open}loom:end${close}`);
    lines.splice(a - 1, 0, `${indent}${open}loom:region ${name}${close}`);
    const next = lines.join('\n');
    const fr = await regionize(file, next);
    if (!fr.regions.some((r) => r.kind === 'section' && r.qname === name)) { log(fr.warnings.join('\n') || `marker ${name} rejected`); return 1; }
    writeFileSync(resolve(cwd, file), next);
    log(`marked ${name} in ${file}`);
    return 0;
  }

  const [file] = args;
  if (!file) { log('usage: loom regions <file> | check [files…] | mark <file> <start-line> <end-line> <name>'); return 2; }
  const fr = await regionize(file, readFileSync(resolve(cwd, file)));
  if (json) log(JSON.stringify({ path: fr.path, pack: fr.pack, degraded: fr.degraded, warnings: fr.warnings, regions: fr.regions.map(({ masked: _m, ...r }) => r) }));
  else log([...render(fr), ...fr.warnings.map((w) => `! ${w}`), ...(fr.degraded ? ['! degraded: file does not parse'] : [])].join('\n'));
  return 0;
}
