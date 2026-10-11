import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/trace/schema";
import { buildPanels, collectListNodes, graphFromDict, layoutTree, treeRoots, type VizPanel } from "../../src/viz/model";
import { findIndex, loadFixture } from "../fixtureUtil";

function panelsAt(name: string, pick: (e: TraceEvent) => boolean, nth = 0, overrides = {}, pointerOverrides = {}): VizPanel[] {
  const { fx, trace } = loadFixture(name);
  const ev = trace.events[findIndex(trace, pick, nth)] as TraceEvent;
  return buildPanels({ event: ev, frame: ev.stack[ev.stack.length - 1], analysis: fx.analysis, language: fx.language, options: { overrides, pointerOverrides } });
}
const byName = (ps: VizPanel[], n: string): VizPanel => {
  const p = ps.find((x) => x.names.includes(n));
  if (!p) throw new Error(`no panel ${n}: ${ps.map((x) => x.names.join("/")).join(", ")}`);
  return p;
};

describe("structure classification", () => {
  it("Two Sum: array + map; i inferred as pointer into nums from enumerate()", () => {
    const ps = panelsAt("two-sum", (e) => e.type === "line" && e.loc.line === 7, 1);
    expect(byName(ps, "nums").kind).toBe("array");
    expect(byName(ps, "seen").kind).toBe("map");
    expect(byName(ps, "nums").pointers).toEqual([{ name: "i", index: 1, outOfRange: false }]);
    // `target` / `need` are ints but never index nums → not pointers
    expect(byName(ps, "nums").pointers.map((p) => p.name)).not.toContain("target");
  });

  it("two pointers: l and r from subscripts; both on the same index when they meet", () => {
    const ps = panelsAt("reverse-array", (e) => e.type === "line" && e.loc.line === 4, 2);
    const nums = byName(ps, "nums");
    expect(nums.pointers.map((p) => [p.name, p.index]).sort()).toEqual([
      ["l", 2],
      ["r", 2],
    ]);
  });

  it("cells referenced by the current line are evaluated from the pre-line state", () => {
    const ps = panelsAt("reverse-array", (e) => e.type === "line" && e.loc.line === 5, 0);
    const refs = byName(ps, "nums").cellRefs;
    expect(refs).toContainEqual({ path: [0], role: "write", expr: "nums[l]" });
    expect(refs).toContainEqual({ path: [4], role: "read", expr: "nums[r]" });
  });

  it("grid: row/col pointer pairs, overlays from (r, c) collections, sizes excluded", () => {
    const ps = panelsAt("grid-bfs", (e) => e.type === "line" && e.loc.line === 15, 2);
    const grid = byName(ps, "grid");
    expect(grid.kind).toBe("grid");
    expect(grid.gridPointers.some((g) => g.rowName === "nr" && g.colName === "nc")).toBe(true);
    expect(grid.overlays.map((o) => o.name)).toContain("queue");
    const dist = byName(ps, "dist");
    expect([...dist.rowPointers, ...dist.colPointers].map((p) => p.name)).not.toContain("rows");
  });

  it("2-D DP: reads and writes of the current line", () => {
    const ps = panelsAt("lcs", (e) => e.type === "line" && e.loc.line === 10, 0);
    const dp = byName(ps, "dp");
    expect(dp.kind).toBe("grid");
    expect(dp.writtenByIndex).toBe(true);
    expect(dp.cellRefs.filter((r) => r.role === "write").map((r) => r.path)).toEqual([[1, 2]]);
    expect(dp.cellRefs.filter((r) => r.role === "read").map((r) => r.path).sort()).toEqual([
      [0, 2],
      [1, 1],
    ]);
  });

  it("heapq lists are heaps; deques are queues; sets are sets", () => {
    expect(byName(panelsAt("kth-largest", (e) => e.type === "line" && e.loc.line === 9, 1), "heap").kind).toBe("heap");
    const ps = panelsAt("deque-ops", (e) => e.type === "line" && e.loc.line === 11);
    expect(byName(ps, "q").kind).toBe("queue");
    expect(byName(ps, "seen").kind).toBe("set");
    expect(byName(ps, "d").kind).toBe("map");
  });

  it("aliases are grouped into one panel", () => {
    const ps = panelsAt("aliasing", (e) => e.type === "line" && e.loc.line === 4);
    const p = byName(ps, "a");
    expect(p.names).toEqual(["a", "b"]);
  });

  it("linked-list variables form one diagram with named pointers; trees include outer-frame nodes", () => {
    const ll = panelsAt("reverse-linked-list", (e) => e.type === "line" && e.loc.line === 15, 1);
    const g = ll.find((p) => p.kind === "linked-list") as VizPanel;
    expect(g.nodeRoots.map((r) => r.name).sort()).toEqual(["curr", "head", "nxt", "prev"]);
    const tr = panelsAt("inorder-traversal", (e) => e.type === "call" && e.stack.length === 5);
    const t = tr.find((p) => p.kind === "tree") as VizPanel;
    expect(t.nodeRoots.some((r) => r.outer)).toBe(true);
  });

  it("graphs: adjacency dict detected and parsed", () => {
    const ps = panelsAt("dfs-components", (e) => e.type === "call" && e.stack.length === 3);
    const g = byName(ps, "graph");
    expect(g.kind).toBe("graph");
    const { trace } = loadFixture("dfs-components");
    const ev = trace.events[findIndex(trace, (e) => e.type === "call" && e.stack.length === 3)] as TraceEvent;
    const model = graphFromDict(ev.heap[g.rootId as string] as never, ev.heap);
    expect(model?.nodes.length).toBe(5);
    expect(model?.directed).toBe(false);
  });

  it("user overrides change the view and pointers", () => {
    const ps = panelsAt("two-sum", (e) => e.type === "line" && e.loc.line === 7, 1, { nums: "raw" }, { nums: { add: ["target"], hide: ["i"] } });
    expect(byName(ps, "nums").kind).toBe("raw");
    const ps2 = panelsAt("two-sum", (e) => e.type === "line" && e.loc.line === 7, 1, {}, { nums: { add: ["target"], hide: ["i"] } });
    expect(byName(ps2, "nums").pointers).toEqual([{ name: "target", index: 9, outOfRange: true, manual: true }]);
  });
});

describe("layout helpers", () => {
  it("collects list nodes and detects cycles safely", () => {
    const { trace } = loadFixture("cycle-list");
    const ev = trace.events[findIndex(trace, (e) => e.type === "line" && e.loc.line === 9)] as TraceEvent;
    const a = ev.stack[0]?.locals.find(([k]) => k === "a")?.[1] as { id: string };
    const { nodes } = collectListNodes([a.id], ev.heap);
    expect(nodes.size).toBe(2);
  });

  it("tree layout is in-order and rejects non-trees", () => {
    const { trace } = loadFixture("inorder-traversal");
    const ev = trace.events[0] as TraceEvent;
    const root = ev.stack[0]?.locals.find(([k]) => k === "root")?.[1] as { id: string };
    const l = layoutTree(root.id, ev.heap);
    expect(l?.nodes.map((n) => n.x)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(l?.height).toBe(3);
    expect(treeRoots([root.id], ev.heap)).toEqual([root.id]);
  });
});
