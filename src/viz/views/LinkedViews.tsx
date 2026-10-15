import type { TraceFrame } from "../../trace/schema";
import { collectListNodes, layoutTree, treeRoots, type VizPanel } from "../model";
import { cellText, changeOf, useViz } from "./common";

const NODE_W = 64;
const NODE_H = 34;
const GAP_X = 46;

/**
 * Linked lists: nodes are placed by the order their identity was first seen in
 * the trace, so a node keeps its position while its `.next` arrow changes —
 * reversal reads as arrows flipping, not nodes jumping around.
 */
export function LinkedListView({ panel }: { panel: VizPanel }): React.JSX.Element {
  const ctx = useViz();
  const heap = ctx.event.heap;
  const roots = panel.nodeRoots.map((r) => r.id);
  const { nodes, truncated } = collectListNodes(roots, heap);
  if (nodes.size === 0) return <div className="empty-note">no nodes</div>;
  const ordered = [...nodes.values()].sort((a, b) => (ctx.firstSeen.get(a.id) ?? 0) - (ctx.firstSeen.get(b.id) ?? 0));
  const col = new Map(ordered.map((n, i) => [n.id, i] as const));
  const labels = new Map<string, string[]>();
  for (const r of panel.nodeRoots) labels.set(r.id, [...(labels.get(r.id) ?? []), r.name]);
  const maxLabels = Math.max(1, ...[...labels.values()].map((l) => l.length));
  const top = 26 + maxLabels * 16;
  const W = ordered.length * (NODE_W + GAP_X) + 40;
  const H = top + NODE_H + 70;
  const x = (id: string): number => 10 + (col.get(id) ?? 0) * (NODE_W + GAP_X);
  const cy = top + NODE_H / 2;
  const prevHeap = ctx.prev?.heap;

  return (
    <div className="ll-view">
      <div className="svg-scroll">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Linked list with pointers ${panel.names.join(", ")}`}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="arrow-head" />
            </marker>
            <marker id="arrow-chg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="arrow-head-chg" />
            </marker>
          </defs>
          {ordered.map((n) => {
            const ch = changeOf(ctx, n.id);
            const nextChanged = !!ch && !ch.isNew && ch.kind === "attrs" && ch.changed.has("next");
            const x1 = x(n.id) + NODE_W;
            if (!n.next) {
              return (
                <g key={`e${n.id}`} className={nextChanged ? "edge-chg" : ""}>
                  <line x1={x1 - 14} y1={cy} x2={x1 + 12} y2={cy} className="ll-null-line" />
                  <text x={x1 + 14} y={cy} dy="0.35em" className="ll-null">
                    {n.nextOther ? "→ obj" : ctx.language === "python" ? "None" : "null"}
                  </text>
                </g>
              );
            }
            const fwd = (col.get(n.next) ?? 0) > (col.get(n.id) ?? 0);
            const adjacent = fwd && (col.get(n.next) ?? 0) === (col.get(n.id) ?? 0) + 1;
            const x2 = fwd ? x(n.next) : x(n.next) + NODE_W / 2;
            let d: string;
            if (adjacent) d = `M${x1 - 12},${cy} L${x2 - 2},${cy}`;
            else if (fwd) d = `M${x1 - 12},${cy + 8} C${x1 + 20},${cy + 50} ${x2 - 30},${cy + 50} ${x2 - 2},${cy + 8}`;
            else {
              const sx = x(n.id) + NODE_W / 2;
              d = `M${sx},${top + NODE_H} C${sx},${top + NODE_H + 46} ${x2},${top + NODE_H + 46} ${x2},${top + NODE_H + 2}`;
            }
            const wasNext = nextChanged && ch && !ch.isNew && ch.kind === "attrs" ? ch.previous.get("next") : undefined;
            return (
              <g key={`e${n.id}`} className={nextChanged ? "edge-chg" : ""}>
                <path d={d} className="ll-edge" markerEnd={`url(#${nextChanged ? "arrow-chg" : "arrow"})`} fill="none">
                  <title>
                    {`next of node #${n.id}${nextChanged ? ` changed (was ${wasNext && prevHeap ? cellText(wasNext, prevHeap, ctx.language, 20) : "?"})` : ""}`}
                  </title>
                </path>
              </g>
            );
          })}
          {ordered.map((n) => {
            const ch = changeOf(ctx, n.id);
            const st = ch?.isNew ? "new" : ch ? "changed" : "same";
            const names = labels.get(n.id) ?? [];
            const shared = (ctx.refCounts.get(n.id) ?? 0) > 1;
            return (
              <g key={n.id} className={`ll-node st-${st}${ctx.peek?.objectId === n.id ? " is-peeked" : ""}`} transform={`translate(${x(n.id)},${top})`} data-testid={`node-${n.id}`}>
                {names.map((nm, k) => (
                  <text key={nm} x={NODE_W / 2} y={-18 - k * 16} textAnchor="middle" className={`node-ptr${nm.includes("@") ? " outer" : ""}`}>
                    {nm} ↓
                  </text>
                ))}
                <rect width={NODE_W} height={NODE_H} rx={4} />
                <line x1={NODE_W - 16} y1={0} x2={NODE_W - 16} y2={NODE_H} className="ll-divider" />
                <text x={(NODE_W - 16) / 2} y={NODE_H / 2} dy="0.35em" textAnchor="middle" className="node-val">
                  {n.label ? cellText(n.label, heap, ctx.language, 6) : "?"}
                </text>
                <circle cx={NODE_W - 8} cy={NODE_H / 2} r={2.5} className="ll-dot" />
                {shared && (
                  <text x={NODE_W / 2} y={-5} textAnchor="middle" className="node-id">
                    ⧉
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="array-foot">
        {panel.nullPointers.map((n) => (
          <span key={n} className="ptr-out">
            {n} → {ctx.language === "python" ? "None" : "null"}
          </span>
        ))}
        {truncated && <span className="trunc-inline">⚠ list longer than the display/snapshot limit — some nodes not shown</span>}
        {detectCycle(ordered) && <span className="cycle-note">↻ cycle detected</span>}
      </div>
    </div>
  );
}

function detectCycle(nodes: Array<{ id: string; next: string | null }>): boolean {
  const next = new Map(nodes.map((n) => [n.id, n.next] as const));
  for (const start of next.keys()) {
    const seen = new Set<string>();
    let cur: string | null | undefined = start;
    while (cur) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = next.get(cur);
    }
  }
  return false;
}

/**
 * Binary trees laid out by in-order position. Nodes referenced by variables of
 * the selected frame are labeled; nodes that are arguments of active stack
 * frames are highlighted as the recursion path.
 */
export function TreeView({ panel, stack }: { panel: VizPanel; stack: readonly TraceFrame[] }): React.JSX.Element {
  const ctx = useViz();
  const heap = ctx.event.heap;
  const roots = treeRoots(
    panel.nodeRoots.map((r) => r.id),
    heap,
  );
  const layouts = roots.map((r) => ({ root: r, layout: layoutTree(r, heap) }));
  if (layouts.some((l) => l.layout === null))
    return <div className="warn-note">These nodes do not form a tree (a node is shared or there is a cycle). Showing them as a tree would misrepresent the object graph — choose “Raw data” or inspect nodes individually.</div>;
  const labels = new Map<string, string[]>();
  for (const r of panel.nodeRoots) if (!r.outer) labels.set(r.id, [...(labels.get(r.id) ?? []), r.name]);
  const pathDepth = new Map<string, number>();
  stack.forEach((f, depth) => {
    for (const [, v] of f.args.length ? f.locals.filter(([k]) => f.args.includes(k)) : []) if (v.t === "ref") pathDepth.set(v.id, depth);
  });
  const XS = 46;
  const YS = 58;
  let offset = 0;
  const placed = layouts.map(({ root, layout }) => {
    const l = layout as NonNullable<typeof layout>;
    const out = { root, layout: l, offset };
    offset += l.width;
    return out;
  });
  const W = Math.max(200, offset * XS + 20);
  const H = Math.max(...placed.map((p) => p.layout.height), 1) * YS + 40;
  return (
    <div className="tree-view">
      <div className="svg-scroll">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Binary tree ${panel.names.join(", ")}`}>
          {placed.map(({ layout, offset: off }) => {
            const byId = new Map(layout.nodes.map((n) => [n.id, n] as const));
            const px = (n: { x: number }): number => 20 + (n.x + off) * XS + XS / 2 - 10;
            const py = (n: { depth: number }): number => 30 + n.depth * YS;
            return (
              <g key={`t${off}`}>
                {layout.nodes.flatMap((n) =>
                  (["left", "right"] as const)
                    .map((side) => {
                      const cid = n[side];
                      if (!cid) return null;
                      const c = byId.get(cid);
                      if (!c) return null;
                      const ch = changeOf(ctx, n.id);
                      const changed = !!ch && !ch.isNew && ch.kind === "attrs" && ch.changed.has(side);
                      return <line key={`${n.id}${side}`} x1={px(n)} y1={py(n)} x2={px(c)} y2={py(c)} className={`tree-edge${changed ? " edge-chg" : ""}`} />;
                    })
                    .filter(Boolean),
                )}
                {layout.nodes.map((n) => {
                  const ch = changeOf(ctx, n.id);
                  const st = ch?.isNew ? "new" : ch ? "changed" : "same";
                  const names = labels.get(n.id) ?? [];
                  const onPath = pathDepth.has(n.id);
                  return (
                    <g
                      key={n.id}
                      className={`tree-node st-${st}${names.length ? " is-pointed" : ""}${onPath ? " on-path" : ""}${ctx.peek?.objectId === n.id ? " is-peeked" : ""}`}
                      transform={`translate(${px(n)},${py(n)})`}
                      data-testid={`tnode-${n.id}`}
                    >
                      <circle r={16} />
                      <text dy="0.35em" textAnchor="middle">
                        {n.label ? cellText(n.label, heap, ctx.language, 5) : "?"}
                      </text>
                      {names.length > 0 && (
                        <text className="node-ptr" y={-22} textAnchor="middle">
                          {names.join(", ")}
                        </text>
                      )}
                      {onPath && (
                        <text className="path-depth" x={18} y={-10}>
                          {`f${(pathDepth.get(n.id) ?? 0) + 1}`}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="array-foot">
        {panel.nullPointers.map((n) => (
          <span key={n} className="ptr-out">
            {n} → {ctx.language === "python" ? "None" : "null"}
          </span>
        ))}
        {placed.some((p) => p.layout.truncated) && <span className="trunc-inline">⚠ tree truncated (display or snapshot limit)</span>}
        {pathDepth.size > 0 && <span className="dim">Outlined nodes are arguments of active calls (f1 = outermost frame).</span>}
      </div>
    </div>
  );
}
