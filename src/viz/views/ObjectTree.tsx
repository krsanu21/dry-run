import { useState } from "react";
import type { Value } from "../../trace/schema";
import { formatPrimitive, summarizeObject } from "../../trace/values";
import { changeOf, TruncationNote, useViz } from "./common";

/**
 * Generic object-graph inspector: always available as a fallback. Preserves
 * object identity (ids are shown), marks shared objects and cycles, and never
 * claims a structure it cannot establish.
 */
export function ObjectTree({ v, label, depth = 0, path = new Set<string>() }: { v: Value; label?: string; depth?: number; path?: Set<string> }): React.JSX.Element {
  const ctx = useViz();
  const [open, setOpen] = useState(depth < 1);
  if (v.t !== "ref") {
    return (
      <div className="otree-row">
        {label !== undefined && <span className="otree-key">{label}: </span>}
        <span className={`prim prim-${v.t}`}>{formatPrimitive(v, ctx.language)}</span>
      </div>
    );
  }
  const o = ctx.event.heap[v.id];
  const ch = changeOf(ctx, v.id);
  const shared = (ctx.refCounts.get(v.id) ?? 0) > 1;
  if (!o)
    return (
      <div className="otree-row">
        {label !== undefined && <span className="otree-key">{label}: </span>}
        <span className="dim">(not captured)</span>
      </div>
    );
  const cyclic = path.has(v.id);
  const header = (
    <>
      {label !== undefined && <span className="otree-key">{label}: </span>}
      <span className="otree-type">{summarizeObject(o, ctx.language)}</span>
      {shared && <span className="alias-mark" title="This object is referenced from more than one place">⧉</span>}
      {ch?.isNew && <span className="badge badge-new inline">+</span>}
      {ch && !ch.isNew && <span className="badge badge-changed inline">Δ</span>}
    </>
  );
  if (cyclic) {
    return (
      <div className="otree-row">
        {header} <span className="cycle-note">↻ cycle (already shown above)</span>
      </div>
    );
  }
  const children: Array<[string, Value]> = [];
  if (o.kind === "list" || o.kind === "tuple" || o.kind === "set" || o.kind === "deque") o.items.forEach((x, i) => children.push([o.kind === "set" ? "•" : String(i), x]));
  else if (o.kind === "dict")
    o.entries.forEach(([k, x]) => children.push([k.t === "ref" ? `#${k.id}` : formatPrimitive(k, ctx.language), x]));
  else if (o.kind === "object") o.attrs.forEach(([k, x]) => children.push([k, x]));
  const expandable = children.length > 0;
  const next = new Set(path);
  next.add(v.id);
  return (
    <div className="otree">
      <div className="otree-row">
        {expandable ? (
          <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={open ? "Collapse" : "Expand"}>
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="disclosure-spacer" />
        )}
        <span className="otree-head">{header}</span>
        {(o.kind === "function" || o.kind === "class" || o.kind === "other") && <span className="dim"> {o.repr}</span>}
      </div>
      {open && expandable && (
        <div className="otree-children">
          {children.map(([k, x], i) => (
            <ObjectTree key={`${k}:${i}`} v={x} label={k} depth={depth + 1} path={next} />
          ))}
        </div>
      )}
      {open && <TruncationNote obj={o} />}
    </div>
  );
}
