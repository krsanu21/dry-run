import {
  TRACE_SCHEMA_VERSION,
  type ExecutionSummary,
  type HeapObject,
  type Language,
  type TraceEvent,
  type TraceFrame,
  type Value,
  type WireEvent,
} from "./schema";

export interface TraceMeta {
  language: Language;
  mode: string;
  source: string;
  entry?: string;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** Calls `fn` for every reference value directly contained in a heap object. */
export function forEachChildValue(obj: HeapObject, fn: (v: Value) => void): void {
  switch (obj.kind) {
    case "list":
    case "tuple":
    case "set":
    case "deque":
      for (const v of obj.items) fn(v);
      break;
    case "dict":
      for (const [k, v] of obj.entries) {
        fn(k);
        fn(v);
      }
      break;
    case "object":
      for (const [, v] of obj.attrs) fn(v);
      break;
    default:
      break;
  }
}

export function frameRootValues(frames: readonly TraceFrame[]): Value[] {
  const out: Value[] = [];
  for (const f of frames) {
    for (const [, v] of f.locals) out.push(v);
    if (f.closure) for (const [, v] of f.closure) out.push(v);
  }
  return out;
}

/**
 * An append-only, immutable-history trace. Events are normalized as they
 * arrive; earlier events are never modified (objects are frozen and heap
 * snapshots share unchanged objects by reference).
 */
export class Trace {
  readonly events: TraceEvent[] = [];
  stdout = "";
  summary: ExecutionSummary | null = null;
  readonly meta: TraceMeta;

  /** Latest known encoding of every object id seen in this run. */
  private readonly pool = new Map<string, HeapObject>();

  // Indexes for navigation and the timeline.
  readonly callIndices: number[] = [];
  readonly returnIndices: number[] = [];
  readonly exceptionIndices: number[] = [];
  readonly stdoutIndices: number[] = [];
  readonly lineIndex = new Map<number, number[]>();
  /** Index of the first event of each frame id. */
  readonly frameStart = new Map<string, number>();
  /** Order in which object ids were first seen (stable layout for diagrams). */
  readonly objectFirstSeen = new Map<string, number>();
  private maxDepthSeen = 0;

  constructor(meta: TraceMeta) {
    this.meta = meta;
  }

  get length(): number {
    return this.events.length;
  }

  get last(): TraceEvent | undefined {
    return this.events[this.events.length - 1];
  }

  get maxDepth(): number {
    return this.maxDepthSeen;
  }

  /** True once a terminal event (complete / limit / uncaught exception) was recorded. */
  get finished(): boolean {
    const l = this.last;
    return !!l && isTerminal(l);
  }

  append(wire: readonly WireEvent[]): void {
    for (const w of wire) this.appendOne(w);
  }

  appendOne(w: WireEvent): TraceEvent {
    for (const [id, obj] of Object.entries(w.heap)) {
      this.pool.set(id, deepFreeze(obj));
      if (!this.objectFirstSeen.has(id)) this.objectFirstSeen.set(id, this.objectFirstSeen.size);
    }
    if (w.out) this.stdout += w.out;
    const stack = deepFreeze(w.stack.map((f) => ({ ...f })));
    const globals = deepFreeze((w.globals ?? []).map(([k, v]) => [k, v] as [string, Value]));

    // Reachability walk: the event heap holds exactly the objects reachable
    // from this event's roots, using the latest encoding of each object.
    const heap: Record<string, HeapObject> = {};
    const stackRoots: Value[] = frameRootValues(stack);
    for (const [, v] of globals) stackRoots.push(v);
    if (w.returnValue) stackRoots.push(w.returnValue);
    if (w.result) stackRoots.push(w.result);
    const todo: string[] = [];
    for (const v of stackRoots) if (v.t === "ref") todo.push(v.id);
    while (todo.length) {
      const id = todo.pop() as string;
      if (heap[id]) continue;
      const obj = this.pool.get(id);
      if (!obj) continue;
      heap[id] = obj;
      forEachChildValue(obj, (v) => {
        if (v.t === "ref" && !heap[v.id]) todo.push(v.id);
      });
    }

    const index = this.events.length;
    const ev: TraceEvent = Object.freeze({
      schemaVersion: TRACE_SCHEMA_VERSION,
      index,
      type: w.type,
      loc: Object.freeze(w.col !== undefined ? { line: w.line, column: w.col } : { line: w.line }),
      stack,
      globals,
      heap: Object.freeze(heap),
      stdoutEnd: this.stdout.length,
      ...(w.returnValue ? { returnValue: deepFreeze(w.returnValue) } : {}),
      ...(w.unwind ? { unwind: true } : {}),
      ...(w.yielded ? { yielded: true } : {}),
      ...(w.exception ? { exception: deepFreeze(w.exception) } : {}),
      ...(w.limit ? { limit: deepFreeze(w.limit) } : {}),
      ...(w.result ? { result: deepFreeze(w.result) } : {}),
    });
    this.events.push(ev);

    switch (ev.type) {
      case "call":
        this.callIndices.push(index);
        break;
      case "return":
        this.returnIndices.push(index);
        break;
      case "exception":
        this.exceptionIndices.push(index);
        break;
      case "stdout":
        this.stdoutIndices.push(index);
        break;
      case "line": {
        const arr = this.lineIndex.get(ev.loc.line);
        if (arr) arr.push(index);
        else this.lineIndex.set(ev.loc.line, [index]);
        break;
      }
      default:
        break;
    }
    for (const f of stack) if (!this.frameStart.has(f.id)) this.frameStart.set(f.id, index);
    if (stack.length > this.maxDepthSeen) this.maxDepthSeen = stack.length;
    return ev;
  }

  /**
   * Appends a terminal `limit` event created by the controlling thread when the
   * worker had to be terminated. It repeats the last recorded state verbatim.
   */
  appendSyntheticLimit(kind: "time" | "cancelled" | "crash", message: string, limit?: number): void {
    const prev = this.last;
    const w: WireEvent = {
      type: "limit",
      line: prev?.loc.line ?? 1,
      stack: prev ? [...prev.stack] : [],
      globals: prev ? [...prev.globals] : [],
      heap: {},
      limit: { kind, message, synthetic: true, ...(limit !== undefined ? { limit } : {}) },
    };
    this.appendOne(w);
  }

  stdoutAt(i: number): string {
    const ev = this.events[i];
    return ev ? this.stdout.slice(0, ev.stdoutEnd) : "";
  }
}

export function isTerminal(ev: TraceEvent): boolean {
  return ev.type === "complete" || ev.type === "limit" || (ev.type === "exception" && !!ev.exception?.uncaught);
}

export function activeFrame(ev: TraceEvent): TraceFrame | undefined {
  return ev.stack[ev.stack.length - 1];
}
