import { assemble } from './assemble.js';
import { hasError, packFor, packPieces, parse } from './pack.js';
import { attachRefs, readRefs, type RawRefs } from './refs.js';
import { shiftMap } from './shift.js';
import { decodeUtf8, sha1 } from './text.js';
import { definedPieces, jsonPieces, markdownPieces, markerBlocks, overlayMarkers, wholeFileReason } from './tiers.js';
import type { FileRegions, Piece, RegionizeOpts } from './types.js';

const JSON_GRAMMAR = 'tree-sitter-json.wasm';

export async function regionize(path: string, input: string | Buffer, opts: RegionizeOpts = {}): Promise<FileRegions> {
  const warnings: string[] = [];
  const text = typeof input === 'string' ? input : decodeUtf8(input);
  if (text === null) return binaryFile(path, input as Buffer);
  const why = wholeFileReason(path, text, typeof input === 'string' ? Buffer.byteLength(input) : input.length, opts);
  if (why) { warnings.push(`whole-file: ${why}`); return wholeFile(path, text, 'file', false, warnings); }
  const blocks = markerBlocks(text, warnings);
  let pieces: Piece[] | null = null;
  let packName = 'file';
  const pack = packFor(path);
  let raw: RawRefs | null = null;
  if (pack) {
    packName = `${pack.name}@${pack.version}`;
    const tree = await parse(pack.grammar, text);
    try {
      if (hasError(tree.rootNode)) {
        const last = opts.lastClean;
        if (last && !last.degraded && last.pack === packName && last.path === path) return shiftMap(last, text, warnings);
        return wholeFile(path, text, packName, true, warnings);
      }
      pieces = packPieces(pack, tree.rootNode, text);
      raw = await readRefs(pack, tree.rootNode, path);
    } finally {
      tree.delete();
    }
  } else if (/\.json$/i.test(path)) {
    const tree = await parse(JSON_GRAMMAR, text);
    try {
      if (!hasError(tree.rootNode) && (pieces = jsonPieces(tree.rootNode))) packName = 'json@1';
    } finally {
      tree.delete();
    }
  } else if (/\.(md|markdown)$/i.test(path)) {
    pieces = markdownPieces(text);
    packName = 'markdown@1';
  }
  if (pieces === null && opts.defined?.length && (pieces = definedPieces(text, opts.defined, warnings))) packName = 'defined@1';
  if (pieces === null && !blocks.length) return wholeFile(path, text, 'file', false, warnings);
  const regions = assemble(path, text, overlayMarkers(pieces ?? [], blocks, warnings), warnings);
  const fr: FileRegions = { path, pack: packName, degraded: false, text, warnings, regions };
  if (raw && regions.length) attachRefs(fr, raw);
  return fr;
}

export function wholeFile(path: string, text: string, pack: string, degraded: boolean, warnings: string[]): FileRegions {
  const pieces: Piece[] = text.length ? [{ start: 0, end: text.length, kind: 'file', qname: 'file', sig: null }] : [];
  return { path, pack, degraded, text, warnings, regions: assemble(path, text, pieces, warnings) };
}

function binaryFile(path: string, buf: Buffer): FileRegions {
  const h = sha1(buf);
  return {
    path, pack: 'binary', degraded: false, binary: true, text: '', warnings: ['whole-file: binary'],
    regions: buf.length ? [{ id: `${path}::file::file#0`, kind: 'file', qname: 'file', start: 0, end: buf.length, hash: h, masked: h, sig: null }] : [],
  };
}
