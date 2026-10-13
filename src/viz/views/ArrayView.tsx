import type { CellStatus, SequenceChange } from "../../trace/diff";
import type { Truncation, Value } from "../../trace/schema";
import { numberOf } from "../../trace/values";
import { type CellRef, type PointerMarker, RANGE_PAIRS } from "../model";
import { useMemo, useRef } from "react";
import { cellText, fmtNum, HeatLegend, heatColor, useViz, ValueInline } from "./common";
import { ArrayOverview, type MarkKind, useFollowFocus } from "./follow";

export interface ArrayViewProps {
  items: readonly Value[];
  length: number;
  truncated?: Truncation | undefined;
  status?: readonly CellStatus[] | undefined;
  removed?: SequenceChange["removed"] | undefined;
  /** previous items (same object, previous event) for "was" labels */
  prevItems?: readonly Value[] | undefined;
  pointers: readonly PointerMarker[];
  cellRefs: readonly CellRef[];
  heat?: boolean;
  variant?: "array" | "string" | "pairs" | "heap";
  /** label for screen readers */
  label: string;
}

const PTR_ROW = 18;


/**
 * Indexed cells with pointer markers. Pointers are positioned absolutely so
 * they can glide between cells when motion is enabled; several pointers on
 * the same index stack vertically instead of overlapping.
 */
