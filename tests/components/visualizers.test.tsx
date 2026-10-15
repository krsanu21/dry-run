// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceEvent } from "../../src/trace/schema";
import { useKeyboard } from "../../src/ui/App";
import { Canvas } from "../../src/ui/Canvas";
import { CallStackPanel, VariablesPanel } from "../../src/ui/Inspector";
import { store } from "../../src/ui/store";
import { TraceBar } from "../../src/ui/TraceBar";
import { useCurrentStep } from "../../src/ui/useTrace";
import { VizContext } from "../../src/viz/views/common";
import { findIndex, showFixtureAt } from "../fixtureUtil";

/** Renders UI with a VizContext derived from the store, exactly like App does. */
function WithViz({ children }: { children: React.ReactNode }): React.JSX.Element {
  const step = useCurrentStep();
  const ctx = step
    ? {
        event: step.event,
        prev: step.prev,
        diff: step.diff,
        language: store.get().ws.language,
        refCounts: step.refCounts,
        firstSeen: step.trace.objectFirstSeen,
        reducedMotion: true,
      }
    : null;
  return <VizContext.Provider value={ctx}>{children}</VizContext.Provider>;
}

const at = (name: string, pred: (e: TraceEvent) => boolean, nth = 0) => showFixtureAt(name, (t) => findIndex(t, pred, nth));
const line = (n: number) => (e: TraceEvent) => e.type === "line" && e.loc.line === n;

afterEach(() => cleanup());

describe("ArrayView", () => {
  it("draws indexed cells and the pointer inferred from the code", () => {
    at("two-sum", line(7), 1);
    render(<WithViz><Canvas /></WithViz>);
    const panel = screen.getByTestId("panel-nums");
    expect(within(panel).getAllByTestId(/^cell-/).map((c) => c.textContent?.trim()[0])).toEqual(["2", "7", "1", "1"]);
    expect(within(panel).getByTestId("ptr-i").getAttribute("data-index")).toBe("1");
  });

  it("stacks multiple pointers on one cell without overlap", () => {
    at("reverse-array", line(4), 2);
    render(<WithViz><Canvas /></WithViz>);
    const panel = screen.getByTestId("panel-nums");
    const l = within(panel).getByTestId("ptr-l");
    const r = within(panel).getByTestId("ptr-r");
    expect(l.getAttribute("data-index")).toBe("2");
    expect(r.getAttribute("data-index")).toBe("2");
    expect(l.style.transform).not.toBe(r.style.transform); // different vertical slots
  });

  it("marks changed cells with the previous value and R/W cells for the current line", () => {
    // the event right after the first swap ran
    const { trace } = at("reverse-array", line(6), 0);
    void trace;
    render(<WithViz><Canvas /></WithViz>);
    const panel = screen.getByTestId("panel-nums");
    expect(within(panel).getByTestId("cell-0").getAttribute("data-status")).toBe("changed");
    expect(within(panel).getByTestId("cell-4").getAttribute("data-status")).toBe("changed");
    expect(within(panel).getByTestId("cell-1").getAttribute("data-status")).toBe("same");
    expect(within(panel).getByTestId("cell-0").textContent).toContain("was 1");
  });

  it("shows removed values for deques, sets and dicts", () => {
    at("deque-ops", line(4)); // after q.popleft()
    render(<WithViz><Canvas /></WithViz>);
    const q = screen.getByTestId("panel-q");
    expect(within(q).getByText("1", { selector: ".q-item.st-removed, .q-item.st-removed *", exact: false })).toBeTruthy();
    cleanup();
    at("deque-ops", line(8)); // after seen.discard(1)
    render(<WithViz><Canvas /></WithViz>);
    expect(screen.getByTestId("panel-seen").querySelector(".chip.st-removed")?.textContent).toContain("1");
    cleanup();
    at("deque-ops", line(11)); // after del d['a']
    render(<WithViz><Canvas /></WithViz>);
    expect(screen.getByTestId("panel-d").textContent).toContain("removed keys");
  });
});

describe("GridView", () => {
  it("highlights the addressed cell and overlays queued cells", () => {
    at("grid-bfs", line(15), 2);
    render(<WithViz><Canvas /></WithViz>);
    const grid = screen.getByTestId("panel-grid");
    expect(grid.querySelectorAll(".gcell.is-active").length).toBe(1);
    expect(grid.textContent).toContain("queue");
    expect(grid.querySelectorAll("thead th").length).toBe(4); // corner + 3 columns
  });

  it("DP tables: heatmap, legend, read/write markers", () => {
    at("lcs", line(10), 0);
    render(<WithViz><Canvas /></WithViz>);
    const dp = screen.getByTestId("panel-dp");
    expect(dp.querySelectorAll(".gcell.is-write").length).toBe(1);
    expect(dp.querySelectorAll(".gcell.is-read").length).toBe(2);
    expect(dp.querySelector(".heat-legend")).toBeTruthy();
    expect((dp.querySelector('[data-testid="gcell-1-1"]') as HTMLElement).style.background).toMatch(/rgb/);
  });
});

