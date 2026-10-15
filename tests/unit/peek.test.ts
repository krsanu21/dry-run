import { describe, expect, it } from "vitest";
import type { FunctionInfo } from "../../src/analysis/types";
import { diffEvents, type EventDiff } from "../../src/trace/diff";
import * as nav from "../../src/trace/navigation";
import { type PeekInput, type PeekModel, resolvePeek } from "../../src/trace/peek";
import type { Language, TraceEvent } from "../../src/trace/schema";
import { toPlain } from "../../src/trace/values";
import { local, pythonRuntime, type Req, traceJs, tracePython, type Traced } from "../helpers";

const NO_DIFF: EventDiff = { vars: [], objects: new Map(), framesEntered: [], framesExited: [] };

/** The same input the app builds for the selected step (see useCurrentStep). */
function inputAt(r: Traced, functions: readonly FunctionInfo[], i: number, selectedFrameId: string | null = null, language: Language = "python"): PeekInput {
  const trace = r.trace;
  const si = nav.stateIndex(trace, i);
  const final = si !== i;
  const event = trace.events[i] as TraceEvent;
  const state = trace.events[si] as TraceEvent;
  const prev = final ? undefined : trace.events[i - 1];
  return { trace, event, state, prev, diff: final ? NO_DIFF : diffEvents(prev, state), selectedFrameId, functions, language };
}

async function py(source: string, req: Partial<Req> = {}): Promise<{ r: Traced; fns: FunctionInfo[] }> {
  const r = await tracePython({ source, mode: "script", ...req });
  const fns = (await pythonRuntime()).analyze(source).functions;
  return { r, fns };
}

const peek = (r: Traced, fns: FunctionInfo[], i: number, line: number, name: string, opts: { expr?: string; frame?: string | null } = {}): PeekModel | null =>
  resolvePeek(inputAt(r, fns, i, opts.frame ?? null), { line, head: name, expr: opts.expr ?? name });

const lineEvents = (r: Traced, line: number): TraceEvent[] => r.trace.events.filter((e) => e.type === "line" && e.loc.line === line);

describe("Trace Peek: values come from the selected snapshot", () => {
  const SRC = "def f(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total\n";

  it("matches an independently computed ground truth at every iteration", async () => {
    const { r, fns } = await py(SRC, { mode: "function", entry: "f", args: ["6"] });
    const evs = lineEvents(r, 4); // `total += i` runs 6 times; state is BEFORE the line
    expect(evs).toHaveLength(6);
    let expected = 0;
    evs.forEach((ev, k) => {
      const t = peek(r, fns, ev.index, 4, "total");
      const i = peek(r, fns, ev.index, 4, "i");
      expect(t?.status).toBe("value");
      expect(t?.summary).toBe(String(expected));
      expect(i?.summary).toBe(String(k));
      expect(t?.type).toBe("int");
      expected += k;
    });
    expect(peek(r, fns, lineEvents(r, 5)[0]?.index as number, 5, "total")?.summary).toBe("15");
  });

  it("describes the moment and how the value changed from the previous step", async () => {
    const { r, fns } = await py(SRC, { mode: "function", entry: "f", args: ["4"] });
    const evs = lineEvents(r, 4);
    const second = evs[1] as TraceEvent; // total was 0, i = 1  (total += 0 just ran)
    const third = evs[2] as TraceEvent; // total = 1, i = 2
    expect(peek(r, fns, third.index, 4, "total")?.moment).toBe(`before line 4 runs · step ${third.index}`);
    // between two executions of line 4 only `total` (and `i`) change, in different steps
    const iChange = peek(r, fns, second.index, 4, "i");
    expect(iChange?.change?.kind).toBe("rebound");
    expect(iChange?.change?.was).toBe("0");
    expect(peek(r, fns, third.index, 4, "n")?.change?.kind).toBe("unchanged");
    // the first time `total` exists it is new
    const first = lineEvents(r, 3)[0] as TraceEvent;
    expect(peek(r, fns, first.index, 3, "total")?.change?.kind).toBe("new");
  });

  it("gives identical answers however the steps are visited: forwards, backwards, shuffled, and after the run ended", async () => {
    const { r, fns } = await py("def f(n):\n    seen = {}\n    total = 0\n    for i in range(n):\n        seen[i] = [i] * 2\n        total += i\n    return total\n", { mode: "function", entry: "f", args: ["7"] });
    const queries: Array<[number, string]> = [
      [5, "seen"],
      [5, "i"],
      [6, "total"],
      [4, "n"],
      [7, "total"],
    ];
    const all = (order: number[]): string[] => {
      const out: string[] = new Array(r.trace.length * queries.length);
      for (const i of order) queries.forEach(([line, name], k) => (out[i * queries.length + k] = JSON.stringify(peek(r, fns, i, line, name))));
      return out;
    };
    const idx = [...r.trace.events.keys()];
    const forward = all(idx);
    const backward = all([...idx].reverse());
    // a fixed pseudo-random order (deterministic)
    let seed = 7;
    const shuffled = [...idx].sort(() => ((seed = (seed * 48271) % 2147483647) % 3) - 1);
    expect(all(shuffled)).toEqual(forward);
    expect(backward).toEqual(forward);
    // and the final steps (stack unwound) still give the last live state rather than nothing
    const last = r.trace.length - 1;
    expect(r.trace.last?.type).toBe("complete");
    expect(peek(r, fns, last, 7, "total")?.summary).toBe("21");
    expect(peek(r, fns, last, 7, "total")?.moment).toContain("final state");
    expect(peek(r, fns, last, 7, "total")?.change?.kind).toBe("first");
  });
});

