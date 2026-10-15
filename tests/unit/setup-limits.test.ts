import { describe, expect, it } from "vitest";
import type { Traced } from "../helpers";
import { traceJs, tracePython } from "../helpers";

/**
 * In function mode the file's top-level code runs before the traced call. It records
 * nothing, but it must obey the same limits as traced code — an endless loop or runaway
 * recursion there used to hang until the host's watchdog killed the worker (or crash the
 * Python runtime), and a failure there produced a terminal event with line 0, which the
 * editor could not draw.
 */

const limits = { timeoutMs: 1500, maxEvents: 5000 } as never;

function expectDrawable(t: Traced): void {
  for (const ev of t.trace.events) expect(ev.loc.line, `event ${ev.index} (${ev.type}) must have a line >= 1`).toBeGreaterThanOrEqual(1);
}

describe("Python: top-level code before the traced call", () => {
  it("stops an endless loop at module level quickly (by step budget), with a drawable line and the setup phase", async () => {
    const t0 = performance.now();
    const r = await tracePython({
      mode: "function",
      entry: "f",
      args: ["5"],
      limits,
      source: "def f(n):\n    return n\n\ni = 0\nwhile i < 10:\n    print(i)\n",
    });
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(r.summary.status).toBe("limit");
    const last = r.trace.last;
    expect(last?.type).toBe("limit");
    expect(["time", "events"]).toContain(last?.limit?.kind);
    expect(last?.limit?.phase).toBe("setup");
    expect(last?.loc.line).toBeGreaterThanOrEqual(5);
    expectDrawable(r);
  });

  it("stops runaway recursion at module level cleanly, even with a huge recursion limit (used to be a fatal runtime error)", async () => {
    const r = await tracePython({
      mode: "function",
      entry: "f",
      args: ["0"],
      limits,
      source: "import sys\nsys.setrecursionlimit(10**7)\n\ndef go(n):\n    return go(n + 1)\n\ndef f(n):\n    return n\n\ngo(0)\n",
    });
    expect(r.summary.status).toBe("limit");
    expect(r.trace.last?.limit?.kind).toBe("stack");
    expect(r.trace.last?.limit?.phase).toBe("setup");
    expectDrawable(r);
  });

  it("the unbounded-recursion DFS from the bug report ends in a clean, drawable stop", async () => {
    const r = await tracePython({
      mode: "function",
      entry: "create_adj_list",
      args: ["[[1, 2], [2, 3]]"],
      limits,
      source: [
        "from collections import defaultdict",
        "edges = [(1, 2), (1, 3), (2, 4), (2, 5), (3, 6)]",
        "def create_adj_list(edges):",
        "    d = defaultdict(list)",
        "    for i, j in edges:",
        "        d[i].append(j)",
        "        d[j].append(i)",
        "    return dict(d)",
        "graph = create_adj_list(edges)",
        "def dfs(graph, node, visited):",
        "    print(node)",
        "    for nb in graph[node]:",
        "        if nb not in visited:",
        "            dfs(graph, nb, visited)",
        "dfs(graph, 1, set())",
        "",
      ].join("\n"),
    });
    expect(["limit", "exception"]).toContain(r.summary.status);
    const last = r.trace.last;
    expect(last?.type === "limit" ? last.limit?.phase : last?.exception?.phase).toBe("setup");
    expectDrawable(r);
  });

  it("an exception in top-level code is marked as raised during setup and has a drawable line", async () => {
    const r = await tracePython({ mode: "function", entry: "f", args: ["1"], limits, source: "def f(n):\n    return n\n\nraise ValueError('bad setup')\n" });
    expect(r.summary.status).toBe("exception");
    expect(r.trace.last?.exception?.phase).toBe("setup");
    expect(r.trace.last?.exception?.line).toBe(4);
    expect(r.trace.last?.loc.line).toBe(4);
    expectDrawable(r);
  });

  it("ordinary top-level setup (including real work) is unaffected and is not recorded", async () => {
    const r = await tracePython({
      mode: "function",
      entry: "f",
      args: ["3"],
      limits,
      source: "table = [i * i for i in range(2000)]\nwhile len(table) < 5000:\n    table.append(0)\n\ndef f(n):\n    return table[n]\n",
    });
    expect(r.summary.status).toBe("completed");
    expect(r.summary.resultJson).toBe("9");
    expect(r.trace.events.every((e) => e.loc.line <= 6)).toBe(true);
    expect(r.trace.events[0]?.loc.line).toBe(5); // the first recorded event is the call, not the setup
  });

  it("the traced call after setup still gets its own full time budget", async () => {
    const r = await tracePython({
      mode: "function",
      entry: "f",
      args: ["1"],
      limits: { timeoutMs: 1500, maxEvents: 5000 } as never,
      source: "import time\nt = time.monotonic()\nwhile time.monotonic() - t < 0.8:\n    pass\n\ndef f(n):\n    return n\n",
    });
    expect(r.summary.status).toBe("completed");
  });

  it("fragment setup code obeys the limits too", async () => {
    const r = await tracePython({
      mode: "fragment",
      source: "x = 1\n",
      limits,
      fragment: { initialState: "{}", setup: "while True:\n    pass\n", startLine: 1 },
    });
    expect(r.summary.status).toBe("limit");
    expect(r.trace.last?.limit?.phase).toBe("setup");
    expectDrawable(r);
  });

  it("script mode is unchanged: the same loop is traced and stops at the event budget", async () => {
    const r = await tracePython({ mode: "script", limits, source: "i = 0\nwhile i < 10:\n    pass\n" });
    expect(r.summary.status).toBe("limit");
    expect(r.trace.last?.limit?.kind).toBe("events");
    expect(r.trace.last?.limit?.phase).toBeUndefined();
  });
});

describe("JavaScript: top-level code before the traced call", () => {
  it("stops an endless loop at the top level (time limit or step budget), with the setup phase", () => {
    const t0 = performance.now();
    const r = traceJs({ mode: "function", entry: "f", args: ["5"], limits, source: "function f(n) { return n; }\nlet i = 0;\nwhile (i < 10) { i = i; }\n" });
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(r.summary.status).toBe("limit");
    expect(["time", "events"]).toContain(r.trace.last?.limit?.kind);
    expect(r.trace.last?.limit?.phase).toBe("setup");
    expectDrawable(r);
  });

  it("an exception at the top level is marked as raised during setup and has a drawable line", () => {
    const r = traceJs({ mode: "function", entry: "f", args: ["1"], limits, source: "function f(n) { return n; }\nthrow new Error('bad setup');\n" });
    expect(r.summary.status).toBe("exception");
    expect(r.trace.last?.exception?.phase).toBe("setup");
    expectDrawable(r);
  });

  it("ordinary top-level setup is unaffected", () => {
    const r = traceJs({ mode: "function", entry: "f", args: ["2"], limits, source: "const t = [];\nfor (let i = 0; i < 5000; i++) t.push(i * 2);\nfunction f(n) { return t[n]; }\n" });
    expect(r.summary.status).toBe("completed");
    expect(r.summary.resultJson).toBe("4");
  });
});
