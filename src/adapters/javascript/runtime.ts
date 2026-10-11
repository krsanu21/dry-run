import type { Diagnostic, ExecutionRequest, HeapObject, TraceFrame, TraceLimits, Value } from "../../trace/schema";
import type { RunOutcome } from "../types";
import { instrument, parseJs } from "./instrument";

/**
 * JavaScript tracing runtime. Executes AST-instrumented code (see
 * instrument.ts) and turns the inserted hook calls into normalized wire
 * events. Runs inside a Web Worker in the app and directly in Node for tests.
 */

type Getter = () => Array<[string, () => unknown, 1?]>;

interface FrameRec {
  id: string;
  name: string;
  line: number;
  endLine: number;
  args: string[];
  getter: Getter;
  isGen: boolean;
  traced: boolean;
  returned: boolean;
  threw: boolean;
  suspended: boolean;
}

const ABORT: { readonly dryRunAbort: true } = Object.freeze({ dryRunAbort: true });
const MAX_STDOUT = 200_000;
const MAX_SAFE = 2 ** 53;

const UNTRACED: FrameRec = Object.freeze({
  id: "",
  name: "",
  line: 0,
  endLine: 0,
  args: [],
  getter: () => [],
  isGen: false,
  traced: false,
  returned: false,
  threw: false,
  suspended: false,
}) as FrameRec;

class Snapshot {
  readonly objs = new Map<string, HeapObject>();
  private readonly queue: Array<[unknown, string, number]> = [];
  private readonly seen = new Set<string>();
  private count = 0;
  private items = 0;
  private readonly itemBudget: number;

  constructor(private readonly rt: JsTracer) {
    this.itemBudget = rt.limits.maxObjects * 20;
  }

  val(x: unknown, depth: number): Value {
    switch (typeof x) {
      case "undefined":
        return { t: "undefined" };
      case "boolean":
        return { t: "bool", v: x };
      case "number":
        if (!Number.isFinite(x)) return { t: "float", v: Number.isNaN(x) ? "NaN" : x > 0 ? "Infinity" : "-Infinity" };
        return Number.isInteger(x) && Math.abs(x) < MAX_SAFE && !Object.is(x, -0) ? { t: "int", v: x } : { t: "float", v: x };
      case "bigint":
        return { t: "int", v: `${x.toString()}n`, big: true };
      case "string": {
        const m = this.rt.limits.maxString;
        return x.length > m ? { t: "str", v: x.slice(0, m), len: x.length } : { t: "str", v: x };
      }
      case "symbol":
        return { t: "symbol", v: x.toString() };
      default:
        break;
    }
    if (x === null) return { t: "none" };
    const sid = this.rt.sid(x as object);
    if (!this.seen.has(sid)) {
      this.seen.add(sid);
      this.queue.push([x, sid, depth]);
    }
    return { t: "ref", id: sid };
  }

  drain(): Map<string, HeapObject> {
    for (let i = 0; i < this.queue.length; i++) {
      const [x, sid, depth] = this.queue[i] as [unknown, string, number];
      this.objs.set(sid, this.encode(x as object, sid, depth));
    }
    return this.objs;
  }

  private take<T>(it: Iterable<T>, total: number): { out: T[]; reason?: "items" | "budget" } {
    const cap = this.rt.limits.maxItems;
    const out: T[] = [];
    for (const e of it) {
      if (out.length >= cap) return { out, reason: "items" };
      if (this.items >= this.itemBudget) return { out, reason: "budget" };
      this.items++;
      out.push(e);
    }
    void total;
    return { out };
  }

