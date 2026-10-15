import { describe, expect, it } from "vitest";
import { tracePython } from "../helpers";

const run = process.env.PERF ? describe : describe.skip;

run("setup-phase speed", () => {
  it("measures steps per second of budget-checked top-level code", async () => {
    for (const iters of [500_000, 1_500_000]) {
      const t0 = performance.now();
      const r = await tracePython({
        mode: "function",
        entry: "f",
        args: ["1"],
        limits: { timeoutMs: 60_000, maxEvents: 5000 } as never,
        source: `i = 0\nwhile i < ${iters}:\n    i += 1\n\ndef f(n):\n    return i\n`,
      });
      const ms = performance.now() - t0;
      console.log(`PERF setup: ${iters} iterations (~${iters * 2} line steps) in ${ms.toFixed(0)} ms => ${((iters * 2) / ms / 1000).toFixed(2)} M steps/s, status=${r.summary.status}`);
      expect(r.summary.status).toBe("completed");
    }
  }, 120_000);
});
