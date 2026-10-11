import { describe, expect, it } from "vitest";
import type { Language, TraceEvent } from "../../src/trace/schema";
import { isTerminal } from "../../src/trace/store";
import { validateTrace } from "../../src/trace/validate";
import { local, top, traceLang, type Traced } from "../helpers";

/**
 * The adapter contract: every language adapter must produce traces that pass
 * validateTrace and follow the same event conventions, so one frontend can
 * visualize all of them. Equivalent programs are run in both languages.
 */

interface Case {
  name: string;
  py: string;
  js: string;
  entry?: string;
  args?: string[];
}

const CASES: Case[] = [
  {
    name: "loop + mutation",
    py: "def f(nums):\n    total = 0\n    for i in range(len(nums)):\n        nums[i] = nums[i] * 2\n        total += nums[i]\n    return total\n",
    js: "function f(nums) {\n  let total = 0;\n  for (let i = 0; i < nums.length; i++) {\n    nums[i] = nums[i] * 2;\n    total += nums[i];\n  }\n  return total;\n}\n",
    entry: "f",
    args: ["[1, 2, 3]"],
  },
  {
    name: "recursion",
    py: "def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n",
    js: "function fib(n) {\n  if (n < 2) return n;\n  return fib(n - 1) + fib(n - 2);\n}\n",
    entry: "fib",
    args: ["5"],
  },
  {
    name: "exception caught",
    py: "def f(xs):\n    try:\n        return xs[10]\n    except Exception:\n        return -1\n",
    js: "function f(xs) {\n  try {\n    if (xs[10] === undefined) throw new RangeError('oob');\n    return xs[10];\n  } catch (e) {\n    return -1;\n  }\n}\n",
    entry: "f",
    args: ["[1]"],
  },
  {
    name: "aliasing",
    py: "def f():\n    a = [1, 2]\n    b = a\n    b.append(3)\n    return a\n",
    js: "function f() {\n  const a = [1, 2];\n  const b = a;\n  b.push(3);\n  return a;\n}\n",
    entry: "f",
    args: [],
  },
];

function checkContract(t: Traced, src: string): void {
  const { trace } = t;
  // 1. schema invariants
  expect(validateTrace(trace, src.split("\n").length)).toEqual([]);
  // 2. exactly one terminal event, last
  expect(trace.events.filter(isTerminal).length).toBe(1);
  expect(isTerminal(trace.last as TraceEvent)).toBe(true);
  // 3. calls and returns balance (every entered frame is exited or the run ended)
  const calls = trace.events.filter((e) => e.type === "call" && !e.stack[e.stack.length - 1]?.isGenerator).length;
  const rets = trace.events.filter((e) => e.type === "return" && !e.yielded).length;
  expect(rets).toBe(calls);
  // 4. a call event's top frame is new and has its args bound
  for (const e of trace.events.filter((x) => x.type === "call")) {
    const f = top(e);
    for (const a of f.args) if (a !== "self" && a !== "this") expect(local(e, a)).toBeDefined();
  }
  // 5. depth changes by at most one between consecutive non-terminal events
  for (let i = 1; i < trace.length; i++) {
    const a = trace.events[i - 1] as TraceEvent;
    const b = trace.events[i] as TraceEvent;
    if (isTerminal(b)) continue;
    expect(Math.abs(b.stack.length - a.stack.length)).toBeLessThanOrEqual(1);
  }
  // 6. first event of function mode is the entry call
  expect(trace.events[0]?.type).toBe("call");
}

describe("adapter conformance", () => {
  for (const c of CASES) {
    for (const lang of ["python", "javascript"] as Language[]) {
      it(`${c.name} (${lang})`, async () => {
        const src = lang === "python" ? c.py : c.js;
        const t = await traceLang(lang, { source: src, mode: "function", entry: c.entry, args: c.args });
        expect(t.summary.status).toBe("completed");
        checkContract(t, src);
      });
    }
  }

  it("equivalent programs produce the same results and the same call structure", async () => {
    for (const c of CASES) {
      const py = await traceLang("python", { source: c.py, mode: "function", entry: c.entry, args: c.args });
      const js = await traceLang("javascript", { source: c.js, mode: "function", entry: c.entry, args: c.args });
      expect(JSON.parse(py.summary.resultJson ?? "null")).toEqual(JSON.parse(js.summary.resultJson ?? "null"));
      const shape = (t: Traced): string[] => t.trace.events.filter((e) => e.type === "call" || (e.type === "return" && !e.unwind)).map((e) => `${e.type}:${e.stack.length}`);
      if (c.name !== "exception caught") expect(shape(py)).toEqual(shape(js));
    }
  });

  it("aliasing is represented identically: one object referenced twice", async () => {
    for (const lang of ["python", "javascript"] as Language[]) {
      const c = CASES.find((x) => x.name === "aliasing") as Case;
      const { trace } = await traceLang(lang, { source: lang === "python" ? c.py : c.js, mode: "function", entry: "f", args: [] });
      const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
      const a = local(ret, "a");
      expect(a?.t).toBe("ref");
      expect(local(ret, "b")).toEqual(a);
      expect(ret.returnValue).toEqual(a);
    }
  });

  it("limit events carry the same kinds in both adapters", async () => {
    const py = await traceLang("python", { source: "while True:\n    pass\n", limits: { maxEvents: 50 } as never });
    const js = await traceLang("javascript", { source: "while (true) {}\n", limits: { maxEvents: 50 } as never });
    expect(py.trace.last?.limit?.kind).toBe("events");
    expect(js.trace.last?.limit?.kind).toBe("events");
    expect(py.trace.length).toBe(js.trace.length);
  });
});
