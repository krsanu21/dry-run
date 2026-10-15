import { useMemo, useRef, useState } from "react";
import type { SequenceObject, Value } from "../../trace/schema";
import { numberOf } from "../../trace/values";
import type { VizPanel } from "../model";
import { cellText, changeOf, fmtNum, HeatLegend, heatColor, TruncationNote, useViz } from "./common";
import { GridMinimap, type MarkKind, useFollowFocus } from "./follow";

const OVERLAY_STYLES = ["ov-a", "ov-b", "ov-c", "ov-d"];

/**
 * 2-D arrays / grids / DP tables. Row and column headers carry the pointer
 * variables inferred from `grid[r][c]`-style accesses; addressed cells are
 * outlined; collections of (r, c) pairs (visited sets, BFS queues) can be
 * overlaid on the cells.
 */
export function GridView({ panel }: { panel: VizPanel }): React.JSX.Element {
  const ctx = useViz();
  const heap = ctx.event.heap;
  const prevHeap = ctx.prev?.heap ?? heap;
  const outer = panel.rootId ? heap[panel.rootId] : undefined;
  const [zoom, setZoom] = useState(1);
  const [hiddenOverlays, setHidden] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  useFollowFocus(scrollRef, ctx.event.index, ctx.reducedMotion);
  const marks = useMemo(() => {
    const out: Array<{ r: number; c: number; kind: MarkKind }> = [];
    const o = panel.rootId ? ctx.event.heap[panel.rootId] : undefined;
    if (!o || (o.kind !== "list" && o.kind !== "tuple")) return out;
    const oc = changeOf(ctx, panel.rootId);
    o.items.forEach((rv, r) => {
      if (rv.t !== "ref") return;
      const row = ctx.event.heap[rv.id];
      const rc = changeOf(ctx, rv.id);
      const len = row && (row.kind === "list" || row.kind === "tuple") ? row.items.length : 0;
      const whole = (rc && rc.isNew) || (oc && !oc.isNew && oc.kind === "sequence" && oc.status[r] !== "same");
      for (let c = 0; c < len; c++) {
        if (whole) out.push({ r, c, kind: "new" });
        else if (rc && !rc.isNew && rc.kind === "sequence" && rc.status[c] && rc.status[c] !== "same") out.push({ r, c, kind: rc.status[c] === "new" ? "new" : "changed" });
      }
    });
    for (const x of panel.cellRefs) if (x.role === "write" && typeof x.path[0] === "number" && typeof x.path[1] === "number") out.push({ r: x.path[0], c: x.path[1], kind: "write" });
    for (const g of panel.gridPointers) out.push({ r: g.r, c: g.c, kind: "active" });
    return out;
  }, [ctx, panel]);
  if (!outer || (outer.kind !== "list" && outer.kind !== "tuple")) return <TruncationNote obj={outer} />;
  const rowObjs = outer.items.map((v) => (v.t === "ref" ? (heap[v.id] as SequenceObject | undefined) : undefined));
  const cols = Math.max(0, ...rowObjs.map((r) => r?.items.length ?? 0));
  const outerChange = changeOf(ctx, panel.rootId);
  const allNums = rowObjs.flatMap((r) => (r?.items ?? []).map((v) => numberOf(v)));
  const numeric = allNums.length > 1 && allNums.every((n) => n !== undefined) && panel.recurrence;
  const nums = allNums as number[];
  const min = numeric ? Math.min(...nums) : 0;
  const max = numeric ? Math.max(...nums) : 0;
  const compact = cols > 14 || rowObjs.length > 14;
  const size = Math.round((compact ? 28 : 40) * zoom);

  const overlays = panel.overlays.filter((o) => !hiddenOverlays.has(o.name));
  const overlayAt = new Map<string, Array<{ name: string; order: number; kind: string; style: string }>>();
  panel.overlays.forEach((o, k) => {
    if (hiddenOverlays.has(o.name)) return;
    for (const c of o.cells) {
      const key = `${c.r},${c.c}`;
      const arr = overlayAt.get(key) ?? [];
      arr.push({ name: o.name, order: c.order, kind: o.kind, style: OVERLAY_STYLES[k % OVERLAY_STYLES.length] as string });
      overlayAt.set(key, arr);
    }
  });
  const active = new Map(panel.gridPointers.map((g) => [`${g.r},${g.c}`, g] as const));
  const refAt = (r: number, c: number) => panel.cellRefs.filter((x) => x.path[0] === r && x.path[1] === c);
  const rowPtrs = (r: number) => panel.rowPointers.filter((x) => !x.outOfRange && x.index === r);
  const colPtrs = (c: number) => panel.colPointers.filter((x) => !x.outOfRange && x.index === c);

  return (
    <div className="grid-view" role="group" aria-label={`Grid ${panel.names.join(", ")}`}>
      <div className="grid-tools">
        <span className="dim">
          {rowObjs.length} × {cols}
        </span>
        <button type="button" className="mini-btn" onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="mini-btn" onClick={() => setZoom((z) => Math.min(2, z + 0.15))} aria-label="Zoom in">
          +
        </button>
        {panel.overlays.map((o, k) => (
          <label key={o.name} className={`overlay-toggle ${OVERLAY_STYLES[k % OVERLAY_STYLES.length]}`}>
            <input
              type="checkbox"
              checked={!hiddenOverlays.has(o.name)}
              onChange={() =>
                setHidden((h) => {
                  const n = new Set(h);
                  if (n.has(o.name)) n.delete(o.name);
                  else n.add(o.name);
                  return n;
                })
              }
            />
            <span className="ov-swatch" /> {o.name} <small>({o.kind === "queue" ? `queue, ${o.cells.length}` : o.cells.length})</small>
          </label>
        ))}
      </div>
      <div className="grid-body">
      <div className="grid-scroll" ref={scrollRef}>
        <table className={`grid-table${compact ? " compact" : ""}`} style={{ ["--cell" as string]: `${size}px` }}>
          <thead>
            <tr>
              <th className="corner" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} scope="col" className={colPtrs(c).length ? "hdr-ptr" : ""}>
                  <div className="hdr-ptrs">
                    {colPtrs(c).map((x) => (
                      <span key={x.name} className={`ptr-chip${ctx.peek?.name === x.name ? " is-peeked" : ""}`} data-testid={`colptr-${x.name}`}>
                        {x.name}
                      </span>
                    ))}
                  </div>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowObjs.map((row, r) => {
              const rowId = outer.items[r]?.t === "ref" ? (outer.items[r] as { id: string }).id : undefined;
              const rc = changeOf(ctx, rowId);
              const rowStatus = rc && !rc.isNew && rc.kind === "sequence" ? rc.status : undefined;
              const rowNew = (rc && rc.isNew) || (outerChange && !outerChange.isNew && outerChange.kind === "sequence" && outerChange.status[r] !== "same");
              const prevRow = rowId ? prevHeap[rowId] : undefined;
              return (
                <tr key={r}>
                  <th scope="row" className={rowPtrs(r).length ? "hdr-ptr" : ""}>
                    <span className="hdr-ptrs-row">
                      {rowPtrs(r).map((x) => (
                        <span key={x.name} className={`ptr-chip${ctx.peek?.name === x.name ? " is-peeked" : ""}`} data-testid={`rowptr-${x.name}`}>
                          {x.name}
                        </span>
                      ))}
                    </span>
                    {r}
                  </th>
                  {Array.from({ length: cols }, (_, c) => {
                    const v: Value | undefined = row?.items[c];
                    if (!v) return <td key={c} className="gcell void" />;
                    const st = rowNew && !(rc && !rc.isNew) ? "new" : rowStatus?.[c] ?? "same";
                    const ovs = overlayAt.get(`${r},${c}`) ?? [];
                    const act = active.get(`${r},${c}`);
                    const refs = refAt(r, c);
                    const n = numberOf(v);
                    const hc = numeric && n !== undefined ? heatColor(max === min ? 0.5 : (n - min) / (max - min)) : null;
                    const prevV = st === "changed" && prevRow && prevRow.kind === "list" ? prevRow.items[c] : undefined;
                    const cls = [
                      "gcell",
                      `st-${st}`,
                      act ? "is-active" : "",
                      act && (act.rowName === ctx.peek?.name || act.colName === ctx.peek?.name) ? "is-peeked-cell" : "",
                      refs.some((x) => x.role === "read") ? "is-read" : "",
                      refs.some((x) => x.role === "write") ? "is-write" : "",
                      ...ovs.map((o) => `has-${o.style}`),
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <td
                        key={c}
                        className={cls}
                        style={hc ? { background: hc.bg, color: hc.fg } : undefined}
                        data-testid={`gcell-${r}-${c}`}
                        data-status={st}
                        title={[
                          `[${r}][${c}] = ${cellText(v, heap, ctx.language, 30)}`,
                          prevV ? `was ${cellText(prevV, prevHeap, ctx.language, 20)}` : "",
                          act ? `addressed by ${act.rowName}, ${act.colName}` : "",
                          ...refs.map((x) => `${x.role === "write" ? "written" : "read"} by this line (${x.expr})`),
                          ...ovs.map((o) => `in ${o.name}${o.kind === "queue" ? ` (position ${o.order})` : ""}`),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      >
                        <span className="gval">{cellText(v, heap, ctx.language, compact ? 4 : 6)}</span>
                        {st === "changed" && <span className="badge badge-changed">Δ</span>}
                        {st === "new" && <span className="badge badge-new">+</span>}
                        {ovs.filter((o) => o.kind === "queue").map((o) => (
                          <span key={o.name} className="q-order">
                            {o.order}
                          </span>
                        ))}
                        {refs.length > 0 && (
                          <span className="rw-tags">
                            {refs.some((x) => x.role === "read") && <span className="rw rw-read">R</span>}
                            {refs.some((x) => x.role === "write") && <span className="rw rw-write">W</span>}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <GridMinimap scrollRef={scrollRef} rows={rowObjs.length} cols={cols} marks={marks} stepKey={ctx.event.index} />
      </div>
      <div className="array-foot">
        {panel.gridPointers.map((g) => (
          <span key={`${g.rowName},${g.colName}`} className="ptr-out">
            ({g.rowName}, {g.colName}) = ({g.r}, {g.c})
          </span>
        ))}
        {[...panel.rowPointers.map((x) => ({ ...x, axis: "row" })), ...panel.colPointers.map((x) => ({ ...x, axis: "column" }))]
          .filter((x) => x.outOfRange)
          .map((x) => (
            <span key={`${x.axis}-${x.name}`} className="ptr-out">
              {x.name} = {x.index} ({x.axis} out of range)
            </span>
          ))}
        {numeric && <HeatLegend min={min} max={max} />}
        {overlays.length > 0 && <span className="dim">Overlays mark cells contained in those collections.</span>}
      </div>
      <TruncationNote obj={outer} />
    </div>
  );
}

export function fmtCell(n: number): string {
  return fmtNum(n);
}
