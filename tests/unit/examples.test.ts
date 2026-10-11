import { describe, expect, it } from "vitest";
import { EXAMPLES, exampleById, type Example } from "../../src/examples";
import * as nav from "../../src/trace/navigation";
import type { TraceEvent, Value } from "../../src/trace/schema";
import type { Trace } from "../../src/trace/store";
import { validateTrace } from "../../src/trace/validate";
import { toPlain } from "../../src/trace/values";
import { local, top, traceLang, type Traced } from "../helpers";

/**
 * Every built-in example runs through its real adapter. Assertions cover
 * intermediate states and event ordering, not only the final answer.
 */

async function runExample(id: string, testIndex = 0): Promise<Traced & { ex: Example }> {
  const ex = exampleById(id) as Example;
  const t = ex.tests[testIndex];
  const r = await traceLang(ex.language, {
    source: ex.source,
    mode: ex.mode,
    entry: ex.entry,
    args: t?.args,
    argConversions: t?.conversions,
    stdin: t?.stdin,
    ...(ex.fragment ? { fragment: { initialState: ex.fragment.initialState, setup: ex.fragment.setup, startLine: ex.fragment.startLine } } : {}),
  });
  return { ...r, ex };
}

const plain = (ev: TraceEvent, name: string): unknown => {
  const v = local(ev, name);
  return v === undefined ? undefined : toPlain(v, ev.heap);
};

/** Values of `name` at each line event for `line`, in order. */
function atLine(trace: Trace, line: number, name: string): unknown[] {
  return trace.events.filter((e) => e.type === "line" && e.loc.line === line).map((e) => plain(e, name));
}

function linkedFrom(ev: TraceEvent, v: Value | undefined): number[] {
  const out: number[] = [];
  const seen = new Set<string>();
  let cur = v;
  while (cur && cur.t === "ref" && !seen.has(cur.id) && out.length < 50) {
    seen.add(cur.id);
    const o = ev.heap[cur.id];
    if (!o || o.kind !== "object") break;
    const val = o.attrs.find(([k]) => k === "val")?.[1];
    out.push(val && val.t === "int" ? (val.v as number) : NaN);
    cur = o.attrs.find(([k]) => k === "next")?.[1];
  }
  return out;
}

describe("all examples: final results and trace invariants", () => {
  for (const ex of EXAMPLES) {
    for (let ti = 0; ti < Math.max(1, ex.tests.length); ti++) {
      const test = ex.tests[ti];
      it(`${ex.id}${test ? ` — ${test.name}` : ""}`, async () => {
        const { trace, summary } = await runExample(ex.id, ti);
        expect(validateTrace(trace, ex.source.split("\n").length)).toEqual([]);
        expect(trace.finished).toBe(true);
        if (test?.expected !== undefined) {
          const got = JSON.parse(summary.resultJson ?? "null");
          if (ex.stage === "complete") expect(got).toEqual(JSON.parse(test.expected));
          else expect(got).not.toEqual(JSON.parse(test.expected)); // unfinished/buggy variants really differ
        }
        // replay consistency: walking backward visits exactly the forward states
        const forward = trace.events.map((e) => JSON.stringify([e.type, e.loc, e.stack, e.heap]));
        const backward: string[] = [];
        let i = trace.length - 1;
        for (;;) {
          const e = trace.events[i] as TraceEvent;
          backward.push(JSON.stringify([e.type, e.loc, e.stack, e.heap]));
          const r = nav.stepBack(trace, i);
          if (!r.found) break;
          i = r.index;
        }
        expect(backward.reverse()).toEqual(forward);
      });
    }
  }
});

