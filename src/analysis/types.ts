import type { Diagnostic } from "../trace/schema";

/**
 * Static facts extracted from the user's source with a real parser
 * (Python `ast` in the analysis worker, acorn for JavaScript).
 * Used for entry-point detection and for inferring which variables index
 * which data structures. Never used to fabricate runtime state.
 */
export interface ParamInfo {
  name: string;
  annotation?: string;
}

export interface FunctionInfo {
  name: string;
  /** Qualified entry name, e.g. `Solution.twoSum` or `twoSum`. */
  qualname: string;
  params: ParamInfo[];
  line: number;
  endLine: number;
  className?: string;
  returnAnnotation?: string;
}

export interface ClassInfo {
  name: string;
  line: number;
  endLine: number;
  methods: string[];
  /** attribute names assigned as `self.x` / `this.x` */
  attrs: string[];
}

/** One maximal subscript chain, e.g. `grid[r][c]` → base `grid`, indices [`r`, `c`]. */
export interface IndexAccess {
  line: number;
  /** Source text of the expression being indexed. */
  base: string;
  /** Source text of each index expression, outermost first. Slices are `lo:hi`. */
  indices: string[];
  /** Identifiers appearing in each index expression. */
  indexNames: string[][];
  write: boolean;
  /**
   * "subscript": an actual indexing expression on this line.
   * "loop": index evidence from loop structure (`enumerate(xs)`, `range(len(xs))`,
   * `i < len(xs)`, `i < xs.length`) — used for pointers, never for read/write marks.
   */
  kind?: "subscript" | "loop";
}

export interface SourceAnalysis {
  ok: boolean;
  diagnostics: Diagnostic[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  accesses: IndexAccess[];
  /** Expressions passed as the heap argument to heapq.* (Python). */
  heapBases: string[];
  /** Variables assigned from a length (`n = len(xs)`, `const n = xs.length`) — sizes, not pointers. */
  sizeNames?: string[];
  /** Candidate entry points, best first. */
  entryCandidates: string[];
  /** Top-level code calls into the program (its own functions/classes, print, input): it is meant to run as a whole file. */
  driver: boolean;
  /** The program reads standard input. */
  usesInput: boolean;
}

export const EMPTY_ANALYSIS: SourceAnalysis = {
  ok: true,
  diagnostics: [],
  functions: [],
  classes: [],
  accesses: [],
  heapBases: [],
  entryCandidates: [],
  driver: false,
  usesInput: false,
};
