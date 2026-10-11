/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "../types";
import { runJavaScript } from "./runtime";

/**
 * JavaScript execution worker. Instruments and runs the user's code; one
 * worker per run so global state never leaks between runs.
 */
declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromWorker): void => self.postMessage(m);

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type !== "run") return;
  try {
    post({ type: "started" });
    const summary = runJavaScript(msg.request, (json) => post({ type: "events", json }));
    post({ type: "done", summary });
  } catch (e) {
    post({ type: "fatal", message: e instanceof Error ? e.message : String(e) });
  }
};
