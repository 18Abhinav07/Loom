export type SymbolKind = 'function' | 'method' | 'class';

export interface Param { name: string; default: boolean }
export interface ParamSpec { posonly: Param[]; pos: Param[]; vararg: boolean; kwonly: Param[]; kwarg: boolean; self: boolean }
export type Satisfies = true | false | 'unknown';

export interface SymbolRec {
  id: string;            // `${file}::${qname}`
  file: string;
  name: string;
  qname: string;         // `Class.method` or `func`
  kind: SymbolKind;
  startLine: number;     // 1-based, includes decorators
  endLine: number;
  sig: string;           // normalized header, e.g. `def f(a, *, strict)`
  sigHash: string;
  bodyHash: string;
  exported: boolean;
  params?: ParamSpec;     // functions and methods only
  doc?: string;          // docstring, first 300 chars
}

export interface CallRec {
  from: string;          // caller symbol id
  callee: string;        // source text of the callee expression, e.g. `phone2numeric` or `text.slugify`
  to: string[];          // candidate callee symbol ids (resolved by import map)
  line: number;
  argc: number;
  kwargs: string[];
  star: boolean;         // *args at the call site
  dstar: boolean;        // **kw at the call site
  method: boolean;       // callee is an attribute (o.f(...))
}

export interface FileIndex {
  file: string;
  source: string;
  symbols: SymbolRec[];
  calls: CallRec[];
}

export type ChangeKind = 'contract' | 'behavior' | 'removed' | 'added';

export interface ChangeRec {
  kind: ChangeKind;
  symbol: SymbolRec;           // the version before (for added: the new symbol)
  after?: SymbolRec;           // the version after (contract/behavior/added)
  renamedTo?: SymbolRec;       // removed + same body elsewhere in the file
  bodyDiff: string[];          // up to 6 `- old` / `+ new` lines
  related: string[];           // source of symbols added in the same edit that the new body references
}

export interface NoticeOut { id: string; text: string; score: number }
