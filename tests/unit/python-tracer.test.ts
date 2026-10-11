import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/trace/schema";
import { validateTrace } from "../../src/trace/validate";
import { linesOf, local, show, signature, top, tracePython } from "../helpers";

const lines = (s: string): number => s.split("\n").length;

describe("Python tracer: identity, aliasing, mutation", () => {
  it("aliases share one object id and both reflect a mutation", async () => {
    const src = "a = [1, 2]\nb = a\na[0] = 99\nc = [99, 2]\n";
    const { trace } = await tracePython({ source: src });
    expect(validateTrace(trace, lines(src))).toEqual([]);
    const end = trace.events.find((e) => e.type === "return") as TraceEvent;
    const a = local(end, "a");
    const b = local(end, "b");
    const c = local(end, "c");
    expect(a?.t).toBe("ref");
    expect(a).toEqual(b);
    expect(c).not.toEqual(a); // equal contents, different identity
    expect(show(end, "b")).toBe("[99, 2]");
  });

  it("never mutates historical snapshots", async () => {
    const src = "a = [1, 2]\na[0] = 5\na.append(7)\n";
    const { trace } = await tracePython({ source: src });
    const at2 = trace.events.find((e) => e.type === "line" && e.loc.line === 2) as TraceEvent;
    const before = JSON.stringify(at2.heap);
    expect(show(at2, "a")).toBe("[1, 2]");
    const last = trace.events[trace.length - 2] as TraceEvent;
    expect(show(last, "a")).toBe("[5, 2, 7]");
    expect(JSON.stringify(at2.heap)).toBe(before);
    expect(Object.isFrozen(at2.heap)).toBe(true);
  });

  it("represents cycles and shared children without duplicating identity", async () => {
    const src = "x = [1]\nx.append(x)\nshared = [0]\npair = [shared, shared]\nd = {}\nd['self'] = d\n";
    const { trace } = await tracePython({ source: src });
    expect(validateTrace(trace)).toEqual([]);
    const ev = trace.events[trace.length - 2] as TraceEvent;
    const x = local(ev, "x");
    expect(x?.t).toBe("ref");
    const xo = ev.heap[(x as { id: string }).id];
    expect(xo?.kind).toBe("list");
    expect(xo && "items" in xo ? xo.items[1] : null).toEqual(x);
    const pair = ev.heap[(local(ev, "pair") as { id: string }).id];
    expect(pair && "items" in pair ? pair.items[0] : null).toEqual(pair && "items" in pair ? pair.items[1] : undefined);
    const d = ev.heap[(local(ev, "d") as { id: string }).id];
    expect(d?.kind).toBe("dict");
  });

  it("captures primitives, empty collections, tuples, sets, deque, Counter, defaultdict", async () => {
    const src = [
      "from collections import deque, Counter, defaultdict",
      "n = None",
      "t = (1, 'a')",
      "e = []",
      "s = {3}",
      "q = deque([1, 2])",
      "c = Counter('aab')",
      "dd = defaultdict(list)",
      "dd['k'].append(1)",
      "big = 2 ** 70",
      "f = float('inf')",
      "done = True",
    ].join("\n");
    const { trace } = await tracePython({ source: src });
    const ev = trace.events[trace.length - 2] as TraceEvent;
    expect(local(ev, "n")).toEqual({ t: "none" });
    expect(local(ev, "big")).toEqual({ t: "int", v: "1180591620717411303424", big: true });
    expect(local(ev, "f")).toEqual({ t: "float", v: "inf" });
    const kinds = Object.fromEntries(["t", "e", "s", "q", "c", "dd"].map((k) => [k, ev.heap[(local(ev, k) as { id: string }).id]]));
    expect(kinds.t?.kind).toBe("tuple");
    expect(kinds.e && "length" in kinds.e ? kinds.e.length : -1).toBe(0);
    expect(kinds.s?.kind).toBe("set");
    expect(kinds.q?.kind).toBe("deque");
    expect(kinds.c?.typeName).toBe("Counter");
    expect(kinds.dd?.kind === "dict" ? kinds.dd.defaultFactory : "").toBe("list");
  });
});