describe("example intermediate states", () => {
  it("Two Sum: `seen` grows one entry per iteration; i/num advance together", async () => {
    const { trace } = await runExample("two-sum");
    expect(atLine(trace, 7, "i")).toEqual([0, 1]);
    expect(atLine(trace, 7, "num")).toEqual([2, 7]);
    expect(atLine(trace, 7, "seen")).toEqual([{}, { 2: 0 }]);
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    expect(plain(ret, "need")).toBe(2);
    expect(toPlain(ret.returnValue as Value, ret.heap)).toEqual([0, 1]);
  });

  it("Two Sum (unfinished): runs every iteration and returns None", async () => {
    const { trace, summary } = await runExample("two-sum-unfinished");
    expect(summary.resultJson).toBe("null");
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    expect(ret.returnValue).toEqual({ t: "none" });
    expect(plain(ret, "seen")).toEqual({ 2: 0, 7: 1, 11: 2, 15: 3 });
  });

  it("Reverse array: pointers converge and each swap changes two cells", async () => {
    const { trace } = await runExample("reverse-array");
    expect(atLine(trace, 4, "l")).toEqual([0, 1, 2]);
    expect(atLine(trace, 4, "r")).toEqual([4, 3, 2]);
    expect(atLine(trace, 4, "nums")).toEqual([
      [1, 2, 3, 4, 5],
      [5, 2, 3, 4, 1],
      [5, 4, 3, 2, 1],
    ]);
  });

  it("Reverse array (buggy): r never moves", async () => {
    const { trace } = await runExample("reverse-array-buggy");
    expect(new Set(atLine(trace, 4, "r"))).toEqual(new Set([4]));
    expect(atLine(trace, 4, "l")).toEqual([0, 1, 2, 3, 4]);
  });

  it("Sliding window: left jumps past repeats; best is monotone", async () => {
    const { trace } = await runExample("sliding-window");
    const lefts = atLine(trace, 11, "left") as number[];
    expect(lefts).toEqual([0, 0, 0, 1, 2, 3, 5, 7]);
    const bests = atLine(trace, 7, "best") as number[];
    expect(bests).toEqual([...bests].sort((a, b) => a - b));
  });

  it("Grid BFS: cells are dequeued in nondecreasing distance; dist is final", async () => {
    const { trace, summary } = await runExample("grid-bfs");
    expect(summary.resultJson).toBe("4");
    const pops = trace.events.filter((e) => e.type === "line" && e.loc.line === 12).map((e) => [plain(e, "r"), plain(e, "c")] as [number, number]);
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    const dist = plain(ret, "dist") as number[][];
    expect(dist).toEqual([
      [0, 1, 2],
      [-1, -1, 3],
      [6, 5, 4],
    ]);
    const d = pops.map(([r, c]) => (dist[r] as number[])[c] as number);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(pops[0]).toEqual([0, 0]);
    // once set, a distance never changes
    const firstSet = new Map<string, number>();
    for (const e of trace.events) {
      const g = plain(e, "dist") as number[][] | undefined;
      if (!g) continue;
      g.forEach((row, r) =>
        row.forEach((v, c) => {
          if (v === -1) return;
          const k = `${r},${c}`;
          if (firstSet.has(k)) expect(firstSet.get(k)).toBe(v);
          else firstSet.set(k, v);
        }),
      );
    }
  });

  it("Recursive DFS: call/return nesting and visited growth order", async () => {
    const { trace } = await runExample("dfs-components");
    const dfsCalls = trace.events.filter((e) => e.type === "call" && top(e).name === "dfs").map((e) => plain(e, "node"));
    expect(dfsCalls).toEqual([0, 1, 2, 3, 4]);
    const order = trace.events.filter((e) => (e.type === "call" || e.type === "return") && e.stack.length > 0 && top(e).name === "dfs").map((e) => `${e.type}(${plain(e, "node")})`);
    expect(order).toEqual(["call(0)", "call(1)", "call(2)", "return(2)", "return(1)", "return(0)", "call(3)", "call(4)", "return(4)", "return(3)"]);
    expect(trace.maxDepth).toBe(4);
  });

  it("House Robber: dp[i] is written in order from dp[i-1], dp[i-2]", async () => {
    const { trace } = await runExample("house-robber");
    expect(atLine(trace, 10, "dp")).toEqual([
      [0, 1, 0, 0, 0],
      [0, 1, 2, 0, 0],
      [0, 1, 2, 4, 0],
    ]);
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    expect(plain(ret, "dp")).toEqual([0, 1, 2, 4, 4]);
  });

  it("House Robber (unfinished): the table never changes after the base cases", async () => {
    const { trace, summary } = await runExample("house-robber-unfinished");
    expect(summary.resultJson).toBe("0");
    for (const v of atLine(trace, 8, "dp")) expect(v).toEqual([0, 2, 0, 0, 0, 0]);
  });

  it("LCS: cells are filled row by row; final table", async () => {
    const { trace } = await runExample("lcs");
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    expect(plain(ret, "dp")).toEqual([
      [0, 0, 0, 0],
      [0, 1, 1, 1],
      [0, 1, 1, 1],
      [0, 1, 2, 2],
      [0, 1, 2, 2],
      [0, 1, 2, 3],
    ]);
    const order = trace.events.filter((e) => e.type === "line" && (e.loc.line === 8 || e.loc.line === 10)).map((e) => `${plain(e, "i")},${plain(e, "j")}`);
    expect(order.slice(0, 4)).toEqual(["1,1", "1,2", "1,3", "2,1"]);
    expect(order.length).toBe(15);
  });

  it("Kth largest: heap property holds at every step and size never exceeds k after popping", async () => {
    const { trace } = await runExample("kth-largest");
    for (const e of trace.events) {
      const h = plain(e, "heap") as number[] | undefined;
      if (!h) continue;
      for (let i = 1; i < h.length; i++) expect(h[Math.floor((i - 1) / 2)] as number).toBeLessThanOrEqual(h[i] as number);
    }
    expect(atLine(trace, 7, "heap").slice(-1)[0]).toEqual([5, 6]);
    for (const h of atLine(trace, 8, "heap") as number[][]) expect(h.length).toBeLessThanOrEqual(2);
  });

  it("Merge intervals: merged list grows or extends its last interval", async () => {
    const { trace } = await runExample("merge-intervals");
    expect(atLine(trace, 8, "merged")).toEqual([[], [[1, 3]], [[1, 6]], [[1, 6], [8, 10]]]);
  });

  it("Reverse linked list: node identities are stable while links flip", async () => {
    const { trace } = await runExample("reverse-linked-list");
    const first = trace.events[0] as TraceEvent;
    const headId = (local(first, "head") as { id: string }).id;
    const iterations = trace.events.filter((e) => e.type === "line" && e.loc.line === 12);
    expect(iterations.map((e) => linkedFrom(e, local(e, "prev")))).toEqual([[], [1], [2, 1], [3, 2, 1], [4, 3, 2, 1], [5, 4, 3, 2, 1]]);
    expect(iterations.map((e) => linkedFrom(e, local(e, "curr")))).toEqual([[1, 2, 3, 4, 5], [2, 3, 4, 5], [3, 4, 5], [4, 5], [5], []]);
    const last = iterations[iterations.length - 1] as TraceEvent;
    expect((local(last, "head") as { id: string }).id).toBe(headId); // same node object
  });

  it("Reverse linked list (unfinished): curr becomes None after the first iteration", async () => {
    const { trace } = await runExample("reverse-linked-list-unfinished");
    const checks = trace.events.filter((e) => e.type === "line" && e.loc.line === 7);
    expect(checks.map((e) => local(e, "curr")?.t)).toEqual(["ref", "none"]);
  });

  it("Inorder traversal: visit order and output order", async () => {
    const { trace } = await runExample("inorder-traversal");
    const appends = trace.events.filter((e) => e.type === "line" && e.loc.line === 12).map((e) => plain(e, "out"));
    expect(appends.map((o) => (o as number[]).length)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const visits = trace.events.filter((e) => e.type === "call" && top(e).name === "visit");
    expect(visits.length).toBe(15); // 7 nodes + 8 None children
    expect(trace.maxDepth).toBe(5);
  });

  it("Fragment example: runs only the selected lines with the provided state", async () => {
    const { trace, summary } = await runExample("fragment-dp-transition");
    expect(summary.status).toBe("completed");
    const ret = trace.events.find((e) => e.type === "return") as TraceEvent;
    expect(plain(ret, "dp")).toEqual([0, 2, 7, 11, 11, 12]);
  });

  it("Generator script: yields and output", async () => {
    const { trace } = await runExample("generator-script");
    expect(trace.stdout).toBe("tick 3\ntick 2\ntick 1\nliftoff\n");
    const yields = trace.events.filter((e) => e.yielded).map((e) => toPlain(e.returnValue as Value, e.heap));
    expect(yields).toEqual([3, 2, 1]);
  });

  it("JS Two Sum: Map grows; i advances", async () => {
    const { trace } = await runExample("js-two-sum");
    const lines = trace.events.filter((e) => e.type === "line" && e.loc.line === 9);
    expect(lines.map((e) => plain(e, "i"))).toEqual([0, 1]);
    expect(lines.map((e) => plain(e, "seen"))).toEqual([{}, { 2: 0 }]);
  });

  it("JS reverse linked list: the same shape of states as Python", async () => {
    const { trace } = await runExample("js-reverse-linked-list");
    const iterations = trace.events.filter((e) => e.type === "line" && e.loc.line === 10);
    expect(iterations.map((e) => linkedFrom(e, local(e, "prev")))).toEqual([[], [1], [2, 1], [3, 2, 1], [4, 3, 2, 1], [5, 4, 3, 2, 1]]);
  });

  it("JS max depth: returns flow from leaves to root", async () => {
    const { trace } = await runExample("js-max-depth");
    const rets = trace.events.filter((e) => e.type === "return" && top(e).name === "maxDepth").map((e) => toPlain(e.returnValue as Value, e.heap));
    expect(rets).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 2, 3]);
  });

  it("JS sliding window: window bounds over time", async () => {
    const { trace } = await runExample("js-sliding-window");
    const shrinks = trace.events.filter((e) => e.type === "line" && e.loc.line === 8).map((e) => [plain(e, "left"), plain(e, "right")]);
    expect(shrinks).toEqual([
      [0, 3],
      [1, 4],
      [2, 4],
      [3, 5],
      [4, 5],
    ]);
  });
});
