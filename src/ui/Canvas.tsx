import { useMemo } from "react";
import type { SequenceObject } from "../trace/schema";
import { explainStep } from "../trace/describe";
import * as nav from "../trace/navigation";
import { isTerminal, type Trace } from "../trace/store";
import { formatValue } from "../trace/values";
import { buildPanels, VIZ_KIND_LABELS, type Binding, type VizKind, type VizPanel } from "../viz/model";
import { ArrayView } from "../viz/views/ArrayView";
import { HeapView, MapView, QueueView, SetView } from "../viz/views/CollectionViews";
import { ChangeLegend, changeOf, TruncationNote, useViz } from "../viz/views/common";
import { GraphView } from "../viz/views/GraphView";
import { GridView } from "../viz/views/GridView";
import { LinkedListView, TreeView } from "../viz/views/LinkedViews";
import { ObjectTree } from "../viz/views/ObjectTree";
import { goto } from "./actions";
import { resultMatchFromJson } from "./InputDock";
import { store, useApp } from "./store";
import { historicalNodeVars, useCurrentStep } from "./useTrace";

const WIDE: ReadonlySet<VizKind> = new Set(["array", "grid", "graph", "tree", "linked-list", "heap", "pairs", "string"]);
const KIND_OPTIONS: VizKind[] = ["array", "string", "grid", "pairs", "map", "set", "queue", "heap", "linked-list", "tree", "graph", "object", "raw"];

export function Canvas(): React.JSX.Element {
  const step = useCurrentStep();
  const status = useApp((s) => s.run.status);
  const phase = useApp((s) => s.run.phase);
  const analysis = useApp((s) => s.analysis);
  const language = useApp((s) => s.ws.language);
  const overrides = useApp((s) => s.overrides);
  const pointerOverrides = useApp((s) => s.pointerOverrides);
  const source = useApp((s) => s.run.sourceAtRun);
  const predictionPending = useApp((s) => s.prediction.enabled && s.prediction.from !== null && !s.prediction.outcome);

  const panels = useMemo(() => {
    if (!step) return [];
    const extra: Binding[] = [];
    const src = step.state;
    const ret = src.type === "complete" ? src.result : src.type === "return" && !src.yielded ? src.returnValue : undefined;
    if (ret && ret.t === "ref") extra.push({ name: src.type === "complete" ? "result" : "↩ return value", value: ret, scope: "local" });
    return buildPanels({
      event: src,
      frame: step.frame,
      analysis,
      language,
      options: { overrides, pointerOverrides, historicalNodeVars: historicalNodeVars(step.trace) },
      extra,
    });
  }, [step, analysis, language, overrides, pointerOverrides]);

  const indexVars = useMemo(() => new Set((analysis?.accesses ?? []).flatMap((a) => a.indexNames.flat())), [analysis]);

  if (!step) {
    return (
      <div className="canvas-empty" data-testid="canvas-empty">
        {status === "starting" || status === "running" ? (
          <div className="loading">
            <span className="spinner" aria-hidden /> {phase || "Running…"}
          </div>
        ) : (
          <div className="empty-hero">
            <h2>Nothing traced yet</h2>
            <p>
              Paste or write code on the left (finished or not), give it a test case, and press <kbd>Run</kbd> (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>).
            </p>
            <p className="dim">Every picture here comes from your program’s real recorded execution — step through it forwards and backwards.</p>
          </div>
        )}
      </div>
    );
  }

  const exp = explainStep(step.prev, step.event, step.diff, source, language);
  return (
    <div className="canvas" data-testid="canvas">
      <section className="step-summary" aria-live="polite" aria-label="What happened at this step">
        <div className="sum-col">
          <h3>Just happened</h3>
          <ul>
            {exp.happened.slice(0, 6).map((h, i) => (
              <li key={i} className={i === 0 ? "sum-main" : ""}>
                {h}
              </li>
            ))}
            {exp.happened.length > 6 && <li className="dim">…and {exp.happened.length - 6} more changes</li>}
          </ul>
        </div>
        <div className="sum-col">
          <h3>Now</h3>
          <p className={`sum-now ev-${step.event.type}`} data-testid="step-now">
            {exp.now}
          </p>
          {exp.hints.map((h, i) => (
            <p key={i} className="sum-hint">
              ⓘ {h}
            </p>
          ))}
          {predictionPending && <p className="sum-hint">Prediction pending: the next state is hidden until you submit.</p>}
        </div>
      </section>
      <Outcome trace={step.trace} index={step.index} final={step.final} frameName={step.frame?.name} stateIndex={step.state.index} />
      {step.frame && step.event.stack.length > 1 && step.frame.id !== step.event.stack[step.event.stack.length - 1]?.id && (
        <div className="frame-banner">
          Showing variables of caller frame <strong>{step.frame.name}</strong>.{" "}
          <button type="button" className="link-btn" onClick={() => store.set({ selectedFrameId: null })}>
            Back to active frame
          </button>
        </div>
      )}
      {panels.length === 0 ? (
        <div className="canvas-note">No collections or linked structures in scope at this step. Scalar values are listed under Variables.</div>
      ) : (
        <div className="panels">
          {panels.map((p) => (
            <PanelFrame key={p.key} panel={p} indexVars={indexVars} />
          ))}
        </div>
      )}
      <ChangeLegend />
    </div>
  );
}