describe("Python tracer: limits and truncation", () => {
  it("truncates large collections visibly", async () => {
    const { trace } = await tracePython({ source: "xs = list(range(500))\ny = 1\n", limits: { maxItems: 50 } as never });
    const ev = trace.events.find((e) => e.type === "line" && e.loc.line === 2) as TraceEvent;
    const xs = ev.heap[(local(ev, "xs") as { id: string }).id];
    expect(xs?.kind).toBe("list");
    if (xs?.kind === "list") {
      expect(xs.items.length).toBe(50);
      expect(xs.length).toBe(500);
      expect(xs.truncated).toEqual({ reason: "items", shown: 50, total: 500 });
    }
  });

  it("marks objects beyond the depth limit as elided", async () => {
    const src = "a = []\ncur = a\nfor _ in range(30):\n    nxt = []\n    cur.append(nxt)\n    cur = nxt\nz = 0\n";
    const { trace } = await tracePython({ source: src, limits: { maxDepth: 5 } as never });
    const ev = trace.events.find((e) => e.type === "line" && e.loc.line === 7) as TraceEvent;
    const elided = Object.values(ev.heap).filter((o) => o.kind === "elided");
    expect(elided.length).toBeGreaterThan(0);
    expect(elided[0]?.kind === "elided" ? elided[0].reason : "").toBe("depth");
    expect(validateTrace(trace)).toEqual([]);
  });

  it("truncates long strings with the original length", async () => {
    const { trace } = await tracePython({ source: "s = 'x' * 1000\ny = 1\n", limits: { maxString: 10 } as never });
    const ev = trace.events.find((e) => e.loc.line === 2 && e.type === "line") as TraceEvent;
    expect(local(ev, "s")).toEqual({ t: "str", v: "xxxxxxxxxx", len: 1000 });
  });

  it("stops at the event budget and keeps the recorded history", async () => {
    const { trace, summary } = await tracePython({ source: "i = 0\nwhile True:\n    i += 1\n", limits: { maxEvents: 300 } as never });
    expect(summary.status).toBe("limit");
    expect(trace.last?.type).toBe("limit");
    expect(trace.last?.limit?.kind).toBe("events");
    expect(trace.length).toBe(301);
    expect(validateTrace(trace)).toEqual([]);
    // last valid state is inspectable
    expect(local(trace.last as TraceEvent, "i")?.t).toBe("int");
  });

  it("stops on the wall-clock limit (time) separately from the event budget", async () => {
    const { trace, summary } = await tracePython({ source: "while True:\n    pass\n", limits: { maxEvents: 10_000_000, timeoutMs: 300 } as never });
    expect(summary.status).toBe("limit");
    expect(trace.last?.limit?.kind).toBe("time");
  });

  it("stops deep recursion at the stack limit", async () => {
    const { trace, summary } = await tracePython({ source: "def f(n):\n    return f(n + 1)\nf(0)\n", limits: { maxStackDepth: 50 } as never });
    expect(summary.status).toBe("limit");
    expect(trace.last?.limit?.kind).toBe("stack");
    expect(Math.max(...trace.events.map((e) => e.stack.length))).toBeLessThanOrEqual(52);
  });

  it("does not let `except Exception` swallow the abort", async () => {
    const src = "i = 0\nwhile True:\n    try:\n        i += 1\n    except Exception:\n        pass\n";
    const { summary } = await tracePython({ source: src, limits: { maxEvents: 200 } as never });
    expect(summary.status).toBe("limit");
  });
});

