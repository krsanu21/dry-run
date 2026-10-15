import { toast } from "./store";

/**
 * Errors that React's boundaries cannot see: exceptions in event handlers, timers, promises
 * and the stores. They are reported once each as a toast instead of failing silently, and
 * never stop the app.
 */
export function installGlobalErrorHandlers(): void {
  const seen = new Set<string>();
  const report = (what: string, err: unknown): void => {
    const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
    const key = `${what}:${msg}`;
    console.error(`[dry run] ${what}:`, err);
    if (seen.has(key) || /ResizeObserver loop/.test(msg)) return;
    seen.add(key);
    try {
      toast(`Something went wrong (${msg.slice(0, 120)}). Your code is safe — try the action again.`, "error");
    } catch {
      // the toast itself must never throw
    }
  };
  window.addEventListener("error", (e) => report("uncaught error", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => report("unhandled promise rejection", e.reason));
}