const LIMIT_ADVICE: Record<string, string> = {
  events: "The program was still running when the step limit was reached — often a loop whose condition never becomes false, or an input too large to trace step by step. Step back to see what repeats; the limit can be raised in Settings.",
  time: "The program was still running when the time limit was reached — often a loop that never ends, or work that grows too fast for this input. Step back to see what repeats; the limit can be raised in Settings.",
  stack: "The call stack kept growing — usually recursion whose base case is missing or never reached. Look at the arguments of the deepest calls.",
  cancelled: "You stopped this run. Everything recorded up to that point can still be inspected.",
  memory: "The program used too much memory to keep tracing. Everything recorded up to that point can still be inspected.",
  crash: "The runtime stopped unexpectedly. Everything recorded up to that point can still be inspected.",
};

/** Result of the run, shown on the stage: a full banner at the final step and a compact line elsewhere. */
function Outcome({ trace, index, final, frameName, stateIndex }: { trace: Trace; index: number; final: boolean; frameName: string | undefined; stateIndex: number }): React.JSX.Element | null {
  const outcome = useApp((s) => s.run.outcome);
  const status = useApp((s) => s.run.status);
  const mode = useApp((s) => s.ws.mode);
  const lang = useApp((s) => s.ws.language);
  const expected = useApp((s) => s.ws.tests.find((t) => t.id === s.run.testId)?.expected ?? "");
  const last = trace.last;
  if (status !== "done" || !last || !isTerminal(last)) return null;
  const atEnd = index === trace.length - 1;
  const summary = outcome?.summary;
  const match = mode === "function" && last.type === "complete" && expected.trim() && summary ? resultMatchFromJson(summary.resultJson, summary.status, expected) : null;
  const origin = nav.errorOrigin(trace);

  let tone: "ok" | "bad" | "warn" = "ok";
  let head: React.ReactNode;
  if (last.type === "complete") {
    tone = match === false ? "bad" : "ok";
    head =
      mode === "function" ? (
        <>
          {match === false ? "✕" : "✓"} Returned <code data-testid="outcome-result">{last.result ? formatValue(last.result, last.heap, lang, { maxLength: 120, maxDepth: 4 }) : "None"}</code>
          {match !== null && (
            <span className={match ? "ok" : "bad"}>
              {" "}
              {match ? "— matches expected" : <>— expected <code>{expected}</code></>}
            </span>
          )}
        </>
      ) : (
        <>✓ Finished</>
      );
  } else if (last.type === "exception") {
    tone = "bad";
    head = (
      <>
        ✕ {last.exception?.type}: {last.exception?.message}
        {last.exception?.line ? <span className="dim"> — line {last.exception.line}</span> : null}
      </>
    );
  } else {
    tone = "warn";
    head = <>■ Stopped early: {last.limit?.kind === "events" ? `step limit reached after ${(trace.length - 1).toLocaleString()} steps` : last.limit?.kind === "stack" ? "call stack too deep" : last.limit?.kind === "time" ? "time limit reached" : last.limit?.kind === "cancelled" ? "stopped by you" : "runtime stopped"}</>;
  }

  if (!atEnd && !final) {
    return (
      <div className={`outcome-chip oc-${tone}`} data-testid="outcome-chip">
        <span className="dim">Run result:</span> {head}
        <button type="button" className="link-btn" onClick={() => goto(last.type === "exception" && origin >= 0 ? origin : trace.length - 1)}>
          {last.type === "exception" ? "go to error" : "go to end"}
        </button>
      </div>
    );
  }
  return (
    <div className={`outcome-banner oc-${tone}`} role="status" data-testid="outcome-banner">
      <div className="ob-head">{head}</div>
      {last.type === "limit" && <p className="ob-advice">{LIMIT_ADVICE[last.limit?.kind ?? "events"]}</p>}
      {final && frameName && (
        <p className="ob-note dim">
          {last.type === "exception" ? "Showing the state when it was raised" : `Showing the final state of ${frameName === "<module>" ? "the script" : frameName}`} (step {stateIndex}).
        </p>
      )}
      {last.type === "exception" && origin >= 0 && index !== origin && (
        <button type="button" className="mini-btn" onClick={() => goto(origin)} data-testid="goto-raise">
          Go to the line that raised it
        </button>
      )}
    </div>
  );
}

