/**
 * Dry Run trace schema — the language-independent contract between execution
 * adapters (Python, JavaScript, future Java/C++) and the presentation layer.
 *
 * See docs/trace-schema.md for the precise semantics of every event type.
 */

export const TRACE_SCHEMA_VERSION = 1 as const;

export type EventType =
  | "call" // a frame was entered; arguments are bound, no body line has run yet
  | "line" // the source line at `loc` is ABOUT to execute; state is pre-line
  | "return" // a frame is about to be popped (or a generator is suspending)
  | "exception" // an exception is propagating through the innermost frame at `loc`
  | "stdout" // output was written; state is captured right after the write(s)
  | "complete" // the program finished normally (terminal)
  | "limit"; // execution stopped because of a resource limit / cancellation (terminal)

export type Language = "python" | "javascript";

/** Primitive or reference value. Strings are primitives in every adapter. */
export type Value =
  | { t: "none" } // Python None / JS null
  | { t: "undefined" } // JS undefined
  | { t: "bool"; v: boolean }
  | { t: "int"; v: number; big?: undefined }
  | { t: "int"; v: string; big: true } // integers outside +/- 2^53, rendered from repr
  | { t: "float"; v: number | string } // string for inf / -inf / nan
  | { t: "str"; v: string; len?: number } // `len` present ⇒ the string was truncated to v
  | { t: "symbol"; v: string }
  | { t: "ref"; id: string };

export type PrimitiveValue = Exclude<Value, { t: "ref" }>;

export interface Truncation {
  /** Why the object's contents are incomplete. */
  reason: "items" | "budget" | "depth";
  /** Number of elements serialized. */
  shown: number;
  /** Actual number of elements in the object. */
  total: number;
}

interface HeapBase {
  id: string;
  /** Runtime type name: list, tuple, deque, dict, Counter, defaultdict, ListNode, Array, Map, … */
  typeName: string;
}

export interface SequenceObject extends HeapBase {
  kind: "list" | "tuple" | "set" | "deque";
  items: Value[];
  length: number;
  truncated?: Truncation;
  /** deque maxlen when bounded */
  maxlen?: number;
}

export interface DictObject extends HeapBase {
  kind: "dict";
  entries: Array<[Value, Value]>;
  length: number;
  truncated?: Truncation;
  /** defaultdict default factory name */
  defaultFactory?: string;
}

export interface InstanceObject extends HeapBase {
  kind: "object";
  attrs: Array<[string, Value]>;
  truncated?: Truncation;
}

export interface OpaqueObject extends HeapBase {
  kind: "function" | "class" | "other";
  repr: string;
}

/** An object that exists but whose contents were not captured because of a snapshot limit. */
export interface ElidedObject extends HeapBase {
  kind: "elided";
  reason: "depth" | "budget";
  length?: number;
}

export type HeapObject = SequenceObject | DictObject | InstanceObject | OpaqueObject | ElidedObject;

export interface SourceLoc {
  line: number; // 1-based, in the user's editor coordinates
  column?: number; // 0-based when available
}

export interface TraceFrame {
  /** Stable for the lifetime of one activation (generator frames keep it across resumes). */
  id: string;
  /** Function name. `<module>` for the top-level script frame. */
  name: string;
  /** Current line of this frame (for caller frames: the line containing the active call). */
  line: number;
  /** Names of the formal parameters, in declaration order. */
  args: string[];
  /** Ordered local bindings visible in this frame at this event. */
  locals: Array<[string, Value]>;
  /** JS only: captured bindings from enclosing function scopes. */
  closure?: Array<[string, Value]>;
  isGenerator?: boolean;
}

export interface ExceptionInfo {
  type: string;
  message: string;
  line?: number;
  /** true on the terminal event when nothing handled the exception. */
  uncaught?: boolean;
  /** "setup": raised by the file's top-level code, before the traced call began (function mode). */
  phase?: "setup";
  /** Innermost-last list of (function, line) the exception traversed, when known. */
  traceback?: Array<{ name: string; line: number }>;
}

export type LimitKind = "events" | "time" | "cancelled" | "crash" | "memory" | "stack";

