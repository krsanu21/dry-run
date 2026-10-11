import { EMPTY_ANALYSIS, type SourceAnalysis } from "../../analysis/types";
import type { ExecutionRequest } from "../../trace/schema";
import type { FromWorker, LanguageAdapter, RunCallbacks, RunHandle, ToWorker } from "../types";
import { runInWorker, type WorkerLike } from "../workerHost";

function createWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "dryrun-python" });
}

/**
 * Python adapter: Pyodide in single-use Web Workers. A spare worker is kept
 * warm so the interpreter start-up cost is paid before the user presses Run.
 * Static analysis uses a separate long-lived worker that never executes user
 * code (it only calls `ast.parse`).
 */
export class PythonAdapter implements LanguageAdapter {
  readonly language = "python" as const;
  readonly displayName = "Python";
  readonly modes = ["function", "script", "fragment"] as const;

  private spare: Worker | null = null;
  private spareReady = false;
  private analysisWorker: Worker | null = null;
  private analysisSeq = 0;
  private readonly pending = new Map<number, (r: SourceAnalysis) => void>();
  private readyListeners = new Set<() => void>();

  warmup(): void {
    if (!this.spare) this.spare = this.spawnSpare();
    this.ensureAnalysisWorker();
  }

  isReady(): boolean {
    return this.spareReady;
  }

  onReady(fn: () => void): () => void {
    this.readyListeners.add(fn);
    return () => this.readyListeners.delete(fn);
  }

  private spawnSpare(): Worker {
    const w = createWorker();
    this.spareReady = false;
    w.onmessage = (ev: MessageEvent<FromWorker>) => {
      if (ev.data.type === "ready" && this.spare === w) {
        this.spareReady = true;
        this.readyListeners.forEach((f) => f());
      }
    };
    w.postMessage({ type: "init" } satisfies ToWorker);
    return w;
  }

  private ensureAnalysisWorker(): Worker {
    if (this.analysisWorker) return this.analysisWorker;
    const w = createWorker();
    w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === "analysis") {
        this.pending.get(m.id)?.(m.result);
        this.pending.delete(m.id);
      }
    };
    w.onerror = () => {
      for (const [, r] of this.pending) r({ ...EMPTY_ANALYSIS, ok: true });
      this.pending.clear();
      this.analysisWorker = null;
    };
    this.analysisWorker = w;
    return w;
  }

  analyze(source: string): Promise<SourceAnalysis> {
    const w = this.ensureAnalysisWorker();
    const id = ++this.analysisSeq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      w.postMessage({ type: "analyze", id, source } satisfies ToWorker);
    });
  }

  run(request: ExecutionRequest, callbacks: RunCallbacks): RunHandle {
    const w = this.spare ?? createWorker();
    this.spare = null;
    this.spareReady = false;
    const handle = runInWorker(w as unknown as WorkerLike, request, callbacks);
    // Replace the consumed worker once this run is over (keeps CPU free during the run).
    void handle.done.then(() => {
      if (!this.spare) this.spare = this.spawnSpare();
    });
    return handle;
  }

  dispose(): void {
    this.spare?.terminate();
    this.analysisWorker?.terminate();
    this.spare = null;
    this.analysisWorker = null;
  }
}
