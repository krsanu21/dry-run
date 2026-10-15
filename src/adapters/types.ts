import type { SourceAnalysis } from "../analysis/types";
import type { ExecutionRequest, ExecutionSummary, Language, WireEvent } from "../trace/schema";

/**
 * The contract every execution adapter implements. The UI talks only to this
 * interface and to normalized trace events; adding Java or C++ means adding a
 * new LanguageAdapter (plus a worker/runtime that emits WireEvents).
 */
export interface RunCallbacks {
  /** Batches of wire events, in order. */
  onEvents(events: WireEvent[]): void;
  /** Lifecycle notifications for the UI. */
  onPhase?(phase: "starting" | "running"): void;
}

export interface RunOutcome {
  summary: ExecutionSummary & { resultJson?: string; limit?: { kind: string; message: string } };
  /**
   * Set when the controlling thread terminated the worker (watchdog timeout,
   * user cancellation, or runtime crash). The trace store appends a synthetic
   * `limit` event describing this.
   */
  terminated?: { kind: "time" | "cancelled" | "crash"; message: string; limit?: number };
}

export interface RunHandle {
  cancel(): void;
  readonly done: Promise<RunOutcome>;
}

export interface LanguageAdapter {
  readonly language: Language;
  readonly displayName: string;
  analyze(source: string): Promise<SourceAnalysis>;
  run(request: ExecutionRequest, callbacks: RunCallbacks): RunHandle;
  /** Start loading the runtime ahead of the first run. */
  warmup?(): void;
  /** Whether the runtime is loaded and ready (for status display). */
  isReady?(): boolean;
  dispose?(): void;
}

/** Messages from the controlling thread to an execution worker. */
export type ToWorker =
  | { type: "init" }
  | { type: "run"; request: ExecutionRequest }
  | { type: "analyze"; id: number; source: string };

/** Messages from an execution worker to the controlling thread. */
export type FromWorker =
  | { type: "ready"; startupMs: number }
  | { type: "started" }
  | { type: "events"; json: string }
  | { type: "done"; summary: RunOutcome["summary"] }
  | { type: "analysis"; id: number; result: SourceAnalysis }
  | { type: "fatal"; message: string };