describe("Trace Peek: recursion", () => {
  const FIB = "def fib(n):\n    if n < 2:\n        return n\n    a = fib(n - 1)\n    b = fib(n - 2)\n    return a + b\n";

  it("resolves a name in the selected call, defaulting to the innermost call of the function", async () => {
    const { r, fns } = await py(FIB, { mode: "function", entry: "fib", args: ["4"] });
    // the first time the stack is 4 calls deep
    const deep = r.trace.events.find((e) => e.type === "line" && e.stack.length === 4) as TraceEvent;
    const names = deep.stack.map((f) => f.id);
    const nOf = (frame: string | null): PeekModel | null => peek(r, fns, deep.index, 4, "n", { frame });
    expect(nOf(null)?.summary).toBe(String(toPlain(local(deep, "n", deep.stack[3])!, deep.heap))); // innermost
    deep.stack.forEach((f, k) => {
      const m = nOf(f.id);
      expect(m?.summary, `depth ${k + 1}`).toBe(String(toPlain(local(deep, "n", f)!, deep.heap)));
      expect(m?.scopeLabel).toContain(`recursion depth ${k + 1} of 4`);
      expect(m?.highlight?.frameId).toBe(names[k]);
    });
    // the same variable in every active call is listed, with the selected one marked
    const m = nOf(names[1] as string);
    expect(m?.others.map((o) => o.value)).toEqual(deep.stack.map((f) => String(toPlain(local(deep, "n", f)!, deep.heap))));
    expect(m?.others.filter((o) => o.selected).map((o) => o.depth)).toEqual([2]);
  });

  it("values differ per activation: a sibling call after the first returned gets its own `a` and `b`", async () => {
    const { r, fns } = await py(FIB, { mode: "function", entry: "fib", args: ["5"] });
    // at `return a + b` of any frame, a + b must equal what that frame returns
    for (const ev of lineEvents(r, 6)) {
      const a = Number(peek(r, fns, ev.index, 6, "a")?.summary);
      const b = Number(peek(r, fns, ev.index, 6, "b")?.summary);
      const ret = r.trace.events.slice(ev.index).find((e) => e.type === "return" && e.stack.length === ev.stack.length);
      expect(a + b).toBe(Number(toPlain(ret!.returnValue!, ret!.heap)));
    }
  });

  it("a variable of a function that is not running now is reported as unavailable, not guessed", async () => {
    const { r, fns } = await py(FIB, { mode: "function", entry: "fib", args: ["3"] });
    const end = r.trace.length - 1;
    const m = peek(r, fns, end, 4, "n");
    // after the run only the final state is shown; the final state still has the last live frame, so `n` resolves there
    expect(m?.status).toBe("value");
    // but at the very first step (before the entry call) fib is inactive on a line it later runs
    const start = peek(r, fns, 0, 4, "a");
    expect(["not-yet", "unbound", "inactive"]).toContain(start?.status);
    expect(start?.message).toBeTruthy();
  });
});

