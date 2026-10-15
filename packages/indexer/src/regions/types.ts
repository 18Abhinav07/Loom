export type RegionKind = 'definition' | 'container' | 'imports' | 'gap' | 'key' | 'section' | 'file';

export interface Region {
  id: string;            // <path>::<qname>::<kind>#<n>
  kind: RegionKind;
  qname: string;
  start: number;         // UTF-16 index, inclusive
  end: number;           // UTF-16 index, exclusive
  hash: string;          // sha1 of the UTF-8 bytes
  masked: string;        // sha1 with the defining name token replaced by \u0000 (= hash when there is no name)
  sig: string | null;    // contract text: name + params (+ " -> " return type)
}

export interface CallSite { from: string; name: string }                                       // region id → callee text
export interface ImportBinding { from: string; local: string; module: string; name: string | null } // region id of the import

export interface FileRegions {
  path: string;
  pack: string;          // "python@1", "json@1", "markdown@1", "defined@1", "file", "binary"
  degraded: boolean;
  binary?: boolean;
  text: string;
  regions: Region[];
  warnings: string[];
  touched?: string[];    // degraded maps only: ids whose text changed since the last clean map
  calls?: CallSite[];
  imports?: ImportBinding[];
}

export interface Piece {
  start: number; end: number; kind: RegionKind; qname: string;
  nameStart?: number; nameEnd?: number; sig: string | null;
}

export interface RegionizeOpts {
  lastClean?: FileRegions;
  defined?: Array<{ start: number; end: number; name: string }>;
  generated?: boolean;
}
