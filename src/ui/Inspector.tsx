import { useMemo, useState } from "react";
import { evaluateSource } from "../trace/expr";
import { variableHistory } from "../trace/history";
import type { TraceEvent, TraceFrame, Value } from "../trace/schema";
import { formatValue, typeLabel } from "../trace/values";
import { scopeForFrame } from "../viz/model";
import { useViz, ValueInline } from "../viz/views/common";
import { ObjectTree } from "../viz/views/ObjectTree";
import { goto } from "./actions";
import { store, useApp } from "./store";
import { useCurrentStep } from "./useTrace";

export function CallStackPanel(): React.JSX.Element {
  const step = useCurrentStep();
  const selected = useApp((s) => s.selectedFrameId);
  if (!step) return <div className="side-empty">The call stack appears after a run.</div>;
  const { event, diff } = step;
  const frames = [...event.stack].reverse();
  const active = event.stack[event.stack.length - 1];
  return (
    <div className="callstack" data-testid="callstack">
      {frames.length === 0 && <div className="side-empty">{event.type === "complete" ? "Program finished — no frames remain." : "No active frames."}</div>}
      {frames.map((f, k) => {
        const isActive = f.id === active?.id;
        const isSelected = (selected ?? active?.id) === f.id;
        const entered = diff.framesEntered.includes(f.id);
        const sameName = event.stack.filter((x) => x.name === f.name).length;
        const depthIdx = event.stack.length - k;
        const transition = isActive ? (event.type === "call" ? "entered" : event.type === "return" ? (event.yielded ? "yielding" : event.unwind ? "unwinding" : "returning") : event.type === "exception" ? "raising" : "") : "";
        return (
          <div
            role="button"
            tabIndex={0}
            key={f.id}
            className={`frame${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}${entered ? " is-entered" : ""}`}
            onClick={() => store.set({ selectedFrameId: isActive ? null : f.id })}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                store.set({ selectedFrameId: isActive ? null : f.id });
              }
            }}
            aria-pressed={isSelected}
            aria-label={`Frame ${depthIdx}: ${f.name}, line ${f.line}${isActive ? ", active" : ""}`}
            data-testid={`frame-${depthIdx}`}
          >
            <span className="frame-depth">{depthIdx}</span>
            <span className="frame-sig">
              <span className="frame-name">{f.name === "<module>" ? "global" : f.name}</span>
              <span className="frame-args">
                (
                {f.args
                  .filter((a) => a !== "self")
                  .map((a, i, arr) => {
                    const v = f.locals.find(([k2]) => k2 === a)?.[1];
                    return (
                      <span key={a}>
                        {a}={v ? <ValueInline v={v} max={14} /> : "?"}
                        {i < arr.length - 1 ? ", " : ""}
                      </span>
                    );
                  })}
                )
              </span>
            </span>
            <span className="frame-meta">
              line {f.line}
              {sameName > 1 && <span className="rec-badge"> · recursion depth {event.stack.filter((x, i) => x.name === f.name && i < event.stack.indexOf(f)).length + 1}</span>}
              {transition && <span className={`frame-transition tr-${transition}`}> · {transition}</span>}
            </span>
          </div>
        );
      })}
      {event.type === "return" && !event.yielded && !event.unwind && event.returnValue && (
        <div className="return-strip">
          ↩ returning <ValueInline v={event.returnValue} max={40} />
        </div>
      )}
      {event.type === "exception" && event.exception && (
        <div className="exception-strip" role="alert">
          ⚠ {event.exception.type}: {event.exception.message}
        </div>
      )}
    </div>
  );
}

function VarRow({ name, v, frameId, status, before, ev }: { name: string; v: Value; frameId: string; status: string; before?: Value | undefined; ev: TraceEvent }): React.JSX.Element {
  const ctx = useViz();
  const [open, setOpen] = useState(false);
  const isRef = v.t === "ref";
  return (
    <div className={`var-row st-${status}`} data-testid={`var-${name}`} data-status={status}>
      <div className="var-line">
        {isRef ? (
          <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={open ? `Collapse ${name}` : `Expand ${name}`}>
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="disclosure-spacer" />
        )}
        <button type="button" className="var-name-btn" onClick={() => store.set({ historyVar: { frameId, name } })} title={`Show the history of ${name}`}>
          {name}
        </button>
        <span className="var-type">{typeLabel(v, ev.heap)}</span>
        <span className="var-val">
          <ValueInline v={v} max={48} />
        </span>
        {status === "added" && <span className="badge badge-new inline">+</span>}
        {status === "changed" && <span className="badge badge-changed inline">Δ</span>}
      </div>
      {status === "changed" && before && <div className="var-was">was {formatValue(before, ctx.prev?.heap ?? ev.heap, ctx.language, { maxLength: 60 })}</div>}
      {open && isRef && (
        <div className="var-tree">
          <ObjectTree v={v} />
        </div>
      )}
    </div>
  );
}

