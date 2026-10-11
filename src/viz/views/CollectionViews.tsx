import type { DictObject, HeapObject, SequenceObject } from "../../trace/schema";
import { valueKey } from "../../trace/values";
import type { VizPanel } from "../model";
import { ArrayView } from "./ArrayView";
import { cellText, changeOf, TruncationNote, useViz, ValueInline } from "./common";

/** Dictionaries, Counters, defaultdicts, JS Maps and plain objects used as maps. */
export function MapView({ panel }: { panel: VizPanel }): React.JSX.Element {
  const ctx = useViz();
  const o = panel.rootId ? ctx.event.heap[panel.rootId] : undefined;
  if (!o) return <TruncationNote obj={o} />;
  const ch = changeOf(ctx, panel.rootId);
  const prevObj = panel.rootId ? ctx.prev?.heap[panel.rootId] : undefined;
  let entries: Array<{ key: string; k: React.ReactNode; v: React.ReactNode; status: string; was?: string }> = [];
  if (o.kind === "dict") {
    const prevMap = new Map(prevObj && prevObj.kind === "dict" ? prevObj.entries.map(([k, v]) => [valueKey(k, ctx.prev?.heap ?? {}), v] as const) : []);
    entries = o.entries.map(([k, v]) => {
      const key = valueKey(k, ctx.event.heap);
      const status = ch?.isNew ? "new" : ch && !ch.isNew && ch.kind === "map" ? (ch.added.has(key) ? "new" : ch.changed.has(key) ? "changed" : "same") : "same";
      const pv = status === "changed" ? prevMap.get(key) : undefined;
      return {
        key,
        k: <ValueInline v={k} max={24} />,
        v: <ValueInline v={v} max={40} />,
        status,
        ...(pv ? { was: cellText(pv, ctx.prev?.heap ?? {}, ctx.language, 16) } : {}),
      };
    });
  } else if (o.kind === "object") {
    const prevAttrs = new Map(prevObj && prevObj.kind === "object" ? prevObj.attrs : []);
    entries = o.attrs.map(([k, v]) => {
      const status = ch?.isNew ? "new" : ch && !ch.isNew && ch.kind === "attrs" ? (ch.added.has(k) ? "new" : ch.changed.has(k) ? "changed" : "same") : "same";
      const pv = status === "changed" ? prevAttrs.get(k) : undefined;
      return {
        key: k,
        k: <span className="prim prim-str">{ctx.language === "python" ? k : JSON.stringify(k)}</span>,
        v: <ValueInline v={v} max={40} />,
        status,
        ...(pv ? { was: cellText(pv, ctx.prev?.heap ?? {}, ctx.language, 16) } : {}),
      };
    });
  }
  const removed =
    ch && !ch.isNew && ch.kind === "map"
      ? ch.removed.map(([k]) => cellText(k, ctx.prev?.heap ?? {}, ctx.language, 16))
      : ch && !ch.isNew && ch.kind === "attrs"
        ? ch.removed
        : [];
  const dict = o.kind === "dict" ? (o as DictObject) : null;
  return (
    <div className="map-view">
      {dict?.defaultFactory && <div className="dim small">default factory: {dict.defaultFactory}</div>}
      {dict?.typeName === "Counter" && <div className="dim small">Counter — keys shown in insertion order</div>}
      {entries.length === 0 ? (
        <div className="empty-note">empty {o.typeName}</div>
      ) : (
        <table className="kv-table">
          <tbody>
            {entries.map((e) => (
              <tr key={e.key} className={`st-${e.status}`} data-status={e.status}>
                <td className="kv-k">{e.k}</td>
                <td className="kv-arrow" aria-hidden>
                  →
                </td>
                <td className="kv-v">
                  {e.v}
                  {e.status === "new" && <span className="badge badge-new inline">+</span>}
                  {e.status === "changed" && <span className="badge badge-changed inline">Δ</span>}
                  {e.was !== undefined && <span className="was inline">was {e.was}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {removed.length > 0 && <div className="removed-note">− removed keys: {removed.join(", ")}</div>}
      <TruncationNote obj={o} />
    </div>
  );
}

export function SetView({ panel }: { panel: VizPanel }): React.JSX.Element {
  const ctx = useViz();
  const o = panel.rootId ? ctx.event.heap[panel.rootId] : undefined;
  if (!o || o.kind !== "set") return <TruncationNote obj={o} />;
  const ch = changeOf(ctx, panel.rootId);
  const added = ch && !ch.isNew && ch.kind === "set" ? ch.added : null;
  const removed = ch && !ch.isNew && ch.kind === "set" ? ch.removed : [];
  return (
    <div className="set-view">
      <div className="dim small">unordered — iteration order as captured, not sorted</div>
      <div className="chips">
        {o.items.length === 0 && <span className="empty-note">empty set</span>}
        {o.items.map((v) => {
          const key = valueKey(v, ctx.event.heap);
          const isNew = ch?.isNew || added?.has(key);
          return (
            <span key={key} className={`chip${isNew ? " st-new" : ""}`} data-status={isNew ? "new" : "same"}>
              <ValueInline v={v} max={20} />
              {isNew && <span className="badge badge-new inline">+</span>}
            </span>
          );
        })}
        {removed.map((v, i) => (
          <span key={`rm${i}`} className="chip st-removed" data-status="removed" title="removed since previous step">
            {cellText(v, ctx.prev?.heap ?? {}, ctx.language, 20)}
          </span>
        ))}
      </div>
      <TruncationNote obj={o} />
    </div>
  );
}

/** deque / queue: order is explicit with front and back labels. */
export function QueueView({ panel }: { panel: VizPanel }): React.JSX.Element {
  const ctx = useViz();
  const o = panel.rootId ? ctx.event.heap[panel.rootId] : undefined;
  if (!o || (o.kind !== "deque" && o.kind !== "list")) return <TruncationNote obj={o} />;
  const ch = changeOf(ctx, panel.rootId);
  const seq = ch && !ch.isNew && ch.kind === "sequence" ? ch : null;
  const prev = panel.rootId ? (ctx.prev?.heap[panel.rootId] as SequenceObject | undefined) : undefined;
  const removedFront = seq?.removed.filter((r) => r.beforeIndex === 0 || r.at === 0) ?? [];
  const removedBack = seq?.removed.filter((r) => !removedFront.includes(r)) ?? [];
  return (
    <div className="queue-view">
      <div className="queue-row">
        {removedFront.map((r, i) => (
          <span key={`rf${i}`} className="q-item st-removed" title="removed from the front at this step">
            {cellText(r.value, ctx.prev?.heap ?? {}, ctx.language, 14)}
            <small>out</small>
          </span>
        ))}
        <span className="q-end">front</span>
        {o.items.length === 0 && <span className="empty-note">empty</span>}
        {o.items.map((v, i) => {
          const st = ch?.isNew ? "new" : seq?.status[i] ?? "same";
          return (
            <span key={i} className={`q-item st-${st}`} data-status={st} data-testid={`q-${i}`}>
              <ValueInline v={v} max={16} />
              {st === "new" && <span className="badge badge-new inline">+</span>}
              {st === "changed" && <span className="badge badge-changed inline">Δ</span>}
            </span>
          );
        })}
        <span className="q-end">back</span>
        {removedBack.map((r, i) => (
          <span key={`rb${i}`} className="q-item st-removed" title="removed at this step">
            {cellText(r.value, ctx.prev?.heap ?? {}, ctx.language, 14)}
            <small>out</small>
          </span>
        ))}
      </div>
      <div className="dim small">
        {o.length} item{o.length === 1 ? "" : "s"}
        {"maxlen" in o && o.maxlen !== undefined ? ` · maxlen ${o.maxlen}` : ""}
        {prev && prev.length !== o.length ? ` · was ${prev.length}` : ""}
      </div>
      <TruncationNote obj={o} />
    </div>
  );
}

/** heapq list: the underlying array and its implicit binary-tree interpretation. */
export function HeapView({ panel }: { panel: VizPanel }): React.JSX.Element {
  const ctx = useViz();
  const o = panel.rootId ? ctx.event.heap[panel.rootId] : undefined;
  if (!o || o.kind !== "list") return <TruncationNote obj={o} />;
  const ch = changeOf(ctx, panel.rootId);
  const seq = ch && !ch.isNew && ch.kind === "sequence" ? ch : null;
  const status = ch?.isNew ? o.items.map(() => "new" as const) : seq?.status;
  const prev = panel.rootId ? (ctx.prev?.heap[panel.rootId] as SequenceObject | undefined) : undefined;
  const n = o.items.length;
  const levels = n ? Math.floor(Math.log2(n)) + 1 : 0;
  const W = Math.max(240, 2 ** Math.max(0, levels - 1) * 56);
  const H = levels * 54 + 10;
  const pos = (i: number): { x: number; y: number } => {
    const d = Math.floor(Math.log2(i + 1));
    const first = 2 ** d - 1;
    const slots = 2 ** d;
    return { x: ((i - first + 0.5) / slots) * W, y: d * 54 + 24 };
  };
  return (
    <div className="heap-view">
      <ArrayView
        items={o.items}
        length={o.length}
        truncated={o.truncated}
        status={status}
        removed={seq?.removed}
        prevItems={prev?.items}
        pointers={panel.pointers}
        cellRefs={panel.cellRefs}
        variant="heap"
        label={`Heap array ${panel.names.join(", ")}`}
      />
      {n > 0 && n <= 63 && (
        <svg className="heap-tree" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Heap as a binary tree">
          {o.items.map((_, i) => {
            if (i === 0) return null;
            const a = pos(Math.floor((i - 1) / 2));
            const b = pos(i);
            return <line key={`e${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="tree-edge" />;
          })}
          {o.items.map((v, i) => {
            const p = pos(i);
            const st = status?.[i] ?? "same";
            return (
              <g key={i} className={`tree-node st-${st}`} transform={`translate(${p.x},${p.y})`}>
                <circle r={17} />
                <text dy="0.35em" textAnchor="middle">
                  {cellText(v, ctx.event.heap, ctx.language, 5)}
                </text>
                <text className="heap-idx" dy="2.4em" textAnchor="middle">
                  {i}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {n > 63 && <div className="dim small">Tree view hidden for heaps larger than 63 items.</div>}
      <div className="dim small">Root (index 0) is the smallest item for a heapq min-heap. Parent of i is (i−1)//2.</div>
    </div>
  );
}

export function isOpaque(o: HeapObject | undefined): boolean {
  return !o || o.kind === "function" || o.kind === "class" || o.kind === "other";
}