describe("Heap, linked list, tree, graph", () => {
  it("heap: array and tree views of the same list", () => {
    at("kth-largest", line(9), 2);
    render(<WithViz><Canvas /></WithViz>);
    const heap = screen.getByTestId("panel-heap");
    expect(heap.querySelectorAll(".cell").length).toBe(3);
    expect(heap.querySelectorAll("svg .tree-node").length).toBe(3);
  });

  it("linked list: nodes with arrows; a changed link is emphasized", () => {
    at("reverse-linked-list", line(15), 1); // right after curr.next = prev
    render(<WithViz><Canvas /></WithViz>);
    const panel = document.querySelector('[data-kind="linked-list"]') as HTMLElement;
    expect(panel.querySelectorAll(".ll-node").length).toBe(5);
    expect(panel.querySelectorAll(".edge-chg").length).toBe(1);
    expect(panel.textContent).toContain("prev");
    expect(panel.textContent).toContain("curr");
  });

  it("linked list with a cycle renders and reports the cycle", () => {
    at("cycle-list", line(9));
    render(<WithViz><Canvas /></WithViz>);
    const panel = document.querySelector('[data-kind="linked-list"]') as HTMLElement;
    expect(panel.textContent).toContain("cycle detected");
    expect(panel.querySelectorAll(".ll-node").length).toBe(2);
  });

  it("binary tree: all nodes laid out; active call path outlined", () => {
    at("inorder-traversal", (e) => e.type === "call" && e.stack.length === 5);
    render(<WithViz><Canvas /></WithViz>);
    const panel = document.querySelector('[data-kind="tree"]') as HTMLElement;
    expect(panel.querySelectorAll(".tree-node").length).toBe(7);
    expect(panel.querySelectorAll(".tree-node.on-path").length).toBe(3);
  });

  it("graph: nodes, edges, visited and current", () => {
    at("dfs-components", (e) => e.type === "line" && e.loc.line === 13, 1);
    render(<WithViz><Canvas /></WithViz>);
    const panel = screen.getByTestId("panel-graph");
    expect(panel.querySelectorAll(".graph-node").length).toBe(5);
    expect(panel.querySelectorAll(".graph-node.is-visited").length).toBeGreaterThan(0);
    expect(panel.querySelectorAll(".graph-node.is-current").length).toBe(1);
  });

  it("aliases show one panel with a shared-object badge", () => {
    at("aliasing", line(4));
    render(<WithViz><Canvas /></WithViz>);
    const p = screen.getByTestId("panel-a");
    expect(p.textContent).toContain("same object");
    expect(p.textContent).toContain("b");
  });

  it("truncated snapshots are visibly marked", () => {
    at("truncation", line(3));
    render(<WithViz><Canvas /></WithViz>);
    expect(screen.getByTestId("panel-big").textContent).toMatch(/more not captured|Showing 40 of 500/);
    render(<WithViz><VariablesPanel /></WithViz>);
    fireEvent.click(screen.getByLabelText("nest: show the whole value"));
    expect(document.body.textContent).toMatch(/not captured|depth limit/);
  });
});

describe("Call stack and variables", () => {
  it("selecting a caller frame shows that frame's locals", () => {
    at("dfs-components", (e) => e.type === "call" && e.stack.length === 4);
    render(
      <WithViz>
        <CallStackPanel />
        <VariablesPanel />
      </WithViz>,
    );
    expect(screen.getByTestId("var-node").textContent).toContain("2");
    act(() => fireEvent.click(screen.getByTestId("frame-2")));
    expect(store.get().selectedFrameId).not.toBeNull();
    expect(screen.getByTestId("var-node").textContent).toContain("0");
  });

  it("hides an attribute-less self, and evaluates expressions added at the end of the list", () => {
    at("two-sum", line(7), 1);
    render(<WithViz><VariablesPanel /></WithViz>);
    expect(screen.queryByTestId("var-self")).toBeNull();
    expect(screen.getByTestId("var-nums")).toBeTruthy();
    const input = screen.getByTestId("watch-input");
    act(() => {
      fireEvent.change(input, { target: { value: "nums[i] + 1" } });
      fireEvent.submit(input);
    });
    expect(screen.getByTestId("watch-row").textContent).toContain("8"); // nums[1] = 7
  });
});

describe("controls are keyboard accessible", () => {
  function Keys(): null {
    useKeyboard();
    return null;
  }
  it("buttons have labels and arrow keys navigate the recorded trace", () => {
    at("two-sum", (e) => e.index === 0);
    render(
      <>
        <Keys />
        <TraceBar />
      </>,
    );
    for (const label of ["Jump to start", "Back", "Next", "Next line", "Finish call", "Previous line", "Next breakpoint", "Jump to end"])
      expect(screen.getByLabelText(label)).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    expect(store.get().cursor).toBe(2);
    act(() => fireEvent.keyDown(window, { key: "ArrowLeft" }));
    expect(store.get().cursor).toBe(1);
    act(() => fireEvent.keyDown(window, { key: "End" }));
    expect(store.get().cursor).toBe((store.get().run.trace?.length ?? 0) - 1);
    // typing in an input is not intercepted
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => fireEvent.keyDown(input, { key: "Home" }));
    expect(store.get().cursor).not.toBe(0);
  });
});
