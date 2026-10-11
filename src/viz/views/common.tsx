import { createContext, useContext } from "react";
import type { EventDiff, ObjectChange } from "../../trace/diff";
import type { HeapObject, Language, TraceEvent, Value } from "../../trace/schema";
import { formatPrimitive, formatValue, type Heap } from "../../trace/values";

/** Everything a visualizer needs about the selected event. Visualizers never execute code. */
export interface VizContextValue {
  event: TraceEvent;
  prev: TraceEvent | undefined;
  diff: EventDiff;
  language: Language;
  refCounts: Map<string, number>;
  /** first-seen order of object ids across the whole trace (stable layouts) */
  firstSeen: Map<string, number>;
  heatmap: boolean;
  reducedMotion: boolean;
  onInspect(id: string): void;
}

export const VizContext = createContext<VizContextValue | null>(null);

export function useViz(): VizContextValue {
  const v = useContext(VizContext);
  if (!v) throw new Error("VizContext missing");
  return v;
}

export function changeOf(ctx: VizContextValue, id: string | undefined): ObjectChange | undefined {
  return id ? ctx.diff.objects.get(id) : undefined;
}

/** Short text for a value inside a cell. */
export function cellText(v: Value, heap: Heap, lang: Language, max = 18): string {
  if (v.t !== "ref") {
    const s = formatPrimitive(v, lang);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }
  return formatValue(v, heap, lang, { maxLength: max, maxDepth: 2 });
}

export function RefChip({ id, obj, label }: { id: string; obj: HeapObject | undefined; label?: string }): React.JSX.Element {
  const ctx = useViz();
  const shared = (ctx.refCounts.get(id) ?? 0) > 1;
  return (
    <button
      type="button"
      className={`ref-chip${shared ? " is-shared" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        ctx.onInspect(id);
      }}
      title={`${obj?.typeName ?? "object"} #${id}${shared ? ` — referenced from ${ctx.refCounts.get(id)} places` : ""}. Click to inspect.`}
    >
      {label ?? (obj ? summarize(obj) : `#${id}`)}
      <span className="ref-id">#{id.replace(/^o/, "")}</span>
    </button>
  );
}

function summarize(o: HeapObject): string {
  switch (o.kind) {
    case "list":
    case "tuple":
    case "set":
    case "deque":
    case "dict":
      return `${o.typeName}(${o.length})`;
    case "object":
      return o.typeName;
    case "elided":
      return `${o.typeName}…`;
    default:
      return o.repr;
  }
}

/** Inline rendering of a value: primitives as text, objects as clickable chips. */
export function ValueInline({ v, max = 40 }: { v: Value; max?: number }): React.JSX.Element {
  const ctx = useViz();
  if (v.t === "ref") {
    const o = ctx.event.heap[v.id];
    const short = o && (o.kind === "list" || o.kind === "tuple") && o.items.length <= 4 && o.items.every((x) => x.t !== "ref");
    return <RefChip id={v.id} obj={o} {...(short ? { label: formatValue(v, ctx.event.heap, ctx.language, { maxLength: max }) } : {})} />;
  }
  return <span className={`prim prim-${v.t}`}>{cellText(v, ctx.event.heap, ctx.language, max)}</span>;
}

export function TruncationNote({ obj }: { obj: HeapObject | undefined }): React.JSX.Element | null {
  if (!obj) return null;
  if (obj.kind === "elided")
    return (
      <div className="trunc-note" role="note">
        ⚠ Not captured: snapshot {obj.reason} limit reached{obj.length !== undefined ? ` (${obj.length} items)` : ""}. Raise the limit in Settings.
      </div>
    );
  if ("truncated" in obj && obj.truncated)
    return (
      <div className="trunc-note" role="note">
        ⚠ Showing {obj.truncated.shown} of {obj.truncated.total} items ({obj.truncated.reason === "items" ? "per-collection item limit" : "snapshot budget"}). Hidden items are not displayed.
      </div>
    );
  return null;
}

// Colorblind-aware sequential scale (viridis stops).
const VIRIDIS = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"];

function hexToRgb(h: string): [number, number, number] {
  const n = Number.parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function heatColor(t: number): { bg: string; fg: string } {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(VIRIDIS[i] as string);
  const b = hexToRgb(VIRIDIS[i + 1] as string);
  const c = a.map((av, k) => Math.round(av + ((b[k] as number) - av) * f)) as [number, number, number];
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  return { bg: `rgb(${c[0]}, ${c[1]}, ${c[2]})`, fg: lum > 0.55 ? "#111" : "#fff" };
}

export function HeatLegend({ min, max }: { min: number; max: number }): React.JSX.Element {
  return (
    <div className="heat-legend" aria-label={`Heatmap from ${min} to ${max}`}>
      <span>{fmtNum(min)}</span>
      <span className="heat-bar" style={{ background: `linear-gradient(90deg, ${VIRIDIS.join(",")})` }} />
      <span>{fmtNum(max)}</span>
    </div>
  );
}

export function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function ChangeLegend(): React.JSX.Element {
  return (
    <div className="change-legend" aria-label="Legend">
      <span className="lg lg-new">+ new</span>
      <span className="lg lg-changed">Δ changed</span>
      <span className="lg lg-removed">− removed</span>
      <span className="lg lg-read">R read by this line</span>
      <span className="lg lg-write">W written by this line</span>
      <span className="lg lg-alias">⧉ shared object</span>
    </div>
  );
}
