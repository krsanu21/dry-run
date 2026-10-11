import type { SourceAnalysis } from "../../analysis/types";
import type { ExecutionRequest } from "../../trace/schema";
import type { LanguageAdapter, RunCallbacks, RunHandle } from "../types";
import { runInWorker, type WorkerLike } from "../workerHost";
import { analyzeJavaScript } from "./analyze";

/** JavaScript adapter: AST instrumentation + single-use Web Worker per run. */
export class JavaScriptAdapter implements LanguageAdapter {
  readonly language = "javascript" as const;
  readonly displayName = "JavaScript";
  readonly modes = ["function", "script", "fragment"] as const;

  analyze(source: string): Promise<SourceAnalysis> {
    return Promise.resolve(analyzeJavaScript(source));
  }

  isReady(): boolean {
    return true;
  }

  run(request: ExecutionRequest, callbacks: RunCallbacks): RunHandle {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "dryrun-javascript" });
    return runInWorker(w as unknown as WorkerLike, request, callbacks, { startupTimeoutMs: 15000 });
  }
}
