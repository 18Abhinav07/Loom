import { createHash } from 'node:crypto';

export const sha1 = (s: string | Buffer): string => createHash('sha1').update(s).digest('hex');

export function decodeUtf8(b: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return null; }
}

/** Start of the line that contains index i. */
export const lineStart = (text: string, i: number): number => (i <= 0 ? 0 : text.lastIndexOf('\n', i - 1) + 1);

/** End of the line that contains index i-1 (a node's exclusive end), newline included. */
export function lineEnd(text: string, i: number): number {
  if (i <= 0 || text[i - 1] === '\n') return i;
  const j = text.indexOf('\n', i);
  return j === -1 ? text.length : j + 1;
}

export const onlySpaceBefore = (text: string, i: number): boolean => /^[ \t]*$/.test(text.slice(lineStart(text, i), i));

export const squash = (s: string): string => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
