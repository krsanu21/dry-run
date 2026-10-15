import { useState } from "react";
import { evaluateSource } from "../trace/expr";
import type { TraceEvent, TraceFrame, Value } from "../trace/schema";
import { formatValue, typeLabel } from "../trace/values";
import { scopeForFrame } from "../viz/model";
import { useViz, ValueInline } from "../viz/views/common";
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
  // the value as the language writes it; the whole of it when expanded
  const short = formatValue(v, ev.heap, ctx.language, { maxLength: 90, maxDepth: 3 });
  const full = formatValue(v, ev.heap, ctx.language, { maxLength: 20000, maxDepth: 12 });
  const expandable = v.t === "ref" || full !== short;
  const shared = v.t === "ref" && (ctx.refCounts.get(v.id) ?? 0) > 1;
  const peeked = !!ctx.peek && ctx.peek.name === name && (ctx.peek.frameId === frameId || frameId === "globals" || ctx.peek.frameId === null);
  const toggle = (): void => {
    if (expandable) setOpen(!open);
  };
  return (
    <div className={`var-row st-${status}${peeked ? " is-peeked" : ""}`} data-testid={`var-${name}`} data-status={status}>
      <div
        className={`var-line${expandable ? " is-expandable" : ""}`}
        {...(expandable
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": open,
              "aria-label": `${name}: ${open ? "collapse" : "show the whole value"}`,
              onClick: toggle,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  toggle();
                }
              },
            }
          : {})}
      >
        <span className="disclosure-mark" aria-hidden="true">
          {expandable ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="var-name-btn">{name}</span>
        <span className="var-type">{typeLabel(v, ev.heap)}</span>
        <span className={`var-val prim-${v.t}`} title={expandable ? undefined : short}>
          {open ? "" : short}
          {shared && (
            <span className="alias-mark" title="The same object is referenced from more than one place">
              {" "}
              ⧉
            </span>
          )}
        </span>
        {status === "added" && <span className="badge badge-new inline">+</span>}
        {status === "changed" && <span className="badge badge-changed inline">Δ</span>}
      </div>
      {open && (
        <pre className="var-full" data-testid={`var-full-${name}`}>
          {full}
        </pre>
      )}
      {status === "changed" && before && <div className="var-was">was {formatValue(before, ctx.prev?.heap ?? ev.heap, ctx.language, { maxLength: 60 })}</div>}
    </div>
  );
}

export function VariablesPanel(): React.JSX.Element {
  const step = useCurrentStep();
  if (!step) return <div className="side-empty">Variables appear after a run.</div>;
  const { state: event, frame, diff } = step;
  // functions, classes, modules and an attribute-less `self` say nothing about the algorithm
  const isHidden = (name: string, v: Value): boolean => {
    if (v.t !== "ref") return false;
    const o = event.heap[v.id];
    if (!o) return false;
    if ((name === "self" || name === "this") && o.kind === "object" && o.attrs.length === 0) return true;
    return o.kind === "function" || o.kind === "class" || (o.kind === "other" && o.typeName === "module");
  };
  const section = (title: string, frameId: string, pairs: ReadonlyArray<[string, Value]>, removed: string[]): React.JSX.Element => {
    const shown = pairs.filter(([n, v]) => !isHidden(n, v));
    return (
      <div className="var-section">
        <h4>{title}</h4>
        {shown.length === 0 && <div className="dim small">no variables yet</div>}
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
      </div>
    );
  };
  const frameRemoved = frame ? diff.vars.filter((c) => c.frameId === frame.id && c.kind === "removed").map((c) => c.name) : [];
  return (
    <div className="variables" data-testid="variables">
      {step.final && frame && (
        <p className="final-note" data-testid="final-note">
          {step.event.type === "exception" ? "State when the exception was raised" : `Final state of ${frame.name === "<module>" ? "the script" : frame.name}`} (step {event.index})
        </p>
      )}
      {frame && section(frame.name === "<module>" ? "Globals" : `Locals of ${frame.name}`, frame.id, frame.locals, frameRemoved)}
      {frame?.closure && frame.closure.length > 0 && section("Closure (enclosing functions)", frame.id, frame.closure, [])}
      {event.globals.some(([n, v]) => !isHidden(n, v)) && section("Globals", "globals", event.globals as Array<[string, Value]>, [])}
      {step.event.type === "complete" && step.event.result && (
        <div className="var-section">
          <h4>Result</h4>
          <VarRow name="result" v={step.event.result} frameId="result" status="same" ev={step.event} />
        </div>
      )}
      <Expressions />
    </div>
  );
}

/** Expressions evaluated against the recorded snapshot (never by running code), listed after the variables. */
function Expressions(): React.JSX.Element {
  const step = useCurrentStep();
  const watches = useApp((s) => s.watches);
  const lang = useApp((s) => s.ws.language);
  const [draft, setDraft] = useState("");
  const scope = step ? scopeForFrame(step.state, step.frame) : null;
  return (
    <div className="var-section expressions" data-testid="watch">
      {watches.map((w) => {
        const r = scope ? evaluateSource(w, scope) : null;
        return (
          <div key={w} className="watch-row" data-testid="watch-row">
            <code className="watch-expr">{w}</code>
            <span className="watch-val">
              {r?.ok ? (
                <span>{formatValue(r.value, step?.state.heap ?? {}, lang, { maxLength: 80 })}</span>
              ) : (
                <span className="watch-err" title={r?.error}>
                  ✕ {r?.error ?? "no trace"}
                </span>
              )}
            </span>
            <button type="button" className="mini-btn" aria-label={`Remove ${w}`} onClick={() => store.set({ watches: watches.filter((x) => x !== w) })}>
              ×
            </button>
          </div>
        );
      })}
      <form
        className="watch-form"
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft.trim();
          if (t && !watches.includes(t)) store.set({ watches: [...watches, t] });
          setDraft("");
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="+ expression, e.g. nums[i] + nums[j]" aria-label="Add an expression" data-testid="watch-input" />
      </form>
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
