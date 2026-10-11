import type { ExecutionRequest, WireEvent } from "../trace/schema";
import { isWireEvent } from "../trace/validate";
import type { FromWorker, RunCallbacks, RunHandle, RunOutcome, ToWorker } from "./types";

export interface WorkerLike {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}

export interface HostOptions {
  /** Extra time beyond the configured timeout before the watchdog kills the worker. */
  graceMs?: number;
  /** Max time to wait for the runtime to load. */
  startupTimeoutMs?: number;
}

/**
 * Runs one request in a single-use worker. A watchdog on the controlling
 * thread terminates the worker if it does not finish in time — this works even
 * when user code is stuck in native code where tracing callbacks never fire.
 * Events streamed before termination are preserved by the caller.
 */
export function runInWorker(worker: WorkerLike, request: ExecutionRequest, cb: RunCallbacks, opts: HostOptions = {}): RunHandle {
  const graceMs = opts.graceMs ?? 1500;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 90000;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveFn!: (o: RunOutcome) => void;
  const done = new Promise<RunOutcome>((r) => {
    resolveFn = r;
  });

  const finish = (o: RunOutcome): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    resolveFn(o);
  };
  const kill = (kind: "time" | "cancelled" | "crash", message: string, limit?: number): void => {
    finish({
      summary: { status: "limit", diagnostics: [], durationMs: 0 },
      terminated: { kind, message, ...(limit !== undefined ? { limit } : {}) },
    });
  };

  timer = setTimeout(() => kill("crash", "The runtime did not finish loading in time."), startupTimeoutMs);
  cb.onPhase?.("starting");

  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const msg = ev.data;
    switch (msg.type) {
      case "started":
        cb.onPhase?.("running");
        if (timer) clearTimeout(timer);
        timer = setTimeout(
          () =>
            kill(
              "time",
              `Stopped by the watchdog after ${(request.limits.timeoutMs / 1000).toFixed(1)} s: the program did not yield control (possibly a long-running built-in call).`,
              request.limits.timeoutMs,
            ),
          request.limits.timeoutMs + graceMs,
        );
        break;
      case "events": {
        let parsed: unknown;
        try {
          parsed = JSON.parse(msg.json);
        } catch {
          kill("crash", "The runtime sent malformed trace data.");
          return;
        }
        const evs = Array.isArray(parsed) ? parsed.filter(isWireEvent) : [];
        if (evs.length) cb.onEvents(evs as WireEvent[]);
        break;
      }
      case "done":
        finish({ summary: msg.summary });
        break;
      case "fatal":
        kill("crash", `The runtime crashed: ${msg.message}`);
        break;
      default:
        break;
    }
  };
  worker.onerror = (e: ErrorEvent) => {
    kill("crash", `The worker failed: ${e.message || "unknown error"}`);
  };
  worker.postMessage({ type: "run", request });

  return {
    cancel: () => kill("cancelled", "Execution was stopped by the user."),
    done,
  };
}