export function ArrayView(p: ArrayViewProps): React.JSX.Element {
  const ctx = useViz();
  const heap = ctx.event.heap;
  const prevHeap = ctx.prev?.heap ?? heap;
  const texts = p.items.map((v) => cellText(v, heap, ctx.language, p.variant === "pairs" ? 24 : 16));
  const maxChars = Math.max(1, ...texts.map((t) => t.length), String(p.length - 1).length);
  const cellW = p.variant === "string" ? Math.max(30, Math.min(48, maxChars * 8 + 14)) : Math.max(40, Math.min(150, maxChars * 7.6 + 18));
  const gap = 4;
  const step = cellW + gap;

  const inRange = p.pointers.filter((x) => !x.outOfRange);
  const outRange = p.pointers.filter((x) => x.outOfRange);
  const perIndex = new Map<number, number>();
  for (const ptr of inRange) perIndex.set(ptr.index, (perIndex.get(ptr.index) ?? 0) + 1);
  // Labels are as wide as their names (never truncated); a label that would overlap one
  // already placed moves up a row.
  const stackPos = new Map<string, number>();
  const rowEnds: number[] = [];
  for (const ptr of [...inRange].sort((a, b) => a.index - b.index || a.name.localeCompare(b.name))) {
    const w = ptr.name.length * 7 + 14;
    const x0 = ptr.index * step + cellW / 2 - w / 2;
    let row = rowEnds.findIndex((end) => end + 3 <= x0);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = x0 + w;
    stackPos.set(ptr.name, row);
  }
  const ptrRows = rowEnds.length;
  // A window between a conventional pair of bounds, e.g. left..right in a sliding window.
  const byName = new Map(inRange.map((x) => [x.name, x.index] as const));
  const windowPair = RANGE_PAIRS.find(([a, b]) => byName.has(a) && byName.has(b) && (byName.get(a) as number) <= (byName.get(b) as number));
  const win = windowPair ? { from: byName.get(windowPair[0]) as number, to: byName.get(windowPair[1]) as number, label: `${windowPair[0]}..${windowPair[1]}` } : null;

  const nums = p.items.map((v) => numberOf(v));
  const numeric = p.heat && nums.length > 1 && nums.every((n) => n !== undefined);
  const min = numeric ? Math.min(...(nums as number[])) : 0;
  const max = numeric ? Math.max(...(nums as number[])) : 0;

  const refAt = (i: number): CellRef[] => p.cellRefs.filter((c) => c.path[0] === i);

  const scrollRef = useRef<HTMLDivElement>(null);
  useFollowFocus(scrollRef, ctx.event.index, ctx.reducedMotion);
  const marks = useMemo(() => {
    const out: Array<{ index: number; kind: MarkKind }> = [];
    p.status?.forEach((st, i) => {
      if (st !== "same") out.push({ index: i, kind: st === "new" ? "new" : "changed" });
    });
    for (const c of p.cellRefs) if (c.role === "write" && typeof c.path[0] === "number") out.push({ index: c.path[0], kind: "write" });
    for (const ptr of p.pointers) if (!ptr.outOfRange) out.push({ index: ptr.index, kind: "pointer" });
    return out;
  }, [p.status, p.cellRefs, p.pointers]);

  return (
    <div className={`array-view array-${p.variant ?? "array"}`} role="group" aria-label={p.label}>
      <div className="array-scroll" ref={scrollRef}>
        <div className="array-track" style={{ width: Math.max(1, p.items.length) * step + 8 }}>
          {ptrRows > 0 && (
            <div className="ptr-layer" style={{ height: ptrRows * PTR_ROW + 6 }} aria-hidden="false">
              {inRange.map((ptr) => (
                <div
                  key={ptr.name}
                  className={`ptr-label${ptr.manual || ptr.partnerOf ? " is-manual" : ""}`}
                  style={{
                    width: cellW,
                    transform: `translate(${ptr.index * step}px, ${(ptrRows - 1 - (stackPos.get(ptr.name) ?? 0)) * PTR_ROW}px)`,
                  }}
                  title={`${ptr.name} = ${ptr.index}${ptr.manual ? " (added manually)" : ptr.partnerOf ? ` (shown as the other bound of ${ptr.partnerOf}; hide it under Pointers)` : " (used as an index into this structure)"}`}
                  data-testid={`ptr-${ptr.name}`}
                  data-index={ptr.index}
                >
                  <span>{ptr.name}</span>
                </div>
              ))}
            </div>
          )}
          <div className="cells" style={{ gap }}>
            {win && (
              <div
                className="window-span"
                style={{ left: win.from * step - 4, width: (win.to - win.from) * step + cellW + 8 }}
                title={`range ${win.label}: indices ${win.from}–${win.to} (${win.to - win.from + 1} items)`}
                data-testid="window-span"
              />
            )}
            {p.items.length === 0 && <div className="empty-note">empty {p.variant === "string" ? "string" : "list"}</div>}
            {p.items.map((v, i) => {
              const st = p.status?.[i] ?? "same";
              const refs = refAt(i);
              const reads = refs.some((r) => r.role === "read");
              const writes = refs.some((r) => r.role === "write");
              const pointed = (perIndex.get(i) ?? 0) > 0;
              const prev = st === "changed" ? p.prevItems?.[i] : undefined;
              const hc = numeric ? heatColor(max === min ? 0.5 : ((nums[i] as number) - min) / (max - min)) : null;
              const cls = ["cell", `st-${st}`, reads ? "is-read" : "", writes ? "is-write" : "", pointed ? "is-pointed" : ""].filter(Boolean).join(" ");
              return (
                <div
                  key={i}
                  className={cls}
                  style={{ width: cellW, ...(hc ? { background: hc.bg, color: hc.fg } : {}) }}
                  data-testid={`cell-${i}`}
                  data-status={st}
                  title={[
                    `index ${i}`,
                    st === "new" ? "new since previous step" : "",
                    st === "changed" && prev ? `changed (was ${cellText(prev, prevHeap, ctx.language, 40)})` : "",
                    refs.map((r) => `${r.role === "write" ? "written" : "read"} by this line as ${r.expr}`).join("; "),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <span className="cell-val">{v.t === "ref" && p.variant !== "pairs" ? <ValueInline v={v} max={14} /> : texts[i]}</span>
                  {st === "new" && <span className="badge badge-new" aria-label="new">+</span>}
                  {st === "changed" && <span className="badge badge-changed" aria-label="changed">Δ</span>}
                  {(reads || writes) && (
                    <span className="rw-tags">
                      {reads && <span className="rw rw-read">R</span>}
                      {writes && <span className="rw rw-write">W</span>}
                    </span>
                  )}
                  {prev && <span className="was">was {cellText(prev, prevHeap, ctx.language, 8)}</span>}
                </div>
              );
            })}
          </div>
          <div className="indices" style={{ gap }}>
            {p.items.map((_, i) => (
              <div key={i} className="idx" style={{ width: cellW }}>
                {i}
              </div>
            ))}
          </div>
        </div>
      </div>
      <ArrayOverview scrollRef={scrollRef} count={p.items.length} marks={marks} label={p.variant === "string" ? "chars" : "showing"} />
      <div className="array-foot">
        {win && (
          <span className="window-note" data-testid="window-note">
            {win.label} = [{win.from}..{win.to}] · {win.to - win.from + 1} item{win.to === win.from ? "" : "s"}
          </span>
        )}
        {outRange.map((ptr) => (
          <span key={ptr.name} className="ptr-out" data-testid={`ptr-out-${ptr.name}`}>
            {ptr.name} = {ptr.index} {ptr.index < 0 ? "(before start)" : "(past end)"}
          </span>
        ))}
        {p.removed && p.removed.length > 0 && (
          <span className="removed-note">
            − removed:{" "}
            {p.removed.map((r, k) => (
              <span key={k} className="removed-item">
                {cellText(r.value, prevHeap, ctx.language, 12)}
                <small> (was at {r.beforeIndex})</small>
              </span>
            ))}
          </span>
        )}
        {p.truncated && (
          <span className="trunc-inline">
            … {p.truncated.total - p.truncated.shown} more not captured ({p.truncated.reason === "items" ? "item limit" : "snapshot budget"})
          </span>
        )}
        {numeric && <HeatLegend min={min} max={max} />}
        {numeric && min === max && <span className="dim">all values {fmtNum(min)}</span>}
      </div>
    </div>
  );
}
