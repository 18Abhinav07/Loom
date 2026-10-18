// Plain-language labels for what Loom records, so no screen shows a raw id or code.
export const LAND: Record<string, string> = {
  landed: 'Landed on the shared branch.',
  tests_failed: 'Sent back: the tests failed on the merged result.',
  contract_break: 'Sent back: a function it changed no longer fits the code that calls it.',
  merge_conflict: 'Sent back: it did not merge cleanly.',
  out_of_scope: 'Sent back: it edited files the plan did not give it.',
};
export const landText = (code: string) => LAND[code] ?? code.replace(/_/g, ' ');

/** `todo/cli.py::main::definition#0` → `todo/cli.py`; the distinct files behind a list of region ids. */
export const files = (regions: string[]) => [...new Set(regions.map((r) => r.split('::')[0]))];
export const filesText = (regions: string[], max = 3) => { const f = files(regions); return f.slice(0, max).join(', ') + (f.length > max ? ` +${f.length - max} more` : ''); };

export const person = (p?: string | null) => (p ? p.replace(/^\d+\+/, '').replace(/@users\.noreply\.github\.com$/, '') : 'unknown');
export const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
export const startedBy = (t: { person?: string | null; leadSid?: string | null; plan: string }) =>
  `${person(t.person)} · ${t.leadSid ? `planned by Lead session ${t.leadSid.slice(-6)}` : `started from plan ${t.plan}, no Lead session`}`;
