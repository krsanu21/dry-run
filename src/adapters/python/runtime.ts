import { EMPTY_ANALYSIS, type SourceAnalysis } from "../../analysis/types";
import type { ExecutionRequest } from "../../trace/schema";
import type { RunOutcome } from "../types";
import tracerSource from "./tracer.py?raw";

/** The subset of the Pyodide API the runtime needs (works with browser and Node builds). */
export interface PyodideLike {
  runPython(code: string, options?: { globals?: unknown }): unknown;
  toPy(obj: unknown): unknown;
}

interface PyCallable {
  (...args: unknown[]): unknown;
  destroy?: () => void;
}

interface PyDict {
  get(key: string): unknown;
}

/**
 * Hosts the Python tracer inside a Pyodide instance. Shared by the Web Worker
 * and by Node-based tests so both exercise exactly the same tracing code.
 */
export class PythonRuntime {
  private readonly runFn: PyCallable;
  private readonly analyzeFn: PyCallable;

  constructor(py: PyodideLike) {
    const ns = py.toPy({}) as PyDict;
    py.runPython(tracerSource, { globals: ns });
    this.runFn = ns.get("run") as PyCallable;
    this.analyzeFn = ns.get("analyze") as PyCallable;
  }

  /** Executes a request; `post` receives JSON arrays of wire events as they are produced. */
  run(request: ExecutionRequest, post: (json: string) => void): RunOutcome["summary"] {
    const text = this.runFn(JSON.stringify(request), post) as string;
    return JSON.parse(text) as RunOutcome["summary"];
  }

  analyze(source: string): SourceAnalysis {
    try {
      const text = this.analyzeFn(source) as string;
      return { ...EMPTY_ANALYSIS, ...(JSON.parse(text) as Partial<SourceAnalysis>) };
    } catch (e) {
      return {
        ...EMPTY_ANALYSIS,
        ok: false,
        diagnostics: [{ severity: "error", kind: "AnalysisError", message: String(e), line: 1 }],
      };
    }
  }
}