describe("Python tracer: event semantics", () => {
  it("line events are pre-line: state does not yet include the line's effect", async () => {
    const { trace } = await tracePython({ source: "x = 1\nx = 2\ny = x\n" });
    const l2 = trace.events.find((e) => e.type === "line" && e.loc.line === 2) as TraceEvent;
    const l3 = trace.events.find((e) => e.type === "line" && e.loc.line === 3) as TraceEvent;
    expect(local(l2, "x")).toEqual({ t: "int", v: 1 });
    expect(local(l3, "x")).toEqual({ t: "int", v: 2 });
    expect(local(l3, "y")).toBeUndefined();
  });

  it("call/return events bracket each frame with arguments and return value", async () => {
    const src = "def add(a, b):\n    s = a + b\n    return s\nr = add(2, 3)\n";
    const { trace } = await tracePython({ source: src });
    expect(signature(trace)).toEqual(["call:1", "line:1", "line:4", "call:1", "line:2", "line:3", "return:3", "return:4"]);
    const call = trace.events.filter((e) => e.type === "call")[1] as TraceEvent;
    expect(top(call).name).toBe("add");
    expect(top(call).args).toEqual(["a", "b"]);
    expect(local(call, "a")).toEqual({ t: "int", v: 2 });
    const ret = trace.events.find((e) => e.type === "return" && top(e).name === "add") as TraceEvent;
    expect(ret.returnValue).toEqual({ t: "int", v: 5 });
  });

  it("recursion: independent frames per call, LIFO returns", async () => {
    const src = "def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\nr = fact(4)\n";
    const { trace } = await tracePython({ source: src });
    expect(validateTrace(trace, lines(src))).toEqual([]);
    const calls = trace.events.filter((e) => e.type === "call" && top(e).name === "fact");
    expect(calls.map((e) => local(e, "n"))).toEqual([4, 3, 2, 1].map((v) => ({ t: "int", v })));
    expect(new Set(calls.map((e) => top(e).id)).size).toBe(4);
    const rets = trace.events.filter((e) => e.type === "return" && top(e).name === "fact").map((e) => e.returnValue);
    expect(rets).toEqual([1, 2, 6, 24].map((v) => ({ t: "int", v })));
    const deepest = trace.events.find((e) => e.stack.length === 5) as TraceEvent;
    expect(deepest.stack.map((f) => f.name)).toEqual(["<module>", "fact", "fact", "fact", "fact"]);
  });

  it("exceptions: propagation through frames, unwinding returns, handler resumes", async () => {
    const src = "def f(x):\n    return 10 // x\ndef g():\n    return f(0)\ntry:\n    g()\nexcept ZeroDivisionError as e:\n    msg = str(e)\n";
    const { trace, summary } = await tracePython({ source: src });
    expect(summary.status).toBe("completed");
    const sig = signature(trace).filter((s) => !s.startsWith("line"));
    // call events are located at the `def` line of the entered function
    expect(sig).toEqual(["call:1", "call:3", "call:1", "exception:2", "return:2", "exception:4", "return:4", "exception:6", "return:8"]);
    const unwinds = trace.events.filter((e) => e.type === "return" && e.unwind);
    expect(unwinds.length).toBe(2);
    expect(unwinds.every((e) => !e.returnValue)).toBe(true);
    const exc = trace.events.find((e) => e.type === "exception") as TraceEvent;
    expect(exc.exception).toMatchObject({ type: "ZeroDivisionError", line: 2 });
    expect(validateTrace(trace)).toEqual([]);
  });

  it("uncaught exceptions end with a terminal exception event and keep prior history", async () => {
    const src = "nums = [1, 2]\ntotal = 0\nfor i in range(3):\n    total += nums[i]\n";
    const { trace, summary } = await tracePython({ source: src });
    expect(summary.status).toBe("exception");
    const last = trace.last as TraceEvent;
    expect(last.type).toBe("exception");
    expect(last.exception).toMatchObject({ type: "IndexError", uncaught: true, line: 4 });
    expect(last.stack).toEqual([]);
    // the raise point keeps the full state
    const raise = trace.events.find((e) => e.type === "exception" && !e.exception?.uncaught) as TraceEvent;
    expect(local(raise, "i")).toEqual({ t: "int", v: 2 });
    expect(local(raise, "total")).toEqual({ t: "int", v: 3 });
    expect(local(last, "total")).toEqual({ t: "int", v: 3 }); // final globals
  });

  it("generators: suspend at yield (yielded: true), resume with the same frame id", async () => {
    const src = "def gen():\n    yield 1\n    yield 2\nout = []\nfor v in gen():\n    out.append(v)\n";
    const { trace } = await tracePython({ source: src });
    const genEvents = trace.events.filter((e) => e.stack.length > 0 && top(e).name === "gen" && (e.type === "call" || e.type === "return"));
    const ids = new Set(genEvents.map((e) => top(e).id));
    expect(ids.size).toBe(1);
    const yields = genEvents.filter((e) => e.type === "return" && e.yielded).map((e) => e.returnValue);
    expect(yields).toEqual([{ t: "int", v: 1 }, { t: "int", v: 2 }]);
    const final = genEvents.filter((e) => e.type === "return" && !e.yielded);
    expect(final.length).toBe(1);
    expect(top(genEvents[0] as TraceEvent).isGenerator).toBe(true);
    expect(validateTrace(trace)).toEqual([]);
  });

  it("stdout events are recorded with accumulated output", async () => {
    const { trace } = await tracePython({ source: "print('a')\nx = 1\nprint('b', x)\n" });
    const outs = trace.events.filter((e) => e.type === "stdout");
    expect(outs.length).toBe(2);
    expect(trace.stdout).toBe("a\nb 1\n");
    expect(trace.stdoutAt((outs[0] as TraceEvent).index)).toBe("a\n");
    expect(outs[0]?.loc.line).toBe(1);
  });

  it("variables appear, change and leave scope; frames disappear after return", async () => {
    const src = "def f():\n    t = 1\n    return t\nf()\nz = 2\n";
    const { trace } = await tracePython({ source: src });
    const inF = trace.events.filter((e) => e.stack.length > 0 && top(e).name === "f");
    expect(local(inF[0] as TraceEvent, "t")).toBeUndefined();
    expect(local(inF[inF.length - 1] as TraceEvent, "t")).toEqual({ t: "int", v: 1 });
    const afterLine5 = trace.events.find((e) => e.type === "line" && e.loc.line === 5) as TraceEvent;
    expect(afterLine5.stack.map((f) => f.name)).toEqual(["<module>"]);
  });

  it("nested functions and closures show captured variables", async () => {
    const src = "def outer():\n    count = 0\n    def inc():\n        nonlocal count\n        count += 1\n        return count\n    inc()\n    return inc()\nr = outer()\n";
    const { trace } = await tracePython({ source: src });
    const incLine = trace.events.filter((e) => e.type === "return" && top(e).name === "inc");
    expect(incLine.map((e) => e.returnValue)).toEqual([{ t: "int", v: 1 }, { t: "int", v: 2 }]);
    expect(local(incLine[0] as TraceEvent, "count")).toEqual({ t: "int", v: 1 });
  });
});

