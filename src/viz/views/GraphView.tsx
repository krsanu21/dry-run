import type { Value } from "../../trace/schema";
import { valueKey } from "../../trace/values";
import { bindingsFor, graphFromDict, graphFromList, type VizPanel } from "../model";
import { cellText, useViz } from "./common";

/**
 * Graphs from adjacency dicts (or list-of-lists when chosen manually). Node
 * status comes from other captured collections: membership in a set
 * (visited), position in a deque/list (queue/stack), values in dicts keyed by
 * node (distance / parent), and scalar variables equal to a node that the
 * code uses as an index.
 */
export function GraphView({ panel, indexVars }: { panel: VizPanel; indexVars: ReadonlySet<string> }): React.JSX.Element {
  const ctx = useViz();
  const heap = ctx.event.heap;
  const o = panel.rootId ? heap[panel.rootId] : undefined;
  const g = o ? (o.kind === "dict" ? graphFromDict(o, heap) : graphFromList(o, heap)) : null;
  if (!o || !g) return <div className="warn-note">This value is not an adjacency structure.</div>;
  if (g.nodes.length > 60) return <div className="warn-note">Graph has {g.nodes.length} nodes — too many to draw legibly. Use Raw data or Map view.</div>;
  const frame = ctx.event.stack[ctx.event.stack.length - 1];
  const bindings = bindingsFor(ctx.event, frame);
  const keyOf = (v: Value): string => (o.kind === "dict" ? valueKey(v, heap) : v.t === "int" ? `n:${v.v}` : valueKey(v, heap));
  const nodeKeys = new Set(g.nodes.map((n) => n.key));

  const sets: Array<{ name: string; members: Set<string> }> = [];
  const queues: Array<{ name: string; order: Map<string, number>; kind: string }> = [];
  const annotations: Array<{ name: string; values: Map<string, Value> }> = [];
  const current = new Map<string, string[]>();
  for (const b of bindings) {
    if (b.value.t !== "ref") {
      const k = keyOf(b.value);
      if (nodeKeys.has(k) && indexVars.has(b.name)) current.set(k, [...(current.get(k) ?? []), b.name]);
      continue;
    }
    if (b.value.id === panel.rootId) continue;
    const c = heap[b.value.id];
    if (!c) continue;
    if (c.kind === "set" && c.items.some((x) => nodeKeys.has(keyOf(x)))) sets.push({ name: b.name, members: new Set(c.items.map(keyOf)) });
    else if ((c.kind === "deque" || c.kind === "list") && c.items.length && c.items.every((x) => nodeKeys.has(keyOf(x))))
      queues.push({ name: b.name, order: new Map(c.items.map((x, i) => [keyOf(x), i] as const)), kind: c.kind === "deque" ? "queue" : "list" });
    else if (c.kind === "dict" && c.entries.length && c.entries.every(([k, v]) => nodeKeys.has(keyOf(k)) && v.t !== "ref"))
      annotations.push({ name: b.name, values: new Map(c.entries.map(([k, v]) => [keyOf(k), v] as const)) });
  }
  const R = Math.max(80, g.nodes.length * 14);
  const W = R * 2 + 120;
  const H = R * 2 + 90;
  const pos = new Map(
    g.nodes.map((n, i) => {
      const a = (2 * Math.PI * i) / g.nodes.length - Math.PI / 2;
      return [n.key, { x: W / 2 + R * Math.cos(a), y: H / 2 + R * Math.sin(a) }] as const;
    }),
  );
  const drawn = new Set<string>();
  const edges = g.edges.filter((e) => {
    if (g.directed) return true;
    const k = [e.from, e.to].sort().join("|");
    if (drawn.has(k)) return false;
    drawn.add(k);
    return true;
  });
  return (
    <div className="graph-view">
      <div className="svg-scroll">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Graph ${panel.names.join(", ")}`}>
          <defs>
            <marker id="garrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" className="arrow-head" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const fromCurrent = current.has(e.from);
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={`graph-edge${fromCurrent ? " from-current" : ""}`}
                {...(g.directed ? { markerEnd: "url(#garrow)" } : {})}
              />
            );
          })}
          {g.nodes.map((n) => {
            const p = pos.get(n.key) as { x: number; y: number };
            const inSets = sets.filter((s) => s.members.has(n.key));
            const inQueues = queues.filter((q) => q.order.has(n.key));
            const cur = current.get(n.key);
            const cls = ["graph-node", inSets.length ? "is-visited" : "", inQueues.length ? "is-queued" : "", cur ? "is-current" : ""].filter(Boolean).join(" ");
            const ann = annotations.map((a) => (a.values.has(n.key) ? `${a.name}=${cellText(a.values.get(n.key) as Value, heap, ctx.language, 6)}` : null)).filter(Boolean);
            return (
              <g key={n.key} className={cls} transform={`translate(${p.x},${p.y})`} data-testid={`gnode-${cellText(n.label, heap, ctx.language, 10)}`}>
                <circle r={16} />
                <text dy="0.35em" textAnchor="middle">
                  {cellText(n.label, heap, ctx.language, 5)}
                </text>
                {cur && (
                  <text className="node-ptr" y={-22} textAnchor="middle">
                    {cur.join(", ")}
                  </text>
                )}
                {inQueues.map((q) => (
                  <text key={q.name} className="q-badge" x={14} y={14}>
                    {q.order.get(n.key)}
                  </text>
                ))}
                {ann.length > 0 && (
                  <text className="node-ann" y={30} textAnchor="middle">
                    {ann.join(" ")}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="graph-legend">
        <span className="lg g-current">current ({[...current.values()].flat().join(", ") || "—"})</span>
        {sets.map((s) => (
          <span key={s.name} className="lg g-visited">
            in {s.name} ({s.members.size})
          </span>
        ))}
        {queues.map((q) => (
          <span key={q.name} className="lg g-queued">
            {q.kind} {q.name} (order shown)
          </span>
        ))}
        <span className="dim">{g.directed ? "directed edges" : "undirected (edges listed both ways)"}</span>
      </div>
    </div>
  );
}