function PanelFrame({ panel, indexVars }: { panel: VizPanel; indexVars: ReadonlySet<string> }): React.JSX.Element {
  const ctx = useViz();
  const overrideKey = panel.names[0] ?? panel.key;
  const obj = panel.rootId ? ctx.event.heap[panel.rootId] : undefined;
  const ch = changeOf(ctx, panel.rootId);
  const aliasCount = panel.kind === "linked-list" || panel.kind === "tree" ? 0 : panel.names.length;
  const ptrOv = useApp((s) => s.pointerOverrides[overrideKey]);
  const overridden = useApp((s) => overrideKey in s.overrides);
  const setKind = (k: string): void => {
    store.set((s) => {
      const overrides = { ...s.overrides };
      if (k === "auto") delete overrides[overrideKey];
      else overrides[overrideKey] = k as VizKind;
      return { overrides };
    });
  };
  const togglePointer = (name: string, show: boolean): void => {
    store.set((s) => {
      const cur = s.pointerOverrides[overrideKey] ?? { add: [], hide: [] };
      const next = show
        ? { add: [...cur.add.filter((n) => n !== name), name], hide: cur.hide.filter((n) => n !== name) }
        : { add: cur.add.filter((n) => n !== name), hide: [...cur.hide.filter((n) => n !== name), name] };
      return { pointerOverrides: { ...s.pointerOverrides, [overrideKey]: next } };
    });
  };
  const showPtrMenu = panel.kind === "array" || panel.kind === "string" || panel.kind === "grid" || panel.kind === "heap" || panel.kind === "pairs";
  const shownPtrs = [...panel.pointers, ...panel.rowPointers, ...panel.colPointers].map((p) => p.name);
  return (
    <section
      className={`panel ${WIDE.has(panel.kind) ? "wide" : "narrow"} kind-${panel.kind}${ch && !ch.isNew ? " was-mutated" : ""}`}
      aria-label={`${VIZ_KIND_LABELS[panel.kind]}: ${panel.names.join(", ")}`}
      data-testid={`panel-${overrideKey}`}
      data-kind={panel.kind}
    >
      <header className="panel-head">
        <div className="panel-title">
          {panel.names.length === 0 && (
            <span className="var-name">
              {panel.key.split(":")[1] ?? "nodes"} <span className="dim small">(held by outer frames)</span>
            </span>
          )}
          {panel.names.map((n, i) => (
            <span key={n} className="var-name">
              {n}
              {i < panel.names.length - 1 ? <span className="dim">, </span> : null}
            </span>
          ))}
          {aliasCount > 1 && (
            <span className="alias-badge" title="These variables refer to the same object; a change through one is visible through all.">
              ⧉ same object
            </span>
          )}
          {obj && (
            <span className="dim panel-type">
              {obj.typeName}
              {"length" in obj && typeof obj.length === "number" ? ` · len ${obj.length}` : ""} · #{obj.id.replace(/^o/, "")}
            </span>
          )}
          {ch && !ch.isNew && <span className="badge badge-changed inline">Δ mutated</span>}
          {ch?.isNew && <span className="badge badge-new inline">+ new</span>}
        </div>
        <div className="panel-tools">
          {showPtrMenu && (panel.candidatePointers.length > 0 || shownPtrs.length > 0) && (
            <details className="ptr-menu">
              <summary title="Choose which variables are drawn as pointers">Pointers</summary>
              <div className="ptr-menu-body">
                <p className="dim small">Detected from indexing in your code. Toggle to override.</p>
                {[...new Set([...shownPtrs, ...panel.candidatePointers, ...(ptrOv?.hide ?? [])])].map((n) => (
                  <label key={n}>
                    <input type="checkbox" checked={shownPtrs.includes(n)} onChange={(e) => togglePointer(n, e.target.checked)} /> {n}
                  </label>
                ))}
              </div>
            </details>
          )}
          <label className="kind-select">
            <span className="sr-only">View as</span>
            <select value={overridden ? panel.kind : "auto"} onChange={(e) => setKind(e.target.value)} aria-label={`View ${overrideKey} as`}>
              <option value="auto">Auto ({VIZ_KIND_LABELS[panel.autoKind]})</option>
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {VIZ_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <div className="panel-body">
        <PanelBody panel={panel} indexVars={indexVars} />
      </div>
    </section>
  );
}

function PanelBody({ panel, indexVars }: { panel: VizPanel; indexVars: ReadonlySet<string> }): React.JSX.Element {
  const ctx = useViz();
  const heap = ctx.event.heap;
  const obj = panel.rootId ? heap[panel.rootId] : undefined;
  const ch = changeOf(ctx, panel.rootId);
  const seq = ch && !ch.isNew && ch.kind === "sequence" ? ch : null;
  const prevObj = panel.rootId ? (ctx.prev?.heap[panel.rootId] as SequenceObject | undefined) : undefined;
  const mismatch = (want: string): React.JSX.Element => (
    <div className="warn-note">
      Can’t show this value as {want}: the captured data has a different shape. Showing raw data instead.
      <ObjectTree v={panel.value} />
    </div>
  );
  switch (panel.kind) {
    case "array":
    case "pairs": {
      if (!obj || (obj.kind !== "list" && obj.kind !== "tuple" && obj.kind !== "deque" && obj.kind !== "set")) return obj ? mismatch("an array") : <TruncationNote obj={obj} />;
      return (
        <ArrayView
          items={obj.items}
          length={obj.length}
          truncated={obj.truncated}
          status={ch?.isNew ? obj.items.map(() => "new" as const) : seq?.status}
          removed={seq?.removed}
          prevItems={prevObj && "items" in prevObj ? prevObj.items : undefined}
          pointers={panel.pointers}
          cellRefs={panel.cellRefs}
          heat={ctx.heatmap && panel.recurrence}
          variant={panel.kind === "pairs" ? "pairs" : "array"}
          label={`Array ${panel.names.join(", ")}`}
        />
      );
    }
    case "string": {
      const v = panel.value;
      if (v.t !== "str") return mismatch("string cells");
      const items = [...v.v].map((c) => ({ t: "str" as const, v: c }));
      return (
        <ArrayView
          items={items}
          length={v.len ?? items.length}
          truncated={v.len !== undefined ? { reason: "items", shown: items.length, total: v.len } : undefined}
          pointers={panel.pointers}
          cellRefs={panel.cellRefs}
          variant="string"
          label={`String ${panel.names.join(", ")}`}
        />
      );
    }
    case "grid":
      if (!obj || (obj.kind !== "list" && obj.kind !== "tuple")) return mismatch("a grid");
      return <GridView panel={panel} />;
    case "map":
      if (!obj || (obj.kind !== "dict" && obj.kind !== "object")) return mismatch("a map");
      return <MapView panel={panel} />;
    case "set":
      if (!obj || obj.kind !== "set") return mismatch("a set");
      return <SetView panel={panel} />;
    case "queue":
      if (!obj || (obj.kind !== "deque" && obj.kind !== "list")) return mismatch("a queue");
      return <QueueView panel={panel} />;
    case "heap":
      if (!obj || obj.kind !== "list") return mismatch("a heap");
      return <HeapView panel={panel} />;
    case "linked-list":
      if (!panel.nodeRoots.length) return mismatch("a linked list");
      return <LinkedListView panel={panel} />;
    case "tree":
      if (!panel.nodeRoots.length) return mismatch("a binary tree");
      return <TreeView panel={panel} stack={ctx.event.stack} />;
    case "graph":
      if (!obj || (obj.kind !== "dict" && obj.kind !== "list")) return mismatch("a graph");
      return <GraphView panel={panel} indexVars={indexVars} />;
    case "object":
    case "raw":
    default:
      return (
        <div className="raw-view">
          <ObjectTree v={panel.value} />
        </div>
      );
  }
}
