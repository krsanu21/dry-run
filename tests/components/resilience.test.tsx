// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Text } from "@codemirror/state";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeEditor } from "../../src/ui/Editor";
import { ErrorBoundary } from "../../src/ui/ErrorBoundary";
import { isLineInDoc, lineAt } from "../../src/ui/lines";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Bomb({ armed, label = "boom" }: { armed: boolean; label?: string }): React.JSX.Element {
  if (armed) throw new Error(label);
  return <div data-testid="fine">all good</div>;
}

describe("ErrorBoundary", () => {
  it("contains a rendering failure, names the region, keeps siblings alive and offers recovery", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn();
    const recover = vi.fn();
    function Page(): React.JSX.Element {
      const [armed, setArmed] = useState(true);
      return (
        <div>
          <div data-testid="sibling">editor still here</div>
          <ErrorBoundary region="the visualization" onError={onError} recover={{ label: "Clear the trace", run: () => (recover(), setArmed(false)) }}>
            <Bomb armed={armed} />
          </ErrorBoundary>
        </div>
      );
    }
    render(<Page />);
    expect(screen.getByTestId("crash-card").textContent).toContain("Something went wrong in the visualization");
    expect(screen.getByTestId("crash-card").textContent).toContain("boom");
    expect(screen.getByTestId("sibling").textContent).toBe("editor still here");
    expect(onError).toHaveBeenCalledTimes(1);
    // "Try again" with the cause still present fails again but does not escape the boundary
    fireEvent.click(screen.getByTestId("crash-retry"));
    expect(screen.getByTestId("crash-card")).toBeTruthy();
    // the recover action fixes the cause and re-renders the children
    fireEvent.click(screen.getByTestId("crash-recover"));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("fine").textContent).toBe("all good");
    expect(screen.queryByTestId("crash-card")).toBeNull();
  });

  it("recovers by itself when what it was showing changes (stepping to another position)", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(
      <ErrorBoundary region="the visualization" resetKeys={[41]}>
        <Bomb armed />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("crash-card")).toBeTruthy();
    rerender(
      <ErrorBoundary region="the visualization" resetKeys={[42]}>
        <Bomb armed={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByTestId("crash-card")).toBeNull();
    expect(screen.getByTestId("fine")).toBeTruthy();
  });

  it("does not retry on unrelated re-renders (no render loop)", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let renders = 0;
    function Counting(): React.JSX.Element {
      renders++;
      throw new Error("always");
    }
    const { rerender } = render(
      <ErrorBoundary region="x" resetKeys={[1]}>
        <Counting />
      </ErrorBoundary>,
    );
    const after = renders;
    rerender(
      <ErrorBoundary region="x" resetKeys={[1]}>
        <Counting />
      </ErrorBoundary>,
    );
    expect(renders).toBe(after);
  });
});

describe("line numbers that the editor cannot draw", () => {
  const doc = Text.of(["a = 1", "b = 2", "c = 3"]);

  it("isLineInDoc / lineAt accept only real lines", () => {
    for (const bad of [0, -1, 4, 9999, 1.5, NaN, Infinity, undefined, null, "2" as unknown]) {
      expect(isLineInDoc(bad, doc.lines), String(bad)).toBe(false);
      expect(lineAt(doc, bad), String(bad)).toBeUndefined();
    }
    expect(lineAt(doc, 1)?.text).toBe("a = 1");
    expect(lineAt(doc, 3)?.text).toBe("c = 3");
  });

  // Regression: a trace whose last event had line 0 ("unknown") made the editor call doc.line(0)
  // inside a React effect, which unmounted the entire app.
  it("CodeEditor renders and updates with out-of-range lines everywhere a line number is accepted", () => {
    const base = {
      value: "a = 1\nb = 2\nc = 3\n",
      language: "python" as const,
      breakpoints: [] as number[],
      onChange: () => undefined,
      onToggleBreakpoint: () => undefined,
      onBreakpointsMoved: () => undefined,
    };
    const diag = (line: number) => ({ severity: "error" as const, kind: "ValueError", message: "bad", line, endLine: line + 1, column: 0, endColumn: 3 });
    const { rerender } = render(<CodeEditor {...base} traceMark={null} diagnostics={[]} />);
    for (const n of [0, -3, 99, 1.5, Number.NaN]) {
      expect(() =>
        rerender(
          <CodeEditor
            {...base}
            breakpoints={[n, 2]}
            traceMark={{ line: n, kind: "done", prevLine: n }}
            diagnostics={[diag(n)]}
            reveal={{ line: n, n: Math.abs(Math.trunc(n)) + 1 }}
          />,
        ),
      ).not.toThrow();
    }
    // and a valid mark afterwards still works
    expect(() => rerender(<CodeEditor {...base} traceMark={{ line: 2, kind: "next" }} diagnostics={[diag(2)]} />)).not.toThrow();
    act(() => undefined);
  });
});
