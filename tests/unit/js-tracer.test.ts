import { describe, expect, it } from "vitest";
import { instrument } from "../../src/adapters/javascript/instrument";
import { inspect } from "../../src/adapters/javascript/runtime";
import type { TraceEvent } from "../../src/trace/schema";
import { validateTrace } from "../../src/trace/validate";
import { local, show, signature, top, traceJs } from "../helpers";

/** Runs code WITHOUT instrumentation and captures console output — the semantic reference. */
function runPlain(src: string): string {
  let out = "";
  const con = { log: (...a: unknown[]) => (out += `${a.map((x) => inspect(x)).join(" ")}\n`) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("console", src)(con);
  return out;
}

const PROGRAMS: Record<string, string> = {
  closures: `function counter() { let c = 0; return { inc: () => ++c, get: function () { return c; } }; }
const k = counter(); k.inc(); k.inc(); console.log(k.get());`,
  classes: `class A { constructor(x) { this.x = x; } get double() { return this.x * 2; } static make() { return new A(3); } }
class B extends A { constructor() { super(5); this.y = this.x + 1; } sum() { return this.x + this.y; } }
const b = new B(); console.log(b.sum(), A.make().double);`,
  loops: `let s = 0; outer: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (j > i) continue outer; if (i === 4) break outer; s += j; } }
let w = 0; while (w < 3) w++; do { w--; } while (w > 1);
for (const [k, v] of Object.entries({ a: 1, b: 2 })) s += v;
for (const k in { x: 1, y: 2 }) s += k.length;
console.log(s, w);`,
  switches: `function f(x) { switch (x) { case 1: return "one"; case 2: { let y = "two"; return y; } default: return "many"; } }
console.log(f(1), f(2), f(3));`,
  exceptions: `function g(n) { if (n === 0) throw new RangeError("zero"); return 1 / n; }
let msg = ""; try { g(0); } catch (e) { msg = e.message; } finally { msg += "!"; }
try { null.x; } catch ({ name }) { msg += name; }
console.log(msg);`,
  generators: `function* gen(n) { for (let i = 0; i < n; i++) { const got = yield i * 2; if (got) n = got; } return "done"; }
const it = gen(3); const a = [it.next().value, it.next().value, it.next(5).value, it.next().value];
console.log(a.join(","), [...gen(2)].join(","));`,
  defaults: `function h({ a = 1, b } = {}, ...rest) { return a + (b ?? 0) + rest.length; }
const arrow = (x) => x * 2; const arrow2 = (x) => ({ v: x });
console.log(h(), h({ b: 2 }, 1, 2), arrow(4), arrow2(1).v);`,
  hoisting: `console.log(typeof later, hoisted()); function hoisted() { return "ok"; } var later = 1;`,
  thisBinding: `const o = { v: 7, m() { return [1].map(() => this.v)[0]; } }; console.log(o.m());`,
  recursion: `function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); } console.log(fib(10));`,
  sparse: `const arr = [1, , 3]; arr[5] = 6; console.log(arr.length, 1 in arr);`,
};

describe("JS instrumentation preserves semantics", () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    it(name, () => {
      const expected = runPlain(src);
      const { trace, summary } = traceJs({ source: src });
      expect(summary.status).toBe("completed");
      expect(trace.stdout).toBe(expected);
      expect(validateTrace(trace, src.split("\n").length)).toEqual([]);
    });
  }

  it("rejects reserved identifiers and modules with diagnostics", () => {
    expect(instrument("let __dr_x = 1;").diagnostics[0]?.kind).toBe("ReservedName");
    expect(instrument("with (o) {}").ok).toBe(false);
  });

  it("warns (does not fail) for async functions", () => {
    const r = instrument("async function f() { await 1; }");
    expect(r.ok).toBe(true);
    expect(r.diagnostics.some((d) => d.severity === "warning")).toBe(true);
  });

  it("reports syntax errors with positions", () => {
    const { summary } = traceJs({ source: "function (x {\n}" });
    expect(summary.status).toBe("syntax-error");
    expect(summary.diagnostics[0]).toMatchObject({ kind: "SyntaxError", line: 1 });
  });
});