describe("Trace Peek: aliases and mutation", () => {
  const SRC = "a = [1, 2]\nb = a\nb.append(3)\nc = list(a)\nc[0] = 9\nd = {'k': a}\n";

  it("names every alias of an object and describes in-place mutation", async () => {
    const { r, fns } = await py(SRC);
    const at = (line: number) => lineEvents(r, line)[0] as TraceEvent;
    const afterAlias = peek(r, fns, at(3).index, 3, "a");
    expect(afterAlias?.aliases).toContain("b");
    expect(afterAlias?.objectId).toBe(peek(r, fns, at(3).index, 3, "b")?.objectId);
    // `c` is a copy: different object, no alias
    const afterCopy = peek(r, fns, at(5).index, 5, "c");
    expect(afterCopy?.aliases).toEqual([]);
    expect(afterCopy?.objectId).not.toBe(afterAlias?.objectId);
    // the step after `b.append(3)` shows `a` mutated in place, through the alias
    const m = peek(r, fns, at(4).index, 4, "a");
    expect(m?.summary).toBe("[1, 2, 3]");
    expect(m?.change?.kind).toBe("mutated");
    expect(m?.change?.details).toContain("index 2 added: 3");
    expect(m?.rows.at(-1)).toMatchObject({ key: "2", value: "3", mark: "new" });
    // a dict entry referencing the list is another alias, seen from the list
    const last = r.trace.length - 1;
    expect(peek(r, fns, last, 6, "a")?.aliases.some((x) => x.includes("dict#") || x.startsWith("b"))).toBe(true);
  });

  it("reports rebinding with the previous value", async () => {
    const { r, fns } = await py("x = 1\nx = x + 41\ny = x\n");
    const m = peek(r, fns, lineEvents(r, 3)[0]!.index, 3, "x");
    expect(m?.summary).toBe("42");
    expect(m?.change).toMatchObject({ kind: "rebound", was: "1" });
  });
});

describe("Trace Peek: nested objects, previews and attribute chains", () => {
  const SRC = [
    "class Node:",
    "    def __init__(self, val, next=None):",
    "        self.val = val",
    "        self.next = next",
    "",
    "def f():",
    "    c = Node(3)",
    "    b = Node(2, c)",
    "    head = Node(1, b)",
    "    cur = head",
    "    cur = cur.next",
    "    return cur.val",
    "",
  ].join("\n");

  it("previews object attributes and follows `node.next.val` through the snapshot", async () => {
    const { r, fns } = await py(SRC, { mode: "function", entry: "f" });
    const ev = lineEvents(r, 11)[0] as TraceEvent;
    const head = peek(r, fns, ev.index, 11, "head");
    expect(head?.type).toBe("Node");
    expect(head?.rows.map((x) => x.key)).toEqual(["val", "next"]);
    expect(head?.rows[0]?.value).toBe("1");
    expect(head?.summary).toContain("Node(val=1");
    const chain = peek(r, fns, ev.index, 11, "head", { expr: "head.next.next.val" });
    expect(chain?.summary).toBe("3");
    expect(chain?.expr).toBe("head.next.next.val");
    expect(peek(r, fns, ev.index, 11, "head", { expr: "head.next.val" })?.summary).toBe("2");
    // `cur` and `head` are the same node at this step
    expect(peek(r, fns, ev.index, 11, "cur")?.aliases).toContain("head");
    // a method / unknown attribute is not a variable: nothing to show
    expect(peek(r, fns, ev.index, 11, "head", { expr: "head.nothing" })).toBeNull();
  });

  it("rebinding a pointer is reported as a different object", async () => {
    const { r, fns } = await py(SRC, { mode: "function", entry: "f" });
    const after = lineEvents(r, 12)[0] as TraceEvent;
    const cur = peek(r, fns, after.index, 12, "cur");
    expect(cur?.change?.kind).toBe("rebound");
    expect(cur?.change?.headline).toContain("different object");
    expect(cur?.highlight).toMatchObject({ name: "cur", objectId: cur?.objectId });
  });
});