export interface LimitInfo {
  kind: LimitKind;
  message: string;
  /** The configured value that was exceeded, if any. */
  limit?: number;
  /** true when the event was created by the controlling thread (worker was killed). */
  synthetic?: boolean;
  /** "setup": hit while the file's top-level code ran, before the traced call began (function mode). */
  phase?: "setup";
}

/**
 * Wire event: what an adapter sends. Heap and stdout are deltas relative to the
 * previous event of the same run; the trace store reconstructs full snapshots.
 */
/** A frame identical to the frame with the same id in the previous event (sent to avoid repeating deep stacks). */
export interface SameFrame {
  id: string;
  same: true;
}

export interface WireEvent {
  type: EventType;
  line: number;
  col?: number;
  /** Outermost first. An entry may be a SameFrame reference to the previous event's frame. */
  stack: Array<TraceFrame | SameFrame>;
  /** User-defined globals when they are not already represented by a `<module>` stack frame. */
  globals?: Array<[string, Value]>;
  /** Objects that are new or changed since the previous event. */
  heap: Record<string, HeapObject>;
  /** Text appended to stdout since the previous event. */
  out?: string;
  returnValue?: Value;
  /** On `return`: the frame is unwinding because of an exception (no value is returned). */
  unwind?: boolean;
  /** On `return`: a generator frame is suspending at a `yield` (returnValue is the yielded value). */
  yielded?: boolean;
  exception?: ExceptionInfo;
  limit?: LimitInfo;
  /** On `complete`: the value produced by the entry point (function mode). */
  result?: Value;
}

/** Normalized event consumed by the UI. Immutable once created. */
export interface TraceEvent {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly index: number;
  readonly type: EventType;
  readonly loc: SourceLoc;
  /** Outermost first. Empty on terminal events after the program has unwound. */
  readonly stack: readonly TraceFrame[];
  readonly globals: ReadonlyArray<[string, Value]>;
  /** Full heap snapshot: every object reachable from the stack, globals, and event values. */
  readonly heap: Readonly<Record<string, HeapObject>>;
  /** Length of accumulated stdout at this event (`trace.stdout.slice(0, stdoutEnd)`). */
  readonly stdoutEnd: number;
  readonly returnValue?: Value;
  readonly unwind?: boolean;
  readonly yielded?: boolean;
  readonly exception?: ExceptionInfo;
  readonly limit?: LimitInfo;
  readonly result?: Value;
}

export interface TraceLimits {
  /** Max recorded events before execution is stopped. */
  maxEvents: number;
  /** Wall-clock budget for the run (ms). Enforced in the runtime and by a watchdog. */
  timeoutMs: number;
  /** Max nesting depth explored from the roots of a snapshot. */
  maxDepth: number;
  /** Max items serialized for any single collection. */
  maxItems: number;
  /** Max objects serialized per snapshot (byte budget proxy). */
  maxObjects: number;
  /** Max characters kept for any single string. */
  maxString: number;
  /** Max call-stack depth recorded before the run is stopped. */
  maxStackDepth: number;
}

export const DEFAULT_LIMITS: TraceLimits = {
  maxEvents: 10000,
  timeoutMs: 10000,
  maxDepth: 64,
  maxItems: 200,
  maxObjects: 1500,
  maxString: 400,
  maxStackDepth: 400,
};

export type RunMode = "function" | "script";

/** How a JSON argument is converted before being passed to the entry point. */
export type ArgConversion = "auto" | "raw" | "linked-list" | "binary-tree";

export interface ExecutionRequest {
  language: Language;
  source: string;
  mode: RunMode;
  /** function mode: `Solution.twoSum` or `twoSum` */
  entry?: string;
  /** function mode: JSON text of each positional argument, in order */
  args?: string[];
  argConversions?: ArgConversion[];
  /** script mode: text provided to input()/stdin */
  stdin?: string;
  limits: TraceLimits;
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  /** e.g. SyntaxError, UnsupportedConstruct */
  kind: string;
}

export type ExecutionStatus = "completed" | "exception" | "limit" | "syntax-error" | "internal-error";

/** The summary sent once the run finishes (after all events were streamed). */
export interface ExecutionSummary {
  status: ExecutionStatus;
  diagnostics: Diagnostic[];
  /** ms spent executing user code (excluding runtime startup) */
  durationMs: number;
  startupMs?: number;
}
