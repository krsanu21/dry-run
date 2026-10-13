import { describe, expect, it } from "vitest";
import { tracePython } from "../helpers";

// Run with PERF=1. Prints timings; asserts only generous ceilings so the suite stays stable.
const run = process.env.PERF ? describe : describe.skip;

const CASES: Record<string, { source: string; entry: string; args: string[] }> = {
  grid50: {
    source: "def f(n):\n    g = [[0] * n for _ in range(n)]\n    for r in range(n):\n        for c in range(n):\n            g[r][c] = r + c\n    return g[n-1][n-1]\n",
    entry: "f",
    args: ["50"],
  },
  array200: {
    source: "def f(n):\n    out = [0] * n\n    for i in range(1, n):\n        out[i] = out[i-1] + i\n    return out[-1]\n",
    entry: "f",
    args: ["200"],
  },
  memo: {
    source: "def f(n):\n    memo = {}\n    def go(k):\n        if k < 2:\n            return k\n        if k in memo:\n            return memo[k]\n        memo[k] = go(k-1) + go(k-2)\n        return memo[k]\n    return go(n)\n",
    entry: "f",
    args: ["300"],
  },
};

run("snapshot performance", () => {
  for (const [name, c] of Object.entries(CASES))
    it(name, async () => {
      const t0 = performance.now();
      const { trace, summary } = await tracePython({ ...c, mode: "function", limits: { timeoutMs: 60_000, maxEvents: 20_000 } as never });
      const ms = performance.now() - t0;
      console.log(`PERF ${name}: ${trace.length} events, ${ms.toFixed(0)} ms, ${(ms / trace.length).toFixed(3)} ms/event, status=${summary.status}`);
      expect(summary.status).toBe("completed");
    }, 120_000);
});

run("snapshot performance (JavaScript)", () => {
  it("grid50 js", async () => {
    const { traceJs } = await import("../helpers");
    const src = "function f(n) {\n  const g = Array.from({ length: n }, () => new Array(n).fill(0));\n  for (let r = 0; r < n; r++) {\n    for (let c = 0; c < n; c++) {\n      g[r][c] = r + c;\n    }\n  }\n  return g[n - 1][n - 1];\n}\n";
    const t0 = performance.now();
    const { trace, summary } = traceJs({ source: src, mode: "function", entry: "f", args: ["50"], limits: { timeoutMs: 60_000, maxEvents: 20_000 } as never });
    const ms = performance.now() - t0;
    console.log(`PERF grid50 js: ${trace.length} events, ${ms.toFixed(0)} ms, ${(ms / trace.length).toFixed(3)} ms/event, status=${summary.status}`);
    expect(summary.status).toBe("completed");
  }, 120_000);
});