describe("Python tracer: modes and work-in-progress code", () => {
  it("function mode: LeetCode Solution class with explicit arguments", async () => {
    const src = "class Solution:\n    def add(self, a, b):\n        return a + b\n";
    const { trace, summary } = await tracePython({ source: src, mode: "function", entry: "Solution.add", args: ["2", "40"] });
    expect(summary.resultJson).toBe("42");
    expect(trace.last?.type).toBe("complete");
    expect(trace.last?.result).toEqual({ t: "int", v: 42 });
    expect(trace.events[0]?.type).toBe("call");
    expect(top(trace.events[0] as TraceEvent).name).toBe("add");
  });

  it("unfinished code with a missing return returns the real None", async () => {
    const src = "class Solution:\n    def f(self, nums):\n        total = 0\n        for n in nums:\n            total += n\n        # TODO return\n";
    const { trace, summary } = await tracePython({ source: src, mode: "function", entry: "Solution.f", args: ["[1,2,3]"] });
    expect(summary.status).toBe("completed");
    expect(summary.resultJson).toBe("null");
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    expect(ret.returnValue).toEqual({ t: "none" });
    expect(local(ret, "total")).toEqual({ t: "int", v: 6 });
  });

  it("empty helper / pass bodies run fine", async () => {
    const src = "def helper(x):\n    pass\ndef solve(nums):\n    helper(nums)\n    return len(nums)\n";
    const { summary } = await tracePython({ source: src, mode: "function", entry: "solve", args: ["[1]"] });
    expect(summary.resultJson).toBe("1");
  });

  it("linked-list and binary-tree argument conversion", async () => {
    const src = "class Solution:\n    def f(self, head, root):\n        return [head.next.val, root.left.val]\n";
    const { summary } = await tracePython({ source: src, mode: "function", entry: "Solution.f", args: ["[1,2,3]", "[5,4,null,3]"], argConversions: ["linked-list", "binary-tree"] });
    expect(summary.resultJson).toBe("[2, 4]");
  });

  it("returned linked lists are compared as arrays", async () => {
    const src = "class Solution:\n    def f(self, head):\n        return head\n";
    const { summary } = await tracePython({ source: src, mode: "function", entry: "Solution.f", args: ["[1,2,3]"], argConversions: ["linked-list"] });
    expect(summary.resultJson).toBe("[1, 2, 3]");
  });

  it("syntax errors are reported with a location and no trace", async () => {
    const { trace, summary } = await tracePython({ source: "def f(:\n    pass\n" });
    expect(summary.status).toBe("syntax-error");
    expect(summary.diagnostics[0]).toMatchObject({ kind: "SyntaxError", line: 1 });
    expect(trace.length).toBe(0);
  });

  it("fragment mode runs selected lines with the provided initial state at editor line numbers", async () => {
    const src = "    for i in range(2, len(nums)):\n        dp[i] = dp[i - 1] + dp[i - 2]\n";
    const { trace, summary } = await tracePython({
      source: src,
      mode: "fragment",
      fragment: { initialState: '{"nums": [0,0,0,0], "dp": [1, 1, 0, 0]}', setup: "", startLine: 10 },
    });
    expect(summary.status).toBe("completed");
    expect(summary.harnessDescription).toContain("nums, dp");
    expect(new Set(linesOf(trace))).toEqual(new Set([10, 11]));
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    expect(top(ret).name).toBe("<fragment>");
    expect(show(ret, "dp")).toBe("[1, 1, 2, 3]");
  });

  it("fragment mode: missing variables raise a real NameError (no invented state)", async () => {
    const { summary, trace } = await tracePython({ source: "x = y + 1\n", mode: "fragment", fragment: { initialState: "{}", setup: "", startLine: 1 } });
    expect(summary.status).toBe("exception");
    expect(trace.last?.exception?.type).toBe("NameError");
  });

  it("fragment special initial values build tuples/sets/deques/linked lists", async () => {
    const { trace } = await tracePython({
      source: "a = head.next.val\nb = len(seen)\nc = q[0]\n",
      mode: "fragment",
      fragment: { initialState: '{"head": {"$linkedList": [1,2]}, "seen": {"$set": [[0,1],[0,1]]}, "q": {"$deque": [7]}}', setup: "", startLine: 1 },
    });
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    expect(local(ret, "a")).toEqual({ t: "int", v: 2 });
    expect(local(ret, "b")).toEqual({ t: "int", v: 1 });
    expect(local(ret, "c")).toEqual({ t: "int", v: 7 });
  });

  it("script mode supports stdin", async () => {
    const { trace } = await tracePython({ source: "name = input()\nprint('hi', name)\n", stdin: "ada\n" });
    expect(trace.stdout).toBe("hi ada\n");
  });

  it("runs are isolated: globals from one run are not visible in the next", async () => {
    await tracePython({ source: "leak = 1\n" });
    const { summary, trace } = await tracePython({ source: "print(leak)\n" });
    expect(summary.status).toBe("exception");
    expect(trace.last?.exception?.type).toBe("NameError");
  });
});