describe("Trace Peek: unavailable, out-of-scope and truncated values are said plainly", () => {
  it("not yet assigned / never assigned / unknown names", async () => {
    const { r, fns } = await py("def f(flag):\n    if flag:\n        x = 1\n    later = 2\n    return later\n", { mode: "function", entry: "f", args: ["false"] });
    const m = peek(r, fns, lineEvents(r, 2)[0]!.index, 4, "later");
    expect(m?.status).toBe("not-yet");
    expect(m?.message).toContain("not been assigned yet");
    expect(m?.jump?.step).toBeGreaterThan(lineEvents(r, 2)[0]!.index);
    // x is assigned on a branch that never ran
    expect(peek(r, fns, lineEvents(r, 4)[0]!.index, 3, "x")).toBeNull(); // never bound anywhere in the trace -> not a variable here
    expect(peek(r, fns, lineEvents(r, 4)[0]!.index, 4, "print")).toBeNull();
    expect(peek(r, fns, lineEvents(r, 4)[0]!.index, 4, "len")).toBeNull();
  });

  it("flags a variable that exists in the program but was bound only in another call", async () => {
    const { r, fns } = await py("def g():\n    inner = 5\n    return inner\n\ndef f():\n    outer = g()\n    return outer\n", { mode: "function", entry: "f" });
    // at f's `return outer`, `inner` belongs to g, which has finished
    const m = peek(r, fns, lineEvents(r, 7)[0]!.index, 3, "inner");
    expect(m?.status).toBe("inactive");
    expect(m?.message).toContain("g()");
    expect(m?.jump?.step).toBeGreaterThanOrEqual(0);
  });

  it("says when only part of a large value was captured", async () => {
    const { r, fns } = await py("def f():\n    big = list(range(500))\n    s = 'x' * 1000\n    return big, s\n", { mode: "function", entry: "f" });
    const end = lineEvents(r, 4)[0] as TraceEvent;
    const big = peek(r, fns, end.index, 4, "big");
    expect(big?.length).toBe(500);
    expect(big?.notes.join(" ")).toMatch(/Only \d+ of 500 items were captured/);
    expect(big?.rowsMore).toBeGreaterThan(0);
    expect(big?.rows.length).toBeLessThanOrEqual(8);
    const s = peek(r, fns, end.index, 4, "s");
    expect(s?.length).toBe(1000);
    expect(s?.notes.join(" ")).toMatch(/first \d+ of 1000 characters/);
  });

  it("says when a nested value was not captured at all", async () => {
    const { r, fns } = await py("def f():\n    x = []\n    for _ in range(100):\n        x = [x]\n    return x\n", { mode: "function", entry: "f", limits: { maxDepth: 4 } as never });
    const m = peek(r, fns, lineEvents(r, 5)[0]!.index, 5, "x");
    expect(m?.notes.join(" ")).toMatch(/not captured|not part of|nested/i);
  });
});

