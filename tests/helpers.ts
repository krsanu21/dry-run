import { loadPyodide } from "pyodide";
import { runJavaScript } from "../src/adapters/javascript/runtime";
import type { Example } from "../src/examples";
import { type PyodideLike, PythonRuntime } from "../src/adapters/python/runtime";
import type { RunOutcome } from "../src/adapters/types";
import { DEFAULT_LIMITS, type ExecutionRequest, type Language, type TraceFrame, type TraceEvent, type Value, type WireEvent } from "../src/trace/schema";
import { Trace } from "../src/trace/store";
import { formatValue } from "../src/trace/values";

let pyRuntime: Promise<PythonRuntime> | null = null;

/** One Pyodide instance per test file (Node build of the same runtime the worker loads). */
export function pythonRuntime(): Promise<PythonRuntime> {
  if (!pyRuntime) pyRuntime = loadPyodide().then((py) => new PythonRuntime(py as unknown as PyodideLike));
  return pyRuntime;
}

export type Req = Partial<ExecutionRequest> & { source: string };

/** The request the app makes for a built-in example's n-th test case. */
export function exampleRequest(ex: Example, testIndex = 0): Req {
  return { source: ex.source, mode: ex.entry ? "function" : "script", entry: ex.entry, args: ex.tests[testIndex]?.args, argConversions: ex.conversions };
}

function fullRequest(language: Language, r: Req): ExecutionRequest {
  return { language, mode: "script", ...r, limits: { ...DEFAULT_LIMITS, ...(r.limits ?? {}) } };
}

export interface Traced {
  trace: Trace;
  summary: RunOutcome["summary"];
  wire: WireEvent[];
}

function build(language: Language, req: ExecutionRequest, exec: (post: (j: string) => void) => RunOutcome["summary"]): Traced {
  const wire: WireEvent[] = [];
  const summary = exec((json) => wire.push(...(JSON.parse(json) as WireEvent[])));
  const trace = new Trace({ language, mode: req.mode, source: req.source, entry: req.entry });
  trace.append(wire);
  trace.summary = summary;
  return { trace, summary, wire };
}

export async function tracePython(r: Req): Promise<Traced> {
  const rt = await pythonRuntime();
  const req = fullRequest("python", r);
  return build("python", req, (post) => rt.run(req, post));
}

export function traceJs(r: Req): Traced {
  const req = fullRequest("javascript", r);
  return build("javascript", req, (post) => runJavaScript(req, post));
}

export async function traceLang(language: Language, r: Req): Promise<Traced> {
  return language === "python" ? tracePython(r) : traceJs(r);
}

// ---- assertion helpers ------------------------------------------------------

export function top(ev: TraceEvent): TraceFrame {
  const f = ev.stack[ev.stack.length - 1];
  if (!f) throw new Error(`event ${ev.index} (${ev.type}) has no frames`);
  return f;
}

export function local(ev: TraceEvent, name: string, frame?: TraceFrame): Value | undefined {
  const f = frame ?? ev.stack[ev.stack.length - 1];
  const hit = f?.locals.find(([k]) => k === name) ?? ev.globals.find(([k]) => k === name);
  return hit?.[1];
}

export function show(ev: TraceEvent, name: string, lang: Language = "python"): string | undefined {
  const v = local(ev, name);
  return v === undefined ? undefined : formatValue(v, ev.heap, lang, { maxLength: 10000, maxDepth: 20 });
}

/** Compact "type:line" signature of a trace for sequence assertions. */
export function signature(trace: Trace, types: string[] = ["call", "line", "return", "exception"]): string[] {
  return trace.events.filter((e) => types.includes(e.type)).map((e) => `${e.type}:${e.loc.line}`);
}

export function linesOf(trace: Trace): number[] {
  return trace.events.filter((e) => e.type === "line").map((e) => e.loc.line);
}
