import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare, shareTokenFromHash, validatePayload } from "../../src/persistence/share";
import { explainStep } from "../../src/trace/describe";
import { diffEvents, diffSequence } from "../../src/trace/diff";
import { evaluateSource, freeNames, scopeFrom } from "../../src/trace/expr";
import { variableHistory } from "../../src/trace/history";
import * as nav from "../../src/trace/navigation";
import type { TraceEvent, Value, WireEvent } from "../../src/trace/schema";
import { Trace } from "../../src/trace/store";
import { validateTrace } from "../../src/trace/validate";
import { formatValue, valuesEqual } from "../../src/trace/values";
import { top, tracePython } from "../helpers";

const int = (v: number): Value => ({ t: "int", v });

describe("trace store", () => {
  it("reconstructs full snapshots from deltas and keeps history immutable", () => {
    const t = new Trace({ language: "python", mode: "script", source: "" });
    const frame = (locals: Array<[string, Value]>) => [{ id: "f1", name: "<module>", line: 1, args: [], locals }];
    const w: WireEvent[] = [
      { type: "line", line: 1, stack: frame([["a", { t: "ref", id: "o1" }]]), heap: { o1: { id: "o1", kind: "list", typeName: "list", items: [int(1)], length: 1 } } },
      { type: "line", line: 2, stack: frame([["a", { t: "ref", id: "o1" }]]), heap: {} },
      { type: "line", line: 3, stack: frame([["a", { t: "ref", id: "o1" }]]), heap: { o1: { id: "o1", kind: "list", typeName: "list", items: [int(1), int(2)], length: 2 } } },
      { type: "complete", line: 3, stack: [], heap: {} },
    ];
    t.append(w);
    expect(t.events[1]?.heap.o1).toBe(t.events[0]?.heap.o1); // structural sharing
    expect(t.events[2]?.heap.o1).not.toBe(t.events[0]?.heap.o1);
    expect((t.events[0]?.heap.o1 as { items: Value[] }).items.length).toBe(1);
    expect(t.events[3]?.heap.o1).toBeUndefined(); // unreachable on terminal event
    expect(() => {
      (t.events[0]?.heap.o1 as { items: Value[] }).items.push(int(9));
    }).toThrow();
    expect(t.finished).toBe(true);
    expect(validateTrace(t)).toEqual([]);
  });

  it("appends a synthetic limit event reusing the last recorded state", () => {
    const t = new Trace({ language: "python", mode: "script", source: "" });
    t.appendOne({ type: "line", line: 4, stack: [{ id: "f1", name: "<module>", line: 4, args: [], locals: [["x", int(3)]] }], heap: {} });
    t.appendSyntheticLimit("time", "watchdog", 1000);
    expect(t.last?.type).toBe("limit");
    expect(t.last?.limit).toEqual({ kind: "time", message: "watchdog", synthetic: true, limit: 1000 });
    expect(t.last?.stack[0]?.locals).toEqual([["x", int(3)]]);
  });
});