describe("Trace Peek: scopes", () => {
  it("module-level code in script mode and globals read from inside functions", async () => {
    const { r, fns } = await py("LIMIT = 3\n\ndef f(n):\n    return n + LIMIT\n\nresult = f(4)\n");
    const inFn = lineEvents(r, 4)[0] as TraceEvent;
    expect(peek(r, fns, inFn.index, 4, "LIMIT")?.scopeLabel).toBe("global");
    expect(peek(r, fns, inFn.index, 4, "n")?.scopeLabel).toContain("f(n=4)");
    expect(peek(r, fns, lineEvents(r, 6)[0]!.index, 6, "LIMIT")?.summary).toBe("3");
  });

  it("function mode: top-level names are globals", async () => {
    const { r, fns } = await py("K = 10\n\ndef f(n):\n    return n * K\n", { mode: "function", entry: "f", args: ["2"] });
    const ev = lineEvents(r, 4)[0] as TraceEvent;
    expect(peek(r, fns, ev.index, 4, "K")).toMatchObject({ status: "value", summary: "10", scopeLabel: "global", scopeKind: "global" });
  });

  it("a comprehension variable is found while the comprehension frame is active", async () => {
    const { r, fns } = await py("def f(xs):\n    return [v * 2 for v in xs]\n", { mode: "function", entry: "f", args: ["[1, 2, 3]"] });
    const inside = r.trace.events.find((e) => e.stack.some((f) => f.name === "<listcomp>") && e.type === "line") as TraceEvent | undefined;
    if (inside) expect(peek(r, fns, inside.index, 2, "v")?.status).toBe("value"); // Python versions that inline comprehensions have no such frame
  });
});

describe("Trace Peek: JavaScript", () => {
  it("resolves names, recursion and nested objects from the same snapshots", () => {
    const src = "function fact(n) {\n  if (n <= 1) return 1;\n  const r = n * fact(n - 1);\n  return r;\n}\n";
    const r = traceJs({ source: src, mode: "function", entry: "fact", args: ["4"] });
    const deep = r.trace.events.find((e) => e.type === "line" && e.stack.length === 3) as TraceEvent;
    const m = resolvePeek(inputAt(r, [], deep.index, null, "javascript"), { line: 2, head: "n", expr: "n" });
    expect(m?.status).toBe("value");
    expect(m?.type).toBe("number");
    expect(m?.scopeLabel).toContain("recursion depth 3 of 3");
    expect(m?.others.map((o) => o.value)).toEqual(["4", "3", "2"]);
    const outer = resolvePeek(inputAt(r, [], deep.index, deep.stack[0]!.id, "javascript"), { line: 2, head: "n", expr: "n" });
    expect(outer?.summary).toBe("4");
  });
});

describe("Trace Peek: large traces", () => {
  it("stays accurate and fast across thousands of steps", async () => {
    const { r, fns } = await py("def f(n):\n    out = [0] * n\n    for i in range(1, n):\n        out[i] = out[i - 1] + i\n    return out[-1]\n", { mode: "function", entry: "f", args: ["1500"], limits: { maxEvents: 20_000 } as never });
    expect(r.trace.length).toBeGreaterThan(2900);
    const evs = lineEvents(r, 4);
    const t0 = performance.now();
    let checked = 0;
    for (let k = 0; k < evs.length; k += 7) {
      const ev = evs[k] as TraceEvent;
      const i = peek(r, fns, ev.index, 4, "i");
      expect(i?.summary).toBe(String(k + 1));
      const o = peek(r, fns, ev.index, 4, "out");
      expect(o?.length).toBe(1500);
      expect(o?.notes.join(" ")).toMatch(/Only 200 of 1500/);
      checked++;
    }
    const ms = performance.now() - t0;
    expect(checked).toBeGreaterThan(100);
    expect(ms / checked).toBeLessThan(15); // per-hover cost, including change detection
  });
});
