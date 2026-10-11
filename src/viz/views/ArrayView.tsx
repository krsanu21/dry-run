import type { CellStatus, SequenceChange } from "../../trace/diff";
import type { Truncation, Value } from "../../trace/schema";
import { numberOf } from "../../trace/values";
import type { CellRef, PointerMarker } from "../model";
import { cellText, fmtNum, HeatLegend, heatColor, useViz, ValueInline } from "./common";

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
  const stackPos = new Map<string, number>();
  const perIndex = new Map<number, number>();
  for (const ptr of [...inRange].sort((a, b) => a.name.localeCompare(b.name))) {
    const n = perIndex.get(ptr.index) ?? 0;
    stackPos.set(ptr.name, n);
    perIndex.set(ptr.index, n + 1);
  }
  const ptrRows = Math.max(0, ...perIndex.values());

  const nums = p.items.map((v) => numberOf(v));
  const numeric = p.heat && nums.length > 1 && nums.every((n) => n !== undefined);
  const min = numeric ? Math.min(...(nums as number[])) : 0;
  const max = numeric ? Math.max(...(nums as number[])) : 0;

  const refAt = (i: number): CellRef[] => p.cellRefs.filter((c) => c.path[0] === i);

  return (
    <div className={`array-view array-${p.variant ?? "array"}`} role="group" aria-label={p.label}>
      <div className="array-scroll">
        <div className="array-track" style={{ width: Math.max(1, p.items.length) * step + 8 }}>
          {ptrRows > 0 && (
            <div className="ptr-layer" style={{ height: ptrRows * PTR_ROW + 6 }} aria-hidden="false">
              {inRange.map((ptr) => (
                <div
                  key={ptr.name}
                  className={`ptr-label${ptr.manual ? " is-manual" : ""}`}
                  style={{
                    width: cellW,
                    transform: `translate(${ptr.index * step}px, ${(ptrRows - 1 - (stackPos.get(ptr.name) ?? 0)) * PTR_ROW}px)`,
                  }}
                  title={`${ptr.name} = ${ptr.index}${ptr.manual ? " (added manually)" : " (used as an index into this structure)"}`}
                  data-testid={`ptr-${ptr.name}`}
                  data-index={ptr.index}
                >
                  <span>{ptr.name}</span>
                </div>
              ))}
            </div>
          )}
          <div className="cells" style={{ gap }}>
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
      <div className="array-foot">
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
