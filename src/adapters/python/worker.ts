/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "../types";
import { type PyodideLike, PythonRuntime } from "./runtime";

/**
 * Python execution worker. Loads the locally bundled Pyodide runtime (served
 * from /pyodide/, copied from node_modules at build time) — no network access
 * beyond the app's own origin. One worker executes at most one run; the host
 * discards it afterwards so every run starts from a clean interpreter.
 */
declare const self: DedicatedWorkerGlobalScope;

let runtime: Promise<PythonRuntime> | null = null;
const post = (m: FromWorker): void => self.postMessage(m);

function load(): Promise<PythonRuntime> {
  if (!runtime) {
    runtime = (async () => {
      const t0 = performance.now();
      const base = new URL(`${import.meta.env.BASE_URL}pyodide/`, self.location.origin).href;
      const mod = (await import(/* @vite-ignore */ `${base}pyodide.mjs`)) as {
        loadPyodide(opts: { indexURL: string; stdout?: (s: string) => void; stderr?: (s: string) => void }): Promise<PyodideLike>;
      };
      const py = await mod.loadPyodide({ indexURL: base, stdout: () => {}, stderr: () => {} });
      const rt = new PythonRuntime(py);
      post({ type: "ready", startupMs: Math.round(performance.now() - t0) });
      return rt;
    })();
  }
  return runtime;
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      await load();
    } else if (msg.type === "analyze") {
      const rt = await load();
      post({ type: "analysis", id: msg.id, result: rt.analyze(msg.source) });
    } else if (msg.type === "run") {
      const rt = await load();
      post({ type: "started" });
      const summary = rt.run(msg.request, (json) => post({ type: "events", json }));
      post({ type: "done", summary });
    }
  } catch (e) {
    post({ type: "fatal", message: e instanceof Error ? e.message : String(e) });
  }
};
