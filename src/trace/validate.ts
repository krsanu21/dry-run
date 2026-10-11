import { TRACE_SCHEMA_VERSION, type Value, type WireEvent } from "./schema";
import { forEachChildValue, frameRootValues, isTerminal, type Trace } from "./store";

const EVENT_TYPES = new Set(["call", "line", "return", "exception", "stdout", "complete", "limit"]);

/** Runtime shape check for events arriving from a worker (untrusted boundary). */
export function isWireEvent(x: unknown): x is WireEvent {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.type === "string" &&
    EVENT_TYPES.has(e.type) &&
    typeof e.line === "number" &&
    Array.isArray(e.stack) &&
    !!e.heap &&
    typeof e.heap === "object"
  );
}

export interface Violation {
  index: number;
  rule: string;
  message: string;
}

/**
 * Checks the adapter-independent invariants of a trace (the conformance
 * contract every language adapter must satisfy). Returns all violations.
 */
export function validateTrace(trace: Trace, sourceLineCount?: number): Violation[] {
  const out: Violation[] = [];
  const v = (index: number, rule: string, message: string): void => {
    out.push({ index, rule, message });
  };
  let prevStdout = 0;
  trace.events.forEach((ev, i) => {
    if (ev.index !== i) v(i, "monotonic-index", `event.index ${ev.index} != position ${i}`);
    if (ev.schemaVersion !== TRACE_SCHEMA_VERSION) v(i, "schema-version", `unexpected schema version ${ev.schemaVersion}`);
    if (ev.stdoutEnd < prevStdout) v(i, "stdout-monotonic", "stdout shrank");
    prevStdout = ev.stdoutEnd;
    if (isTerminal(ev) && i !== trace.length - 1) v(i, "terminal-last", `terminal ${ev.type} event is not last`);
    if (sourceLineCount !== undefined && ev.type !== "complete" && ev.type !== "limit" && (ev.loc.line < 1 || ev.loc.line > sourceLineCount))
      v(i, "line-range", `line ${ev.loc.line} outside source (1..${sourceLineCount})`);
    const ids = new Set<string>();
    for (const f of ev.stack) {
      if (ids.has(f.id)) v(i, "unique-frames", `frame ${f.id} appears twice`);
      ids.add(f.id);
    }
    // Every reference must resolve inside this event's own heap snapshot.
    const roots: Value[] = frameRootValues(ev.stack);
    for (const [, g] of ev.globals) roots.push(g);
    if (ev.returnValue) roots.push(ev.returnValue);
    if (ev.result) roots.push(ev.result);
    const check = (val: Value, where: string): void => {
      if (val.t === "ref" && !ev.heap[val.id]) v(i, "dangling-ref", `${where} references missing object ${val.id}`);
    };
    roots.forEach((r) => check(r, "root"));
    for (const [id, obj] of Object.entries(ev.heap)) {
      if (obj.id !== id) v(i, "heap-key", `heap key ${id} holds object ${obj.id}`);
      forEachChildValue(obj, (c) => check(c, `object ${id}`));
    }
    const prev = trace.events[i - 1];
    if (ev.type === "call") {
      const top = ev.stack[ev.stack.length - 1];
      if (!top) v(i, "call-frame", "call event without a frame");
      else if (prev && prev.stack.some((f) => f.id === top.id) && !top.isGenerator)
        v(i, "call-frame", `call event re-enters existing frame ${top.id}`);
      if (prev && ev.stack.length > prev.stack.length + 1 && prev.type !== "stdout")
        v(i, "call-depth", "call increased depth by more than one");
    }
    if (ev.type === "return") {
      const top = ev.stack[ev.stack.length - 1];
      if (!top) v(i, "return-frame", "return event without a frame");
      const next = trace.events[i + 1];
      if (top && next && !ev.yielded && next.stack.some((f) => f.id === top.id))
        v(i, "return-pops", `frame ${top.id} still on stack after its return`);
      if (!ev.unwind && !ev.returnValue) v(i, "return-value", "non-unwinding return without returnValue");
    }
    if (ev.type === "exception" && !ev.exception) v(i, "exception-info", "exception event without details");
    if (ev.type === "limit" && !ev.limit) v(i, "limit-info", "limit event without details");
  });
  return out;
}