export function VariablesPanel(): React.JSX.Element {
  const step = useCurrentStep();
  const showFunctions = useApp((s) => s.prefs.showFunctions);
  if (!step) return <div className="side-empty">Variables appear after a run.</div>;
  const { event, frame, diff } = step;
  const isHidden = (v: Value): boolean => {
    if (showFunctions || v.t !== "ref") return false;
    const o = event.heap[v.id];
    return !!o && (o.kind === "function" || o.kind === "class" || (o.kind === "other" && o.typeName === "module"));
  };
  const section = (title: string, frameId: string, pairs: ReadonlyArray<[string, Value]>, removed: string[]): React.JSX.Element => {
    const shown = pairs.filter(([, v]) => !isHidden(v));
    const hidden = pairs.length - shown.length;
    return (
      <div className="var-section">
        <h4>{title}</h4>
        {shown.length === 0 && <div className="dim small">{pairs.length ? "only functions/classes (hidden)" : "no variables yet"}</div>}
        {shown.map(([name, v]) => {
          const c = diff.vars.find((x) => x.frameId === frameId && x.name === name);
          const objChange = v.t === "ref" ? diff.objects.get(v.id) : undefined;
          const status = c?.kind === "added" ? "added" : c?.kind === "changed" ? "changed" : objChange && !objChange.isNew ? "mutated" : "same";
          return <VarRow key={name} name={name} v={v} frameId={frameId} status={status} before={c?.before} ev={event} />;
        })}
        {removed.map((n) => (
          <div key={n} className="var-row st-removed">
            <div className="var-line">
              <span className="disclosure-spacer" />
              <span className="var-name-btn">{n}</span>
              <span className="dim">out of scope</span>
            </div>
          </div>
        ))}
        {hidden > 0 && <div className="dim small">{hidden} function/class binding(s) hidden (Settings → show functions)</div>}
      </div>
    );
  };
  const frameRemoved = frame ? diff.vars.filter((c) => c.frameId === frame.id && c.kind === "removed").map((c) => c.name) : [];
  return (
    <div className="variables" data-testid="variables">
      {frame && section(frame.name === "<module>" ? "Globals" : `Locals of ${frame.name}`, frame.id, frame.locals, frameRemoved)}
      {frame?.closure && frame.closure.length > 0 && section("Closure (enclosing functions)", frame.id, frame.closure, [])}
      {event.globals.some(([, v]) => !isHidden(v)) && section("Globals", "globals", event.globals as Array<[string, Value]>, [])}
      {event.type === "complete" && event.result && (
        <div className="var-section">
          <h4>Result</h4>
          <VarRow name="result" v={event.result} frameId="result" status="same" ev={event} />
        </div>
      )}
    </div>
  );
}