describe("Python static analysis", () => {
  it("detects Solution methods, params, annotations and subscript accesses", async () => {
    const { pythonRuntime } = await import("../helpers");
    const rt = await pythonRuntime();
    const a = rt.analyze(
      "import heapq\nclass Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        h = []\n        heapq.heappush(h, 1)\n        for i, x in enumerate(nums):\n            nums[i] = grid[r][c]\n        return []\n    def _helper(self):\n        pass\n",
    );
    expect(a.ok).toBe(true);
    expect(a.entryCandidates).toEqual(["Solution.twoSum"]);
    const fn = a.functions.find((f) => f.qualname === "Solution.twoSum");
    expect(fn?.params).toEqual([
      { name: "nums", annotation: "List[int]" },
      { name: "target", annotation: "int" },
    ]);
    expect(a.heapBases).toEqual(["h"]);
    expect(a.accesses.find((x) => x.base === "nums" && x.write)).toMatchObject({ line: 7, indices: ["i"], kind: "subscript" });
    expect(a.accesses.find((x) => x.base === "grid")).toMatchObject({ indices: ["r", "c"], indexNames: [["r"], ["c"]], write: false });
    expect(a.accesses.find((x) => x.base === "nums" && x.kind === "loop")).toMatchObject({ indices: ["i"] });
  });

  it("reports syntax errors with positions", async () => {
    const { pythonRuntime } = await import("../helpers");
    const rt = await pythonRuntime();
    const a = rt.analyze("for i in range(3)\n    pass\n");
    expect(a.ok).toBe(false);
    expect(a.diagnostics[0]).toMatchObject({ kind: "SyntaxError", line: 1 });
  });
});