  private encode(x: object, id: string, depth: number): HeapObject {
    const lim = this.rt.limits;
    const typeName = typeNameOf(x);
    if (depth > lim.maxDepth || this.count >= lim.maxObjects) {
      const length = Array.isArray(x) ? x.length : x instanceof Map || x instanceof Set ? x.size : undefined;
      return { id, kind: "elided", typeName, reason: depth > lim.maxDepth ? "depth" : "budget", ...(length !== undefined ? { length } : {}) };
    }
    this.count++;
    const nd = depth + 1;
    if (Array.isArray(x) || ArrayBuffer.isView(x)) {
      const a = x as ArrayLike<unknown>;
      const n = a.length;
      const idx = (function* () {
        for (let i = 0; i < n; i++) yield i;
      })();
      const { out, reason } = this.take(idx, n);
      const items = out.map((i) => (Array.isArray(a) && !(i in a) ? ({ t: "undefined" } as Value) : this.val(a[i], nd)));
      return { id, kind: "list", typeName, items, length: n, ...(reason ? { truncated: { reason, shown: out.length, total: n } } : {}) };
    }
    if (x instanceof Map) {
      const { out, reason } = this.take(x.entries(), x.size);
      return {
        id,
        kind: "dict",
        typeName,
        entries: out.map(([k, v]) => [this.val(k, nd), this.val(v, nd)] as [Value, Value]),
        length: x.size,
        ...(reason ? { truncated: { reason, shown: out.length, total: x.size } } : {}),
      };
    }
    if (x instanceof Set) {
      const { out, reason } = this.take(x.values(), x.size);
      return { id, kind: "set", typeName, items: out.map((v) => this.val(v, nd)), length: x.size, ...(reason ? { truncated: { reason, shown: out.length, total: x.size } } : {}) };
    }
    if (typeof x === "function") {
      const src = safeFnSource(x);
      const isClass = /^class[\s{]/.test(src);
      return { id, kind: isClass ? "class" : "function", typeName: isClass ? "class" : "function", repr: (x as { name?: string }).name || "anonymous" };
    }
    if (x instanceof Error || x instanceof Date || x instanceof RegExp || x instanceof Promise || x instanceof WeakMap || x instanceof WeakSet) {
      return { id, kind: "other", typeName, repr: safeString(x) };
    }
    const keys = Object.keys(x);
    const { out, reason } = this.take(keys, keys.length);
    const attrs: Array<[string, Value]> = out.map((k) => {
      const d = Object.getOwnPropertyDescriptor(x, k);
      if (d && "value" in d) return [k, this.val(d.value, nd)];
      return [k, { t: "str", v: "[getter]" }];
    });
    return { id, kind: "object", typeName, attrs, ...(reason ? { truncated: { reason, shown: out.length, total: keys.length } } : {}) };
  }
}

function typeNameOf(x: object): string {
  if (Array.isArray(x)) return "Array";
  if (typeof x === "function") return "function";
  const proto = Object.getPrototypeOf(x) as { constructor?: { name?: string } } | null;
  if (proto === null) return "Object";
  const name = proto.constructor?.name;
  return typeof name === "string" && name ? name : "Object";
}

function safeFnSource(f: object): string {
  try {
    return Function.prototype.toString.call(f);
  } catch {
    return "";
  }
}

function safeString(x: unknown): string {
  try {
    if (x instanceof Error) return `${x.name}: ${x.message}`;
    return String(x).slice(0, 200);
  } catch {
    return "<unprintable>";
  }
}

export function errorInfo(e: unknown): { type: string; message: string } {
  try {
    if (e instanceof Error) return { type: e.name || e.constructor?.name || "Error", message: e.message };
    if (e && typeof e === "object") return { type: typeNameOf(e), message: safeString(e) };
    return { type: typeof e, message: String(e) };
  } catch {
    return { type: "Error", message: "<unprintable exception>" };
  }
}

/** Minimal console.log formatting (Node-like, compact). */
export function inspect(x: unknown, depth = 0, seen: Set<unknown> = new Set()): string {
  if (typeof x === "string") return depth === 0 ? x : JSON.stringify(x);
  if (typeof x === "bigint") return `${x}n`;
  if (typeof x === "function") return `[Function: ${(x as { name?: string }).name || "anonymous"}]`;
  if (typeof x !== "object" || x === null) return String(x);
  if (seen.has(x)) return "[Circular]";
  if (depth > 4) return Array.isArray(x) ? "[Array]" : "[Object]";
  seen.add(x);
  let s: string;
  if (Array.isArray(x)) s = `[ ${x.map((v) => inspect(v, depth + 1, seen)).join(", ")} ]`.replace("[  ]", "[]");
  else if (x instanceof Map) s = `Map(${x.size}) { ${[...x].map(([k, v]) => `${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`).join(", ")} }`;
  else if (x instanceof Set) s = `Set(${x.size}) { ${[...x].map((v) => inspect(v, depth + 1, seen)).join(", ")} }`;
  else if (x instanceof Error) s = `${x.name}: ${x.message}`;
  else {
    const name = typeNameOf(x);
    const body = Object.keys(x)
      .map((k) => `${k}: ${inspect((x as Record<string, unknown>)[k], depth + 1, seen)}`)
      .join(", ");
    s = `${name === "Object" ? "" : `${name} `}{ ${body} }`.replace("{  }", "{}");
  }
  seen.delete(x);
  return s;
}

export class JsTracer {
  readonly limits: TraceLimits;
  private readonly post: (json: string) => void;
  private batch: string[] = [];
  private lastFlush = 0;
  nEvents = 0;
  private readonly objIds = new WeakMap<object, string>();
  private nextObj = 1;
  private nextFrame = 1;
  private readonly sent = new Map<string, string>();
  readonly stack: FrameRec[] = [];
  tracing = false;
  aborted = false;
  abortInfo: { kind: string; message: string } | null = null;
  private outPending = "";
  private outTotal = 0;
  private lastLine = 1;
  private deadline = Infinity;
  globalsGetter: Getter = () => [];
  showGlobals = false;
  traceback: Array<{ name: string; line: number }> = [];
  private readonly now: () => number;

  constructor(limits: TraceLimits, post: (json: string) => void, now: () => number) {
    this.limits = limits;
    this.post = post;
    this.now = now;
    this.lastFlush = now();
  }

  sid(o: object): string {
    let s = this.objIds.get(o);
    if (!s) {
      s = `o${this.nextObj++}`;
      this.objIds.set(o, s);
    }
    return s;
  }

  start(): void {
    this.tracing = true;
    this.deadline = this.now() + this.limits.timeoutMs;
  }

  write(s: string): void {
    if (this.outTotal >= MAX_STDOUT) return;
    const t = s.slice(0, MAX_STDOUT - this.outTotal);
    this.outTotal += t.length;
    this.outPending += t;
  }

  // -- snapshot ---------------------------------------------------------------
  private readBindings(getter: Getter, snap: Snapshot): { locals: Array<[string, Value]>; closure: Array<[string, Value]> } {
    const locals: Array<[string, Value]> = [];
    const closure: Array<[string, Value]> = [];
    let pairs: ReturnType<Getter> = [];
    try {
      pairs = getter();
    } catch {
      pairs = [];
    }
    for (const [name, read, isClosure] of pairs) {
      let v: unknown;
      try {
        v = read();
      } catch {
        continue; // temporal dead zone: binding not initialized yet
      }
      (isClosure ? closure : locals).push([name, snap.val(v, 0)]);
    }
    return { locals, closure };
  }

  private buildEvent(type: string, line: number, extra: Record<string, unknown> = {}, empty = false): Record<string, unknown> {
    const snap = new Snapshot(this);
    const stack: TraceFrame[] = [];
    if (!empty) {
      for (const f of this.stack) {
        if (!f.traced) continue;
        const { locals, closure } = this.readBindings(f.getter, snap);
        const fr: TraceFrame = { id: f.id, name: f.name, line: f.line, args: f.args, locals };
        if (closure.length) fr.closure = closure;
        if (f.isGen) fr.isGenerator = true;
        stack.push(fr);
      }
    }
    const ev: Record<string, unknown> = { type, line, stack };
    if (this.showGlobals || empty) {
      ev.globals = this.readBindings(this.globalsGetter, snap).locals.filter(([k]) => !k.startsWith("__dr"));
    }
    for (const [k, v] of Object.entries(extra)) {
      ev[k] = k === "returnValue" || k === "result" ? snap.val(v, 0) : v;
    }
    const objs = snap.drain();
    const delta: Record<string, HeapObject> = {};
    for (const [id, o] of objs) {
      const s = JSON.stringify(o);
      if (this.sent.get(id) !== s) {
        this.sent.set(id, s);
        delta[id] = o;
      }
    }
    ev.heap = delta;
    return ev;
  }

  private emitRaw(ev: Record<string, unknown>): void {
    this.batch.push(JSON.stringify(ev));
    this.nEvents++;
    const t = this.now();
    if (this.batch.length >= 200 || t - this.lastFlush > 50) this.flush();
  }

  flush(): void {
    if (this.batch.length) {
      this.post(`[${this.batch.join(",")}]`);
      this.batch = [];
    }
    this.lastFlush = this.now();
  }

  private emit(type: string, line: number, extra?: Record<string, unknown>): void {
    if (this.outPending) {
      const ev = this.buildEvent("stdout", this.lastLine);
      ev.out = this.outPending;
      this.outPending = "";
      this.checkBudget(line);
      this.emitRaw(ev);
    }
    this.checkBudget(line);
    this.emitRaw(this.buildEvent(type, line, extra));
  }

  private checkBudget(line: number): void {
    if (this.nEvents >= this.limits.maxEvents)
      this.stopWithLimit(line, "events", `Stopped after recording ${this.limits.maxEvents} events (event budget).`, this.limits.maxEvents);
    else if (this.now() > this.deadline)
      this.stopWithLimit(line, "time", `Stopped after ${(this.limits.timeoutMs / 1000).toFixed(1)} s (time limit).`, this.limits.timeoutMs);
  }

  stopWithLimit(line: number, kind: string, message: string, limit: number): never {
    this.aborted = true;
    this.abortInfo = { kind, message };
    this.emitRaw(this.buildEvent("limit", line, { limit: { kind, message, limit } }));
    this.flush();
    throw ABORT;
  }

  terminal(type: "complete" | "exception", extra: Record<string, unknown>): void {
    if (this.outPending) {
      const ev = this.buildEvent("stdout", this.lastLine, {}, true);
      ev.out = this.outPending;
      this.outPending = "";
      this.emitRaw(ev);
    }
    this.emitRaw(this.buildEvent(type, this.lastLine, extra, true));
    this.flush();
  }

  private activate(f: FrameRec): void {
    if (f.suspended) {
      f.suspended = false;
      this.stack.push(f);
    }
  }

  private pop(f: FrameRec): void {
    const i = this.stack.lastIndexOf(f);
    if (i >= 0) this.stack.splice(i, 1);
  }

  // -- hooks called by instrumented code ---------------------------------------
  /** Program prologue. Returns the module frame (traced only in script mode). */
  M = (getter: Getter): FrameRec => {
    this.globalsGetter = getter;
    if (!this.tracing) return UNTRACED;
    const f: FrameRec = { id: `f${this.nextFrame++}`, name: "<module>", line: 1, endLine: 1, args: [], getter, isGen: false, traced: true, returned: false, threw: false, suspended: false };
    this.stack.push(f);
    this.emit("call", 1);
    return f;
  };

  C = (name: string, line: number, _col: number, endLine: number, args: string[], getter: Getter, isGen: boolean): FrameRec => {
    if (this.aborted) throw ABORT;
    if (!this.tracing) return UNTRACED;
    const f: FrameRec = { id: `f${this.nextFrame++}`, name, line, endLine, args, getter, isGen, traced: true, returned: false, threw: false, suspended: false };
    this.stack.push(f);
    if (this.stack.length > this.limits.maxStackDepth)
      this.stopWithLimit(line, "stack", `Stopped: call stack exceeded ${this.limits.maxStackDepth} frames (stack limit).`, this.limits.maxStackDepth);
    this.lastLine = line;
    this.emit("call", line);
    return f;
  };

  L = (f: FrameRec, line: number, _col: number, getter: Getter): void => {
    if (this.aborted) throw ABORT;
    if (!f.traced) return;
    this.activate(f);
    f.line = line;
    f.getter = getter;
    this.emit("line", line);
    this.lastLine = line;
  };

  R = <T>(f: FrameRec, line: number, _col: number, getter: Getter, value: T): T => {
    if (this.aborted) throw ABORT;
    if (!f.traced) return value;
    this.activate(f);
    f.line = line;
    f.getter = getter;
    this.emit("return", line, { returnValue: value });
    f.returned = true;
    return value;
  };

  X = (f: FrameRec, e: unknown): void => {
    if (e === ABORT || this.aborted || !f.traced) return;
    this.activate(f);
    this.emit("exception", f.line, { exception: { ...errorInfo(e), line: f.line } });
    this.traceback.unshift({ name: f.name, line: f.line });
    f.threw = true;
  };

  K = (f: FrameRec, e: unknown): void => {
    if (e === ABORT || this.aborted) throw ABORT;
    if (!f.traced) return;
    this.activate(f);
    this.emit("exception", f.line, { exception: { ...errorInfo(e), line: f.line } });
    this.traceback = [];
  };

  F = (f: FrameRec): void => {
    if (!f.traced) return;
    if (this.aborted) {
      this.pop(f);
      return;
    }
    try {
      if (f.threw) {
        this.emit("return", f.line, { unwind: true });
      } else if (!f.returned) {
        f.line = f.endLine;
        this.emit("return", f.endLine, { returnValue: undefined });
      }
    } finally {
      this.pop(f);
    }
  };

  YO = <T>(f: FrameRec, line: number, _col: number, getter: Getter, value: T): T => {
    if (this.aborted) throw ABORT;
    if (!f.traced) return value;
    f.line = line;
    f.getter = getter;
    this.emit("return", line, { returnValue: value, yielded: true });
    this.pop(f);
    f.suspended = true;
    return value;
  };

  YI = <T>(f: FrameRec, sent: T): T => {
    if (this.aborted) throw ABORT;
    if (!f.traced) return sent;
    this.activate(f);
    this.emit("call", f.line);
    return sent;
  };

  /** Script mode: uncaught exception reached the top level. */
  moduleThrow(e: unknown): void {
    const f = this.stack[0];
    if (f && f.name === "<module>" && !this.aborted) {
      this.emit("exception", f.line, { exception: { ...errorInfo(e), line: f.line } });
      this.traceback.unshift({ name: "<module>", line: f.line });
      this.emit("return", f.line, { unwind: true });
      this.stack.length = 0;
    }
  }

  moduleReturn(): void {
    const f = this.stack[0];
    if (f && f.name === "<module>") {
      this.emit("return", f.line, { returnValue: undefined });
      this.stack.length = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// harness

const HARNESS_LIST_NODE = function ListNode(this: { val: unknown; next: unknown }, val?: unknown, next?: unknown) {
  this.val = val === undefined ? 0 : val;
  this.next = next === undefined ? null : next;
} as unknown as new (val?: unknown, next?: unknown) => { val: unknown; next: unknown };

const HARNESS_TREE_NODE = function TreeNode(this: { val: unknown; left: unknown; right: unknown }, val?: unknown, left?: unknown, right?: unknown) {
  this.val = val === undefined ? 0 : val;
  this.left = left === undefined ? null : left;
  this.right = right === undefined ? null : right;
} as unknown as new (val?: unknown) => { val: unknown; left: unknown; right: unknown };

type NodeCtor = new (val?: unknown) => Record<string, unknown>;

function buildLinkedList(values: unknown, Ctor: NodeCtor): unknown {
  if (values === null || values === undefined) return null;
  if (!Array.isArray(values)) throw new Error("linked-list argument must be a JSON array");
  let head: unknown = null;
  for (let i = values.length - 1; i >= 0; i--) {
    const n = new Ctor(values[i]);
    n.next = head;
    head = n;
  }
  return head;
}

function buildTree(values: unknown, Ctor: NodeCtor): unknown {
  if (!Array.isArray(values) || values.length === 0 || values[0] === null) return null;
  const root = new Ctor(values[0]);
  const q: Array<Record<string, unknown>> = [root];
  let i = 1;
  while (q.length && i < values.length) {
    const node = q.shift() as Record<string, unknown>;
    const lv = values[i++];
    if (lv !== null && lv !== undefined) {
      node.left = new Ctor(lv);
      q.push(node.left as Record<string, unknown>);
    }
    if (i >= values.length) break;
    const rv = values[i++];
    if (rv !== null && rv !== undefined) {
      node.right = new Ctor(rv);
      q.push(node.right as Record<string, unknown>);
    }
  }
  return root;
}

function convertSpecial(v: unknown, ctors: { ListNode: NodeCtor; TreeNode: NodeCtor }): unknown {
  if (Array.isArray(v)) return v.map((e) => convertSpecial(e, ctors));
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 1) {
      const [k, inner] = entries[0] as [string, unknown];
      const list = Array.isArray(inner) ? inner : [];
      if (k === "$set") return new Set(list.map((e) => convertSpecial(e, ctors)));
      if (k === "$map") return new Map(list.map((e) => (Array.isArray(e) ? [convertSpecial(e[0], ctors), convertSpecial(e[1], ctors)] : [e, undefined])));
      if (k === "$tuple" || k === "$deque") return list.map((e) => convertSpecial(e, ctors));
      if (k === "$linkedList") return buildLinkedList(inner, ctors.ListNode);
      if (k === "$tree") return buildTree(inner, ctors.TreeNode);
    }
    return Object.fromEntries(entries.map(([k, e]) => [k, convertSpecial(e, ctors)]));
  }
  return v;
}

export function toJsonable(x: unknown, depth = 0, seen: Set<unknown> = new Set()): unknown {
  if (depth > 200) return "…";
  if (x === undefined) return null;
  if (x === null || typeof x === "boolean" || typeof x === "string") return x;
  if (typeof x === "number") return Number.isFinite(x) ? x : String(x);
  if (typeof x === "bigint") return x.toString();
  if (typeof x !== "object") return String(x);
  if (seen.has(x)) return "<cycle>";
  seen.add(x);
  try {
    if (Array.isArray(x)) return x.map((e) => toJsonable(e, depth + 1, seen));
    if (x instanceof Set) return [...x].map((e) => toJsonable(e, depth + 1, seen)).sort();
    if (x instanceof Map) return Object.fromEntries([...x].map(([k, v]) => [String(k), toJsonable(v, depth + 1, seen)]));
    const o = x as Record<string, unknown>;
    if ("val" in o && "next" in o && !("left" in o)) {
      const out: unknown[] = [];
      const visited = new Set<unknown>();
      let n: unknown = o;
      while (n && typeof n === "object" && !visited.has(n) && out.length < 10000) {
        visited.add(n);
        out.push(toJsonable((n as Record<string, unknown>).val, depth + 1, new Set()));
        n = (n as Record<string, unknown>).next;
      }
      return out;
    }
    if ("val" in o && "left" in o && "right" in o) {
      const out: unknown[] = [];
      const q: unknown[] = [o];
      const visited = new Set<unknown>();
      while (q.length && out.length < 10000) {
        const n = q.shift();
        if (!n || typeof n !== "object") {
          out.push(null);
          continue;
        }
        if (visited.has(n)) {
          out.push("<cycle>");
          continue;
        }
        visited.add(n);
        const r = n as Record<string, unknown>;
        out.push(toJsonable(r.val, depth + 1, new Set()));
        q.push(r.left ?? null, r.right ?? null);
      }
      while (out.length && out[out.length - 1] === null) out.pop();
      return out;
    }
    return Object.fromEntries(Object.keys(o).map((k) => [k, toJsonable(o[k], depth + 1, seen)]));
  } finally {
    seen.delete(x);
  }
}

class HarnessError extends Error {}

/**
 * Executes a JavaScript request synchronously. `post` receives JSON arrays of
 * wire events as they are produced (streamed in batches).
 */
export function runJavaScript(request: ExecutionRequest, post: (json: string) => void, now: () => number = () => performance.now()): RunOutcome["summary"] {
  const t0 = now();
  const summary: RunOutcome["summary"] = { status: "completed", diagnostics: [], durationMs: 0 };
  const fragmentInit: Record<string, unknown> = {};
  if (request.mode === "fragment") {
    try {
      const parsed: unknown = JSON.parse(request.fragment?.initialState || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Initial state must be a JSON object of variable names");
      Object.assign(fragmentInit, parsed);
    } catch (e) {
      summary.status = "syntax-error";
      summary.diagnostics.push({ severity: "error", kind: "InitialStateError", line: 1, message: `Initial state is not valid: ${(e as Error).message}` });
      return summary;
    }
  }
  const ins = instrument(request.source, {
    mode: request.mode,
    fragmentParams: Object.keys(fragmentInit),
    startLine: request.fragment?.startLine ?? 1,
  });
  summary.diagnostics.push(...ins.diagnostics);
  if (!ins.ok) {
    summary.status = "syntax-error";
    return summary;
  }
  const setup = request.mode === "fragment" ? request.fragment?.setup ?? "" : "";
  if (setup.trim()) {
    const p = parseJs(setup);
    if ("error" in p) {
      summary.status = "syntax-error";
      summary.diagnostics.push({ ...p.error, message: `Setup code: ${p.error.message}`, line: 1 });
      return summary;
    }
  }

  const tracer = new JsTracer(request.limits, post, now);
  tracer.showGlobals = request.mode !== "script";
  const consoleObj = {
    log: (...a: unknown[]) => tracer.write(`${a.map((x) => inspect(x)).join(" ")}\n`),
    info: (...a: unknown[]) => tracer.write(`${a.map((x) => inspect(x)).join(" ")}\n`),
    debug: (...a: unknown[]) => tracer.write(`${a.map((x) => inspect(x)).join(" ")}\n`),
    warn: (...a: unknown[]) => tracer.write(`${a.map((x) => inspect(x)).join(" ")}\n`),
    error: (...a: unknown[]) => tracer.write(`${a.map((x) => inspect(x)).join(" ")}\n`),
  };
  const declaresList = ins.topLevelNames.includes("ListNode");
  const declaresTree = ins.topLevelNames.includes("TreeNode");
  const paramNames = ["__dr", "console"];
  const paramValues: unknown[] = [tracer, consoleObj];
  if (!declaresList) {
    paramNames.push("ListNode");
    paramValues.push(HARNESS_LIST_NODE);
  }
  if (!declaresTree) {
    paramNames.push("TreeNode");
    paramValues.push(HARNESS_TREE_NODE);
  }

  let program: (...args: unknown[]) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    program = new Function(...paramNames, `${setup}\n;${ins.code}`) as (...args: unknown[]) => unknown;
  } catch (e) {
    summary.status = "internal-error";
    summary.diagnostics.push({ severity: "error", kind: "InstrumentationError", line: 1, message: `Instrumented program failed to compile: ${(e as Error).message}` });
    return summary;
  }

  const getGlobal = (name: string): unknown => {
    for (const [k, read] of tracer.globalsGetter()) {
      if (k === name) {
        try {
          return read();
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };
  const ctors = (): { ListNode: NodeCtor; TreeNode: NodeCtor } => ({
    ListNode: (declaresList ? getGlobal("ListNode") : HARNESS_LIST_NODE) as NodeCtor,
    TreeNode: (declaresTree ? getGlobal("TreeNode") : HARNESS_TREE_NODE) as NodeCtor,
  });

  let runStart = now();
  try {
    if (request.mode === "script") {
      tracer.start();
      runStart = now();
      try {
        program(...paramValues);
      } catch (e) {
        if (e !== ABORT) tracer.moduleThrow(e);
        throw e;
      }
      tracer.moduleReturn();
      tracer.terminal("complete", {});
    } else {
      program(...paramValues); // definitions run untraced
      let fn: (...a: unknown[]) => unknown;
      let thisArg: unknown;
      let args: unknown[];
      if (request.mode === "fragment") {
        fn = getGlobal("__dr_fragment") as (...a: unknown[]) => unknown;
        const c = ctors();
        args = Object.values(fragmentInit).map((v) => convertSpecial(v, c));
        summary.harnessDescription = `Fragment executed as the body of a function whose parameters are the initial-state variables (${Object.keys(fragmentInit).join(", ") || "none"}). Setup code ran untraced first.`;
      } else {
        const entry = request.entry ?? "";
        const [a, b] = entry.split(".");
        if (b) {
          const Cls = getGlobal(a as string);
          if (typeof Cls !== "function") throw new HarnessError(`Class "${a}" is not defined`);
          thisArg = new (Cls as new () => Record<string, unknown>)();
          fn = (thisArg as Record<string, unknown>)[b] as (...a: unknown[]) => unknown;
        } else {
          fn = getGlobal(a as string) as (...a: unknown[]) => unknown;
        }
        if (typeof fn !== "function") throw new HarnessError(`Entry point "${entry}" was not found or is not callable`);
        const convs = request.argConversions ?? [];
        const c = ctors();
        args = (request.args ?? []).map((text, i) => {
          let v: unknown;
          try {
            v = text.trim() ? JSON.parse(text) : undefined;
          } catch (e) {
            throw new HarnessError(`Argument ${i + 1} is not valid JSON: ${(e as Error).message}`);
          }
          const conv = convs[i] ?? "raw";
          if (conv === "linked-list") return buildLinkedList(v, c.ListNode);
          if (conv === "binary-tree") return buildTree(v, c.TreeNode);
          return v;
        });
      }
      if (typeof fn !== "function") throw new HarnessError("Fragment function was not created");
      tracer.start();
      runStart = now();
      const result = fn.apply(thisArg, args);
      tracer.terminal("complete", { result });
      summary.resultJson = JSON.stringify(toJsonable(result));
    }
  } catch (e) {
    if (e === ABORT) {
      summary.status = "limit";
      if (tracer.abortInfo) summary.limit = tracer.abortInfo;
    } else if (e instanceof HarnessError) {
      summary.status = "internal-error";
      summary.diagnostics.push({ severity: "error", kind: "HarnessError", line: 1, message: e.message });
    } else if (tracer.aborted) {
      summary.status = "limit";
      if (tracer.abortInfo) summary.limit = tracer.abortInfo;
    } else {
      summary.status = "exception";
      const info = errorInfo(e);
      const tb = tracer.traceback;
      tracer.stack.length = 0;
      tracer.terminal("exception", { exception: { ...info, line: tb[tb.length - 1]?.line, uncaught: true, traceback: tb } });
      if (!tb.length && request.mode !== "script")
        summary.diagnostics.push({ severity: "error", kind: info.type, line: 1, message: `Failed before entering your code: ${info.message}` } satisfies Diagnostic);
    }
  } finally {
    tracer.flush();
    summary.durationMs = Math.round(now() - runStart);
    (summary as { events?: number }).events = tracer.nEvents;
  }
  void t0;
  return summary;
}