export function WatchPanel(): React.JSX.Element {
  const step = useCurrentStep();
  const watches = useApp((s) => s.watches);
  const lang = useApp((s) => s.ws.language);
  const [draft, setDraft] = useState("");
  const scope = step ? scopeForFrame(step.event, step.frame) : null;
  return (
    <div className="watch" data-testid="watch">
      <form
        className="watch-form"
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft.trim();
          if (t && !watches.includes(t)) store.set({ watches: [...watches, t] });
          setDraft("");
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. nums[i] + nums[j], len(seen), target - num" aria-label="Watch expression" />
        <button type="submit" className="btn small">
          Add
        </button>
      </form>
      <p className="dim small">Evaluated against the recorded snapshot only — never re-runs your code. Supports names, [], ., arithmetic, comparisons, and len/min/max/abs/sum.</p>
      {watches.length === 0 && <div className="dim small">No watch expressions.</div>}
      {watches.map((w) => {
        const r = scope ? evaluateSource(w, scope) : null;
        return (
          <div key={w} className="watch-row" data-testid="watch-row">
            <code className="watch-expr">{w}</code>
            <span className="watch-val">
              {!r ? (
                <span className="dim">no trace</span>
              ) : r.ok ? (
                <span>{formatValue(r.value, step?.event.heap ?? {}, lang, { maxLength: 80 })}</span>
              ) : (
                <span className="watch-err" title={r.error}>
                  ✕ {r.error}
                </span>
              )}
            </span>
            <button type="button" className="mini-btn" aria-label={`Remove watch ${w}`} onClick={() => store.set({ watches: watches.filter((x) => x !== w) })}>
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function HistoryPanel(): React.JSX.Element {
  const step = useCurrentStep();
  const hv = useApp((s) => s.historyVar);
  const lang = useApp((s) => s.ws.language);
  const predFrom = useApp((s) => (s.prediction.enabled && !s.prediction.outcome ? s.prediction.from : null));
  const hist = useMemo(() => (step && hv ? variableHistory(step.trace, hv.frameId, hv.name, lang, predFrom ?? Infinity) : null), [step, hv, lang, predFrom]);
  if (!step) return <div className="side-empty">Variable history appears after a run.</div>;
  if (!hv || !hist) return <div className="side-empty">Click a variable name to see how its value evolved across the trace.</div>;
  return (
    <div className="history" data-testid="history">
      <div className="history-head">
        <strong>{hist.name}</strong> <span className="dim">in {hist.frameName || hist.frameId}</span>
        <button type="button" className="mini-btn" onClick={() => store.set({ historyVar: null })} aria-label="Close history">
          ×
        </button>
      </div>
      {hist.segments.length === 0 && <div className="dim small">Never bound in this frame.</div>}
      <ol className="history-list">
        {hist.segments.map((s, i) => {
          const here = step.index >= s.from && step.index <= s.to;
          return (
            <li key={i} className={here ? "is-here" : ""}>
              <button type="button" className="hist-seg" onClick={() => goto(s.from)} title={`Jump to step ${s.from}`}>
                <span className="hist-range">
                  {s.from === s.to ? `step ${s.from}` : `steps ${s.from}–${s.to}`}
                </span>
                <span className="hist-val">{s.text}</span>
                {s.objectId && <span className="dim small"> (object #{s.objectId.replace(/^o/, "")})</span>}
              </button>
              {s.mutations.length > 0 && (
                <div className="hist-muts">
                  contents changed at:{" "}
                  {s.mutations.slice(0, 24).map((m) => (
                    <button key={m} type="button" className={`mut-btn${m === step.index ? " is-here" : ""}`} onClick={() => goto(m)}>
                      {m}
                    </button>
                  ))}
                  {s.mutations.length > 24 && <span className="dim"> +{s.mutations.length - 24}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {hist.unboundRanges.length > 0 && <div className="dim small">Not bound (frame active) during steps {hist.unboundRanges.map((r) => (r.from === r.to ? r.from : `${r.from}–${r.to}`)).join(", ")}.</div>}
      {predFrom !== null && <div className="dim small">History after step {predFrom} is hidden while a prediction is pending.</div>}
    </div>
  );
}

export function InspectPanel(): React.JSX.Element | null {
  const step = useCurrentStep();
  const id = useApp((s) => s.inspectId);
  if (!step || !id) return null;
  const o = step.event.heap[id];
  return (
    <div className="inspect" data-testid="inspect">
      <div className="history-head">
        <strong>Object #{id.replace(/^o/, "")}</strong>
        <button type="button" className="mini-btn" onClick={() => store.set({ inspectId: null })} aria-label="Close inspector">
          ×
        </button>
      </div>
      {o ? <ObjectTree v={{ t: "ref", id }} /> : <div className="dim small">This object is not reachable at the current step.</div>}
      {o && (
        <details className="raw-json">
          <summary>Raw captured data</summary>
          <pre>{JSON.stringify(o, null, 1)}</pre>
        </details>
      )}
    </div>
  );
}

export function frameScalars(f: TraceFrame | undefined, ev: TraceEvent): string[] {
  if (!f) return [];
  return f.locals
    .filter(([k, v]) => {
      if (k === "self" || k === "this") return false;
      if (v.t !== "ref") return true;
      const o = ev.heap[v.id];
      return !!o && (o.kind === "list" || o.kind === "dict" || o.kind === "set" || o.kind === "deque" || o.kind === "tuple");
    })
    .map(([k]) => k);
}