describe("JS tracer: events and state", () => {
  it("aliasing: two bindings share one object id; mutation visible through both", () => {
    const src = "const a = [1, 2];\nconst b = a;\na[0] = 99;\nconst c = [99, 2];\n";
    const { trace } = traceJs({ source: src });
    const ev = trace.events.find((e) => e.type === "return") as TraceEvent;
    expect(local(ev, "a")).toEqual(local(ev, "b"));
    expect(local(ev, "c")).not.toEqual(local(ev, "a"));
    expect(show(ev, "b", "javascript")).toBe("[99, 2]");
  });

  it("line events are pre-statement; let bindings in TDZ are omitted", () => {
    const src = "let x = 1;\nx = 2;\nlet y = x;\n";
    const { trace } = traceJs({ source: src });
    const l2 = trace.events.find((e) => e.type === "line" && e.loc.line === 2) as TraceEvent;
    const l3 = trace.events.find((e) => e.type === "line" && e.loc.line === 3) as TraceEvent;
    expect(local(l2, "x")).toEqual({ t: "int", v: 1 });
    expect(local(l2, "y")).toBeUndefined(); // TDZ: not yet initialized
    expect(local(l3, "x")).toEqual({ t: "int", v: 2 });
  });

  it("call/return events with arguments and return values; recursion has independent frames", () => {
    const src = "function fact(n) {\n  if (n <= 1) return 1;\n  return n * fact(n - 1);\n}\nconst r = fact(3);\n";
    const { trace } = traceJs({ source: src });
    expect(validateTrace(trace, 5)).toEqual([]);
    const calls = trace.events.filter((e) => e.type === "call" && top(e).name === "fact");
    expect(calls.map((e) => local(e, "n"))).toEqual([3, 2, 1].map((v) => ({ t: "int", v })));
    expect(new Set(calls.map((e) => top(e).id)).size).toBe(3);
    const rets = trace.events.filter((e) => e.type === "return" && top(e).name === "fact").map((e) => e.returnValue);
    expect(rets).toEqual([1, 2, 6].map((v) => ({ t: "int", v })));
  });

  it("functions without return report undefined at the closing line", () => {
    const src = "function f() {\n  let t = 1;\n}\nf();\n";
    const { trace } = traceJs({ source: src });
    const ret = trace.events.find((e) => e.type === "return" && top(e).name === "f") as TraceEvent;
    expect(ret.returnValue).toEqual({ t: "undefined" });
    expect(ret.loc.line).toBe(3);
  });

  it("exceptions propagate frame by frame with unwinding returns, then the handler runs", () => {
    const src = "function f(x) {\n  return x.y.z;\n}\nfunction g() {\n  return f({});\n}\ntry {\n  g();\n} catch (e) {\n  var msg = e.name;\n}\n";
    const { trace, summary } = traceJs({ source: src });
    expect(summary.status).toBe("completed");
    const sig = signature(trace).filter((s) => !s.startsWith("line"));
    expect(sig).toEqual(["call:1", "call:4", "call:1", "exception:2", "return:2", "exception:5", "return:5", "exception:8", "return:10"]);
    expect(trace.events.find((e) => e.type === "exception")?.exception?.type).toBe("TypeError");
    expect(validateTrace(trace)).toEqual([]);
  });

  it("uncaught exceptions produce a terminal exception event with traceback", () => {
    const src = "const nums = [1];\nfunction bad() {\n  return nums[5].x;\n}\nbad();\n";
    const { trace, summary } = traceJs({ source: src });
    expect(summary.status).toBe("exception");
    expect(trace.last?.exception).toMatchObject({ type: "TypeError", uncaught: true, line: 3 });
    expect(trace.last?.exception?.traceback?.map((t) => t.name)).toEqual(["<module>", "bad"]);
  });

  it("generators suspend and resume with a stable frame id", () => {
    const src = "function* gen() {\n  yield 1;\n  yield 2;\n}\nconst out = [];\nfor (const v of gen()) out.push(v);\n";
    const { trace } = traceJs({ source: src });
    const g = trace.events.filter((e) => e.stack.length > 0 && top(e).name === "gen" && (e.type === "call" || e.type === "return"));
    expect(new Set(g.map((e) => top(e).id)).size).toBe(1);
    expect(g.filter((e) => e.yielded).map((e) => e.returnValue)).toEqual([{ t: "int", v: 1 }, { t: "int", v: 2 }]);
    expect(validateTrace(trace)).toEqual([]);
  });

  it("closures are reported separately from locals", () => {
    const src = "function outer() {\n  let count = 0;\n  function inc() {\n    count++;\n    return count;\n  }\n  return inc();\n}\nouter();\n";
    const { trace } = traceJs({ source: src });
    const ev = trace.events.find((e) => e.type === "return" && top(e).name === "inc") as TraceEvent;
    expect(top(ev).closure?.find(([k]) => k === "count")?.[1]).toEqual({ t: "int", v: 1 });
    expect(top(ev).locals.find(([k]) => k === "count")).toBeUndefined();
  });

  it("class methods expose `this`", () => {
    const src = "class P {\n  constructor(v) {\n    this.v = v;\n  }\n  get2() {\n    return this.v * 2;\n  }\n}\nnew P(4).get2();\n";
    const { trace } = traceJs({ source: src });
    const ev = trace.events.find((e) => e.type === "return" && top(e).name === "get2") as TraceEvent;
    expect(show(ev, "this", "javascript")).toBe("P(v=4)");
  });

  it("Maps, Sets, cycles and plain objects", () => {
    const src = "const m = new Map([[1, 'a']]);\nconst s = new Set([3]);\nconst o = { k: 1 };\no.self = o;\nconst done = true;\n";
    const { trace } = traceJs({ source: src });
    const ev = trace.events.find((e) => e.type === "line" && e.loc.line === 5) as TraceEvent;
    const m = ev.heap[(local(ev, "m") as { id: string }).id];
    const s = ev.heap[(local(ev, "s") as { id: string }).id];
    const o = ev.heap[(local(ev, "o") as { id: string }).id];
    expect(m?.kind).toBe("dict");
    expect(m?.typeName).toBe("Map");
    expect(s?.kind).toBe("set");
    expect(o?.kind === "object" ? o.attrs.find(([k]) => k === "self")?.[1] : null).toEqual(local(ev, "o"));
  });

  it("console output becomes stdout events", () => {
    const { trace } = traceJs({ source: "console.log('a', [1, 2]);\nlet x = 1;\nconsole.log({ x });\n" });
    expect(trace.stdout).toBe("a [ 1, 2 ]\n{ x: 1 }\n");
    expect(trace.events.filter((e) => e.type === "stdout").length).toBe(2);
  });

  it("event budget, time limit and stack limit stop execution and keep history", () => {
    const ev = traceJs({ source: "let i = 0;\nwhile (true) { i++; }\n", limits: { maxEvents: 200 } as never });
    expect(ev.summary.status).toBe("limit");
    expect(ev.trace.last?.limit?.kind).toBe("events");
    expect(ev.trace.length).toBe(201);
    const t = traceJs({ source: "while (true) {}\n", limits: { maxEvents: 1e9, timeoutMs: 200 } as never });
    expect(t.trace.last?.limit?.kind).toBe("time");
    const st = traceJs({ source: "function f(n) { return f(n + 1); }\nf(0);\n", limits: { maxStackDepth: 40 } as never });
    expect(st.trace.last?.limit?.kind).toBe("stack");
  });

  it("user catch blocks cannot swallow the abort", () => {
    const { summary } = traceJs({ source: "let i = 0;\nwhile (true) {\n  try { i++; } catch (e) {}\n}\n", limits: { maxEvents: 150 } as never });
    expect(summary.status).toBe("limit");
  });

  it("function mode: LeetCode `var fn = function` and class Solution entries", () => {
    const a = traceJs({ source: "var add = function (a, b) {\n  return a + b;\n};\n", mode: "function", entry: "add", args: ["2", "3"] });
    expect(a.summary.resultJson).toBe("5");
    const b = traceJs({ source: "class Solution {\n  add(a, b) {\n    return a + b;\n  }\n}\n", mode: "function", entry: "Solution.add", args: ["1", "1"] });
    expect(b.summary.resultJson).toBe("2");
    expect(b.trace.events[0]?.type).toBe("call");
  });

  it("linked-list conversion uses LeetCode's ListNode shape", () => {
    const src = "function rev(head) {\n  let prev = null;\n  while (head) {\n    const n = head.next;\n    head.next = prev;\n    prev = head;\n    head = n;\n  }\n  return prev;\n}\n";
    const { summary } = traceJs({ source: src, mode: "function", entry: "rev", args: ["[1,2,3]"], argConversions: ["linked-list"] });
    expect(summary.resultJson).toBe("[3,2,1]");
  });


  it("runs are isolated (fresh program scope each run)", () => {
    traceJs({ source: "var leak = 1;\n" });
    const { summary } = traceJs({ source: "console.log(leak);\n" });
    expect(summary.status).toBe("exception");
  });
});