describe("navigation", () => {
  const src = "def f(n):\n    if n == 0:\n        return 0\n    x = f(n - 1)\n    return x + 1\nr = f(2)\ny = r\n";

  it("step over / out / back over behave per documented depth semantics", async () => {
    const { trace } = await tracePython({ source: src });
    const i6 = trace.events.findIndex((e) => e.type === "line" && e.loc.line === 6);
    const over = nav.stepOver(trace, i6);
    expect(trace.events[over.index]?.loc.line).toBe(7); // skipped the whole recursion
    const into = nav.stepInto(trace, i6);
    expect(trace.events[into.index]?.type).toBe("call");
    // inside the deepest call, step out lands in the caller frame
    const deepest = trace.events.findIndex((e) => e.stack.length === 4);
    const out = nav.stepOut(trace, deepest);
    expect(trace.events[out.index]?.stack.length).toBe(3);
    const back = nav.stepBackOver(trace, over.index);
    expect(trace.events[back.index]?.loc.line).toBe(6);
    expect(nav.stepBack(trace, 0).found).toBe(false);
    expect(nav.stepInto(trace, trace.length - 1).found).toBe(false);
  });

  it("breakpoints stop at each repeated hit (recursion + loop)", async () => {
    const { trace } = await tracePython({ source: src });
    const bps = new Set([4]);
    const hits: number[] = [];
    let i = -1;
    for (;;) {
      const r = nav.nextBreakpoint(trace, i, bps);
      if (!r.found) break;
      hits.push(r.index);
      i = r.index;
    }
    expect(hits.length).toBe(2); // n=2 and n=1 reach line 4
    expect(hits.every((h) => trace.events[h]?.type === "line" && trace.events[h]?.loc.line === 4)).toBe(true);
    expect(nav.prevBreakpoint(trace, hits[1] as number, bps).index).toBe(hits[0]);
    expect(nav.nextBreakpoint(trace, hits[1] as number, bps).found).toBe(false);
  });

  it("breakpoints in loops and on lines that raise", async () => {
    const { trace } = await tracePython({ source: "xs = [1, 2, 0]\nfor x in xs:\n    y = 10 // x\n" });
    const bps = new Set([3]);
    const first = nav.nextBreakpoint(trace, -1, bps).index;
    const second = nav.nextBreakpoint(trace, first, bps).index;
    const third = nav.nextBreakpoint(trace, second, bps).index;
    expect([first, second, third].map((i) => trace.events[i]?.loc.line)).toEqual([3, 3, 3]);
    expect(trace.events[third + 1]?.type).toBe("exception");
  });

  it("initial focus lands on the raise point for uncaught exceptions", async () => {
    const { trace } = await tracePython({ source: "def f():\n    return 1 / 0\nf()\n" });
    const i = nav.initialFocus(trace);
    expect(trace.events[i]?.type).toBe("exception");
    expect(trace.events[i]?.stack.length).toBe(2);
  });

  it("navigation is index-based on a large trace (thousands of events)", async () => {
    const { trace } = await tracePython({ source: "s = 0\nfor i in range(3000):\n    s += i\n", limits: { maxEvents: 20000 } as never });
    expect(trace.length).toBeGreaterThan(6000);
    const t0 = performance.now();
    for (let k = 0; k < 2000; k++) nav.nextBreakpoint(trace, k, new Set([3]));
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("diff", () => {
  const h = {};
  it("sequence diff: changed, inserted and removed", () => {
    const a = [int(1), int(2), int(3)];
    expect(diffSequence(a, h, 3, [int(1), int(9), int(3)], h, 3).status).toEqual(["same", "changed", "same"]);
    const ins = diffSequence(a, h, 3, [int(0), int(1), int(2), int(3)], h, 4);
    expect(ins.status).toEqual(["new", "same", "same", "same"]);
    const rem = diffSequence(a, h, 3, [int(2), int(3)], h, 2);
    expect(rem.status).toEqual(["same", "same"]);
    expect(rem.removed).toEqual([{ value: int(1), at: 0, beforeIndex: 0 }]);
  });

  it("events: variable added/changed/removed and object mutation", async () => {
    const { trace } = await tracePython({ source: "a = [1]\nb = 2\na.append(3)\nb = 4\n" });
    const e3 = trace.events.find((e) => e.type === "line" && e.loc.line === 3) as TraceEvent;
    const e4 = trace.events.find((e) => e.type === "line" && e.loc.line === 4) as TraceEvent;
    const d = diffEvents(e3, e4);
    expect(d.vars).toEqual([]);
    const aid = (e4.stack[0]?.locals.find(([k]) => k === "a")?.[1] as { id: string }).id;
    const ch = d.objects.get(aid);
    expect(ch && !ch.isNew && ch.kind === "sequence" ? ch.status : null).toEqual(["same", "new"]);
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    const d2 = diffEvents(e4, ret);
    expect(d2.vars).toMatchObject([{ name: "b", kind: "changed" }]);
  });
});

describe("watch expression evaluator", () => {
  const heap = {
    o1: { id: "o1", kind: "list" as const, typeName: "list", items: [int(2), int(7), int(11)], length: 3 },
    o2: { id: "o2", kind: "dict" as const, typeName: "dict", entries: [[int(2), int(0)]] as Array<[Value, Value]>, length: 1 },
    o3: { id: "o3", kind: "object" as const, typeName: "ListNode", attrs: [["val", int(5)], ["next", { t: "none" }]] as Array<[string, Value]> },
  };
  const scope = scopeFrom(
    [
      ["nums", { t: "ref", id: "o1" }],
      ["seen", { t: "ref", id: "o2" }],
      ["node", { t: "ref", id: "o3" }],
      ["i", int(1)],
      ["s", { t: "str", v: "abc" }],
    ],
    heap,
  );
  const ev = (src: string): unknown => {
    const r = evaluateSource(src, scope);
    return r.ok ? r.value : `ERR: ${r.error}`;
  };
  it("evaluates indexing, arithmetic, membership, attributes and builtins", () => {
    expect(ev("nums[i] + nums[i + 1]")).toEqual(int(18));
    expect(ev("nums[-1]")).toEqual(int(11));
    expect(ev("9 - nums[0] in seen")).toEqual({ t: "bool", v: false });
    expect(ev("2 in seen and not (3 in seen)")).toEqual({ t: "bool", v: true });
    expect(ev("seen[2]")).toEqual(int(0));
    expect(ev("node.val * 2")).toEqual(int(10));
    expect(ev("node.next")).toEqual({ t: "none" });
    expect(ev("len(nums) // 2")).toEqual(int(1));
    expect(ev("max(nums)")).toEqual(int(11));
    expect(ev("s[1]")).toEqual({ t: "str", v: "b" });
    expect(ev("nums.length")).toEqual(int(3));
    expect(ev("i === 1 && true")).toEqual({ t: "bool", v: true });
    expect(ev("7 % 3")).toEqual(int(1));
  });
  it("explains what cannot be evaluated", () => {
    expect(ev("missing + 1")).toBe("ERR: 'missing' is not in scope at this step");
    expect(ev("nums[9]")).toBe("ERR: index 9 out of range (length 3)");
    expect(ev("foo(1)")).toBe("ERR: function 'foo' is not available in watch expressions");
    expect(ev("nums[")).toMatch(/^ERR/);
    expect(ev("seen[42]")).toMatch(/not present/);
  });
  it("never calls into user code: there is no call syntax for arbitrary functions", () => {
    expect(freeNames("nums[i] + len(seen)")).toEqual(["nums", "i", "seen"]);
  });
});

describe("variable history", () => {
  it("segments rebinding vs mutation and links to events", async () => {
    const { trace } = await tracePython({ source: "x = 1\nx = 2\nxs = []\nxs.append(1)\nxs.append(2)\nxs = [9]\n" });
    const fid = trace.events[0]?.stack[0]?.id as string;
    const hx = variableHistory(trace, fid, "x", "python");
    expect(hx.segments.map((s) => s.text)).toEqual(["1", "2"]);
    const hxs = variableHistory(trace, fid, "xs", "python");
    expect(hxs.segments.length).toBe(2); // two different objects
    expect(hxs.segments[0]?.mutations.length).toBe(2); // appended twice
    expect(hxs.segments[1]?.text).toBe("[9]");
    expect(hxs.unboundRanges[0]?.from).toBe(0);
  });

  it("is per-invocation for recursive frames", async () => {
    const { trace } = await tracePython({ source: "def f(n):\n    k = n * 10\n    if n:\n        f(n - 1)\nf(1)\n" });
    const frames = [...new Set(trace.events.filter((e) => e.stack.length > 1).map((e) => top(e).id))];
    const k1 = variableHistory(trace, frames[0] as string, "k", "python");
    const k2 = variableHistory(trace, frames[1] as string, "k", "python");
    expect(k1.segments[0]?.text).toBe("10");
    expect(k2.segments[0]?.text).toBe("0");
  });
});

describe("step explanations", () => {
  it("say what just happened, what is next, and flag missing returns", async () => {
    const src = "class Solution:\n    def f(self, nums):\n        total = 0\n        for n in nums:\n            total += n\n";
    const { trace } = await tracePython({ source: src, mode: "function", entry: "Solution.f", args: ["[1]"] });
    const i = trace.events.findIndex((e) => e.type === "line" && e.loc.line === 4);
    const d = diffEvents(trace.events[i - 1], trace.events[i] as TraceEvent);
    const ex = explainStep(trace.events[i - 1], trace.events[i] as TraceEvent, d, src, "python");
    expect(ex.happened[0]).toContain("Line 3 ran");
    expect(ex.happened).toContain("total = 0");
    expect(ex.now).toContain("About to run line 4");
    const r = trace.events.findIndex((e) => e.type === "return");
    const exr = explainStep(trace.events[r - 1], trace.events[r] as TraceEvent, diffEvents(trace.events[r - 1], trace.events[r] as TraceEvent), src, "python");
    expect(exr.hints.join(" ")).toContain("without a return statement");
  });
});

describe("values", () => {
  it("formats and compares captured values structurally", async () => {
    const { trace } = await tracePython({ source: "a = {'k': [1, (2, 3)], 's': {4}}\nb = {'k': [1, (2, 3)], 's': {4}}\nz = 0\n" });
    const ev = trace.events.find((e) => e.type === "line" && e.loc.line === 3) as TraceEvent;
    const a = ev.stack[0]?.locals.find(([k]) => k === "a")?.[1] as Value;
    const b = ev.stack[0]?.locals.find(([k]) => k === "b")?.[1] as Value;
    expect(formatValue(a, ev.heap, "python")).toBe("{'k': [1, (2, 3)], 's': {4}}");
    expect(valuesEqual(a, ev.heap, b, ev.heap)).toBe(true);
  });
});

describe("share links", () => {
  const payload = {
    v: 1 as const,
    language: "python" as const,
    source: "class Solution:\n    def f(self, x):\n        return x\n".repeat(5),
    mode: "function" as const,
    entry: "Solution.f",
    title: "T",
    test: { name: "c", args: ["[1,2]"], expected: "[1,2]", conversions: [], stdin: "" },
  };
  it("round-trips through compressed fragments", async () => {
    const tok = await encodeShare(payload);
    expect(tok.startsWith("z.")).toBe(true);
    const back = await decodeShare(tok);
    expect(back).toEqual(payload);
    expect(shareTokenFromHash(`#share=${tok}`)).toBe(tok);
  });
  it("rejects malformed or hostile payloads", async () => {
    await expect(decodeShare("z.@@@")).rejects.toThrow();
    await expect(decodeShare("q.abc")).rejects.toThrow();
    expect(() => validatePayload({ ...payload, language: "ruby" })).toThrow();
    expect(() => validatePayload({ ...payload, test: { args: [1] } })).toThrow();
  });
});

describe("diff regression", () => {
  it("a swap of both ends marks only those two cells as changed", () => {
    const h = {};
    const n = (v: number): Value => ({ t: "int", v });
    const d = diffSequence([1, 2, 3, 4, 5].map(n), h, 5, [5, 2, 3, 4, 1].map(n), h, 5);
    expect(d.status).toEqual(["changed", "same", "same", "same", "changed"]);
  });
});
