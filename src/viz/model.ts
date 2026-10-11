import type { IndexAccess, SourceAnalysis } from "../analysis/types";
import { evaluateSource, type Scope } from "../trace/expr";
import type { HeapObject, Language, SequenceObject, TraceEvent, TraceFrame, Value } from "../trace/schema";
import { type Heap, valueKey } from "../trace/values";

/**
 * Builds the visual model for one recorded event: which structures to draw,
 * how to draw them, and which variables act as pointers into them.
 *
 * Every inference here is evidence-based:
 *   - structure kinds come from the captured object graph (types and shapes),
 *   - pointer relationships come from subscript expressions in the parsed
 *     source (`nums[i]`, `grid[r][c]`, `s[lo:hi]`) evaluated against the
 *     snapshot — never from variable names alone,
 *   - "cells referenced by this line" are the index expressions on the
 *     current line evaluated against the recorded pre-line state.
 * The user can override any automatic choice.
 */

export type VizKind =
  | "array"
  | "string"
  | "grid"
  | "pairs"
  | "map"
  | "set"
  | "queue"
  | "heap"
  | "linked-list"
  | "tree"
  | "graph"
  | "object"
  | "raw";

export const VIZ_KIND_LABELS: Record<VizKind, string> = {
  array: "Array",
  string: "String cells",
  grid: "Grid",
  pairs: "List of pairs",
  map: "Map / dict",
  set: "Set",
  queue: "Queue / deque",
  heap: "Heap (array + tree)",
  "linked-list": "Linked list",
  tree: "Binary tree",
  graph: "Graph",
  object: "Object",
  raw: "Raw data",
};

export interface Binding {
  name: string;
  value: Value;
  /** where the binding lives */
  scope: "local" | "closure" | "global" | "attr";
}

export interface PointerMarker {
  name: string;
  index: number;
  /** index is outside 0..len-1 (shown beside the structure, not on a cell) */
  outOfRange: boolean;
  /** user added this pointer manually */
  manual?: boolean;
}

export interface CellRef {
  /** index path: [i] for arrays, [r, c] for grids */
  path: number[];
  role: "read" | "write";
  expr: string;
}

export interface GridOverlay {
  name: string;
  kind: "set" | "queue" | "list";
  cells: Array<{ r: number; c: number; order: number }>;
}

export interface GridPointer {
  rowName: string;
  colName: string;
  r: number;
  c: number;
}

export interface VizPanel {
  key: string;
  kind: VizKind;
  autoKind: VizKind;
  /** variable names that reference the root (aliases), in scope order */
  names: string[];
  value: Value;
  rootId?: string;
  priority: number;
  pointers: PointerMarker[];
  /** grid: (row, col) variable pairs addressing a cell */
  gridPointers: GridPointer[];
  /** row-only / col-only pointer variables for grids */
  rowPointers: PointerMarker[];
  colPointers: PointerMarker[];
  cellRefs: CellRef[];
  overlays: GridOverlay[];
  /** linked-list / tree panels: node ids referenced by variables (`outer`: held by another stack frame) */
  nodeRoots: Array<{ name: string; id: string; outer?: boolean }>;
  /** variables that could serve as pointers but are not shown (for the override menu) */
  candidatePointers: string[];
  /** linked-list / tree panels: node-pointer variables that are currently None/null */
  nullPointers: string[];
  /** the source writes into this structure by index (e.g. `dp[i] = …`) — treated as a table */
  writtenByIndex: boolean;
  note?: string;
}

export interface ModelOptions {
  overrides: Readonly<Record<string, VizKind>>;
  pointerOverrides: Readonly<Record<string, { add: string[]; hide: string[] }>>;
  /** names that referenced list/tree nodes at some event of the trace */
  historicalNodeVars?: ReadonlySet<string>;
}

const NODE_VALUE_ATTRS = ["val", "value", "data", "key", "item"];

export function bindingsFor(ev: TraceEvent, frame: TraceFrame | undefined): Binding[] {
  const out: Binding[] = [];
  const seen = new Set<string>();
  if (frame) {
    for (const [name, value] of frame.locals) {
      out.push({ name, value, scope: "local" });
      seen.add(name);
    }
    for (const [name, value] of frame.closure ?? []) {
      if (seen.has(name)) continue;
      out.push({ name, value, scope: "closure" });
      seen.add(name);
    }
  }
  for (const [name, value] of ev.globals) {
    if (seen.has(name)) continue;
    out.push({ name, value, scope: "global" });
    seen.add(name);
  }
  return out;
}

export function scopeForFrame(ev: TraceEvent, frame: TraceFrame | undefined): Scope {
  const pairs: Array<[string, Value]> = bindingsFor(ev, frame).map((b) => [b.name, b.value]);
  return { lookup: (n) => pairs.find(([k]) => k === n)?.[1], heap: ev.heap };
}

function isPrimitiveSeq(o: HeapObject): boolean {
  return (o.kind === "list" || o.kind === "tuple") && o.items.every((v) => v.t !== "ref");
}

function attrOf(o: HeapObject | undefined, name: string): Value | undefined {
  if (!o || o.kind !== "object") return undefined;
  return o.attrs.find(([k]) => k === name)?.[1];
}

export function isListNode(o: HeapObject | undefined): boolean {
  if (!o || o.kind !== "object") return false;
  const keys = new Set(o.attrs.map(([k]) => k));
  return keys.has("next") && !keys.has("left") && !keys.has("right");
}

export function isTreeNode(o: HeapObject | undefined): boolean {
  if (!o || o.kind !== "object") return false;
  const keys = new Set(o.attrs.map(([k]) => k));
  return keys.has("left") && keys.has("right");
}

export function nodeLabel(o: HeapObject | undefined): Value | undefined {
  if (!o || o.kind !== "object") return undefined;
  for (const a of NODE_VALUE_ATTRS) {
    const v = attrOf(o, a);
    if (v) return v;
  }
  return undefined;
}

function matrixShape(o: SequenceObject, heap: Heap): { rows: number; cols: number; rectangular: boolean } | null {
  if (o.items.length === 0) return null;
  let cols = -1;
  let rect = true;
  for (const it of o.items) {
    if (it.t !== "ref") return null;
    const row = heap[it.id];
    if (!row || (row.kind !== "list" && row.kind !== "tuple") || !isPrimitiveSeq(row)) return null;
    if (cols === -1) cols = row.length;
    else if (row.length !== cols) rect = false;
    cols = Math.max(cols, row.length);
  }
  return { rows: o.items.length, cols, rectangular: rect };
}

function looksLikeGraph(o: HeapObject, heap: Heap): boolean {
  if (o.kind !== "dict" || o.entries.length < 2) return false;
  const keys = new Set(o.entries.map(([k]) => valueKey(k, heap)));
  let neighbors = 0;
  let hits = 0;
  for (const [, v] of o.entries) {
    if (v.t !== "ref") return false;
    const c = heap[v.id];
    if (!c || (c.kind !== "list" && c.kind !== "set" && c.kind !== "tuple")) return false;
    for (const n of c.items) {
      if (n.t === "ref" && heap[n.id]?.kind !== "tuple") return false;
      neighbors++;
      if (keys.has(valueKey(n, heap))) hits++;
    }
  }
  return neighbors === 0 || hits / neighbors >= 0.5;
}

/** Function range containing a line (innermost), for scoping source accesses to a frame. */
function functionRange(analysis: SourceAnalysis | null, frame: TraceFrame | undefined): [number, number] | null {
  if (!analysis || !frame || frame.name === "<module>") return null;
  let best: [number, number] | null = null;
  for (const f of analysis.functions) {
    if (f.name !== frame.name && frame.name !== "<fragment>") continue;
    if (frame.line >= f.line && frame.line <= f.endLine) {
      if (!best || f.endLine - f.line < best[1] - best[0]) best = [f.line, f.endLine];
    }
  }
  return best;
}

export function accessesInScope(analysis: SourceAnalysis | null, frame: TraceFrame | undefined): IndexAccess[] {
  if (!analysis) return [];
  const range = functionRange(analysis, frame);
  return range ? analysis.accesses.filter((a) => a.line >= range[0] && a.line <= range[1]) : analysis.accesses;
}

export function classify(v: Value, heap: Heap, name: string, analysis: SourceAnalysis | null, indexedTwice: boolean): VizKind | null {
  if (v.t === "str") {
    const used = analysis?.accesses.some((a) => a.base === name);
    return used ? "string" : null;
  }
  if (v.t !== "ref") return null;
  const o = heap[v.id];
  if (!o) return null;
  switch (o.kind) {
    case "deque":
      return "queue";
    case "list":
    case "tuple": {
      if (analysis?.heapBases.includes(name) && isPrimitiveSeqOrTuples(o, heap)) return "heap";
      const shape = matrixShape(o, heap);
      if (shape) {
        if (indexedTwice) return "grid";
        if (shape.cols <= 3 && shape.rectangular && shape.cols > 0) return "pairs";
        return "grid";
      }
      return "array";
    }
    case "set":
      return "set";
    case "dict":
      return looksLikeGraph(o, heap) ? "graph" : "map";
    case "object":
      if (isListNode(o)) return "linked-list";
      if (isTreeNode(o)) return "tree";
      if (o.typeName === "Object") return "map";
      return "object";
    case "elided":
      return "raw";
    default:
      return null;
  }
}

function isPrimitiveSeqOrTuples(o: SequenceObject, heap: Heap): boolean {
  return o.items.every((v) => v.t !== "ref" || heap[v.id]?.kind === "tuple" || heap[v.id]?.kind === "list");
}

const PRIORITY: Record<VizKind, number> = {
  grid: 100,
  graph: 98,
  tree: 97,
  "linked-list": 96,
  heap: 90,
  array: 85,
  pairs: 84,
  string: 80,
  queue: 70,
  map: 60,
  set: 55,
  object: 30,
  raw: 20,
};

function intValue(v: Value | undefined): number | undefined {
  if (!v) return undefined;
  if (v.t === "int" && typeof v.v === "number") return v.v;
  if (v.t === "bool") return undefined;
  return undefined;
}

export interface BuildContext {
  event: TraceEvent;
  frame: TraceFrame | undefined;
  analysis: SourceAnalysis | null;
  language: Language;
  options: ModelOptions;
  /** additional named values to visualize (e.g. the value being returned) */
  extra?: Binding[];
}

export function buildPanels(ctx: BuildContext): VizPanel[] {
  const { event, frame, analysis, options } = ctx;
  const heap = event.heap;
  const bindings = [...bindingsFor(event, frame), ...(ctx.extra ?? [])];
  const scope = scopeForFrame(event, frame);
  const accesses = accessesInScope(analysis, frame);

  // Expand `self` / `this` attributes one level so `self.memo` gets its own panel.
  const expanded: Binding[] = [];
  for (const b of bindings) {
    const o = b.value.t === "ref" ? heap[b.value.id] : undefined;
    if ((b.name === "self" || b.name === "this") && o?.kind === "object" && !isListNode(o) && !isTreeNode(o)) {
      for (const [k, v] of o.attrs) expanded.push({ name: `${b.name}.${k}`, value: v, scope: "attr" });
      continue;
    }
    if (o && (o.kind === "function" || o.kind === "class" || o.kind === "other")) continue;
    expanded.push(b);
  }

  const twiceIndexed = new Set(accesses.filter((a) => a.indices.length >= 2).map((a) => a.base));
  const panels = new Map<string, VizPanel>();
  const order: string[] = [];
  const nodeGroups = new Map<string, VizPanel>();

  for (const b of expanded) {
    const override = options.overrides[b.name];
    const auto = classify(b.value, heap, b.name, analysis, twiceIndexed.has(b.name));
    if (!auto && !override) continue;
    let kind = override ?? (auto as VizKind);
    // Linked lists and trees are drawn as one diagram per node type with named pointers.
    if ((kind === "linked-list" || kind === "tree") && b.value.t === "ref") {
      const o = heap[b.value.id];
      const groupKey = `${kind}:${o?.typeName ?? "node"}`;
      let g = nodeGroups.get(groupKey);
      if (!g) {
        g = emptyPanel(groupKey, kind, auto ?? kind, b.value);
        nodeGroups.set(groupKey, g);
        panels.set(groupKey, g);
        order.push(groupKey);
      }
      g.names.push(b.name);
      g.nodeRoots.push({ name: b.name, id: b.value.id });
      continue;
    }
    if (b.value.t === "none" || (b.value.t === "ref" && !heap[b.value.id])) continue;
    const key = b.value.t === "ref" ? `obj:${b.value.id}` : `var:${b.name}`;
    const existing = panels.get(key);
    if (existing) {
      existing.names.push(b.name);
      if (override && !options.overrides[existing.names[0] as string]) existing.kind = override;
      continue;
    }
    if (kind === "linked-list" || kind === "tree") kind = "object";
    const p = emptyPanel(key, kind, auto ?? kind, b.value);
    p.names.push(b.name);
    if (b.value.t === "ref") p.rootId = b.value.id;
    panels.set(key, p);
    order.push(key);
  }

  // Nodes held by other active frames (e.g. outer recursive calls) belong in the same diagram;
  // they are labeled with their frame depth, e.g. "node@2".
  if (frame) {
    const depthOf = new Map(event.stack.map((f, i) => [f.id, i + 1] as const));
    for (const other of event.stack) {
      if (other.id === frame.id) continue;
      for (const [name, value] of other.locals) {
        if (value.t !== "ref") continue;
        const o = heap[value.id];
        const kind = isListNode(o) ? "linked-list" : isTreeNode(o) ? "tree" : null;
        if (!kind) continue;
        const groupKey = `${kind}:${o?.typeName ?? "node"}`;
        let g = nodeGroups.get(groupKey);
        if (!g) {
          g = emptyPanel(groupKey, kind, kind, value);
          nodeGroups.set(groupKey, g);
          panels.set(groupKey, g);
          order.push(groupKey);
        }
        const label = `${name}@${depthOf.get(other.id)}`;
        if (!g.nodeRoots.some((r) => r.id === value.id && r.name === label)) g.nodeRoots.push({ name: label, id: value.id, outer: true });
      }
    }
  }

  // Variables that held list/tree nodes elsewhere in the recorded trace but are None now
  // (e.g. `prev = None` at the start of a reversal) are shown as null pointers.
  for (const g of nodeGroups.values()) {
    for (const b of expanded) {
      if ((b.value.t === "none" || b.value.t === "undefined") && options.historicalNodeVars?.has(b.name) && !g.names.includes(b.name)) {
        g.nullPointers.push(b.name);
      }
    }
  }

  const result = order.map((k) => panels.get(k) as VizPanel);
  for (const p of result) {
    p.priority = PRIORITY[p.kind];
    decoratePanel(p, ctx, scope, accesses, bindings);
  }
  // Grid overlays need every panel's classification.
  for (const p of result) if (p.kind === "grid") p.overlays = gridOverlays(p, expanded, heap);
  return result.sort((a, b) => b.priority - a.priority || order.indexOf(a.key) - order.indexOf(b.key));
}

function emptyPanel(key: string, kind: VizKind, autoKind: VizKind, value: Value): VizPanel {
  return {
    key,
    kind,
    autoKind,
    names: [],
    value,
    priority: 0,
    pointers: [],
    gridPointers: [],
    rowPointers: [],
    colPointers: [],
    cellRefs: [],
    overlays: [],
    nodeRoots: [],
    candidatePointers: [],
    nullPointers: [],
    writtenByIndex: false,
  };
}

function baseMatches(p: VizPanel, base: string, scope: Scope): boolean {
  if (p.names.includes(base)) return true;
  if (!p.rootId) return false;
  const r = evaluateSource(base, scope);
  return r.ok && r.value.t === "ref" && r.value.id === p.rootId;
}

function lengthOfPanel(p: VizPanel, heap: Heap): number | undefined {
  if (p.value.t === "str") return p.value.v.length;
  const o = p.rootId ? heap[p.rootId] : undefined;
  return o && "length" in o && typeof o.length === "number" ? o.length : undefined;
}

function decoratePanel(p: VizPanel, ctx: BuildContext, scope: Scope, accesses: IndexAccess[], bindings: Binding[]): void {
  const heap = ctx.event.heap;
  const len = lengthOfPanel(p, heap);
  const relevant = accesses.filter((a) => baseMatches(p, a.base, scope));
  p.writtenByIndex = relevant.some((a) => a.write);
  const subscripts = relevant.filter((a) => a.kind !== "loop");
  const ov = ctx.options.pointerOverrides[p.names[0] ?? p.key] ?? { add: [], hide: [] };
  const sizes = new Set(ctx.analysis?.sizeNames ?? []);
  // A size variable only counts as a pointer if the code uses it bare as an index somewhere.
  const bareIndex = new Set(relevant.flatMap((a) => a.indices.filter((i) => /^[A-Za-z_$][\w$]*$/.test(i))));
  const scalarInt = (name: string): number | undefined =>
    sizes.has(name) && !bareIndex.has(name) ? undefined : intValue(bindings.find((b) => b.name === name)?.value);
  const allInts = bindings.filter((b) => intValue(b.value) !== undefined).map((b) => b.name);

  if (p.kind === "array" || p.kind === "string" || p.kind === "heap" || p.kind === "pairs" || p.kind === "queue") {
    const names = new Set<string>();
    for (const a of relevant) for (const n of a.indexNames[0] ?? []) if (scalarInt(n) !== undefined) names.add(n);
    for (const n of ov.add) if (scalarInt(n) !== undefined) names.add(n);
    for (const n of ov.hide) names.delete(n);
    if (len !== undefined) {
      for (const n of names) {
        const i = scalarInt(n) as number;
        p.pointers.push({ name: n, index: i, outOfRange: i < 0 || i >= len, ...(ov.add.includes(n) ? { manual: true } : {}) });
      }
    }
    p.candidatePointers = allInts.filter((n) => !names.has(n));
  }

  if (p.kind === "grid") {
    const rows = new Set<string>();
    const cols = new Set<string>();
    const pairs = new Map<string, [string, string]>();
    for (const a of relevant) {
      for (const n of a.indexNames[0] ?? []) if (scalarInt(n) !== undefined) rows.add(n);
      for (const n of a.indexNames[1] ?? []) if (scalarInt(n) !== undefined) cols.add(n);
      const r0 = a.indices[0];
      const c0 = a.indices[1];
      if (r0 && c0 && /^[A-Za-z_$][\w$]*$/.test(r0) && /^[A-Za-z_$][\w$]*$/.test(c0) && scalarInt(r0) !== undefined && scalarInt(c0) !== undefined)
        pairs.set(`${r0},${c0}`, [r0, c0]);
    }
    for (const n of ov.hide) {
      rows.delete(n);
      cols.delete(n);
    }
    const o = p.rootId ? heap[p.rootId] : undefined;
    const nRows = o && "length" in o ? (o.length as number) : 0;
    const shape = o && (o.kind === "list" || o.kind === "tuple") ? matrixShape(o, heap) : null;
    const nCols = shape?.cols ?? 0;
    for (const [rn, cn] of pairs.values()) {
      if (ov.hide.includes(rn) || ov.hide.includes(cn)) continue;
      const r = scalarInt(rn) as number;
      const c = scalarInt(cn) as number;
      if (r >= 0 && r < nRows && c >= 0 && c < nCols) p.gridPointers.push({ rowName: rn, colName: cn, r, c });
    }
    for (const n of rows) {
      const v = scalarInt(n) as number;
      p.rowPointers.push({ name: n, index: v, outOfRange: v < 0 || v >= nRows });
    }
    for (const n of cols) {
      const v = scalarInt(n) as number;
      p.colPointers.push({ name: n, index: v, outOfRange: v < 0 || v >= nCols });
    }
    p.candidatePointers = allInts.filter((n) => !rows.has(n) && !cols.has(n));
  }

  // Cells referenced by the line about to execute (line events only).
  if (ctx.event.type === "line" && (p.kind === "array" || p.kind === "grid" || p.kind === "string" || p.kind === "heap" || p.kind === "pairs")) {
    for (const a of subscripts) {
      if (a.line !== ctx.event.loc.line) continue;
      if (a.indices.some((i) => i.includes(":"))) continue;
      const path: number[] = [];
      let ok = true;
      for (const expr of a.indices.slice(0, p.kind === "grid" ? 2 : 1)) {
        const r = evaluateSource(expr, scope);
        if (!r.ok || r.value.t !== "int" || typeof r.value.v !== "number") {
          ok = false;
          break;
        }
        let idx = r.value.v;
        const bound = path.length === 0 ? len : undefined;
        if (idx < 0 && bound !== undefined) idx += bound;
        path.push(idx);
      }
      if (ok && path.length) {
        const exprText = `${a.base}${a.indices.map((i) => `[${i}]`).join("")}`;
        if (!p.cellRefs.some((c) => c.role === (a.write ? "write" : "read") && c.path.join() === path.join()))
          p.cellRefs.push({ path, role: a.write ? "write" : "read", expr: exprText });
      }
    }
  }
}

function gridOverlays(p: VizPanel, bindings: Binding[], heap: Heap): GridOverlay[] {
  const o = p.rootId ? heap[p.rootId] : undefined;
  if (!o || (o.kind !== "list" && o.kind !== "tuple")) return [];
  const shape = matrixShape(o, heap);
  if (!shape) return [];
  const out: GridOverlay[] = [];
  const cellOf = (v: Value): { r: number; c: number } | null => {
    if (v.t !== "ref") return null;
    const t = heap[v.id];
    if (!t || (t.kind !== "tuple" && t.kind !== "list") || t.items.length !== 2) return null;
    const [a, b] = t.items as [Value, Value];
    if (a.t !== "int" || b.t !== "int" || typeof a.v !== "number" || typeof b.v !== "number") return null;
    if (a.v < 0 || a.v >= shape.rows || b.v < 0 || b.v >= shape.cols) return null;
    return { r: a.v, c: b.v };
  };
  for (const b of bindings) {
    if (b.value.t !== "ref" || b.value.id === p.rootId) continue;
    const c = heap[b.value.id];
    if (!c) continue;
    let items: Value[] = [];
    let kind: GridOverlay["kind"] | null = null;
    if (c.kind === "set") {
      items = c.items;
      kind = "set";
    } else if (c.kind === "deque") {
      items = c.items;
      kind = "queue";
    } else if (c.kind === "list" && c.items.length && c.items.every((x) => cellOf(x))) {
      items = c.items;
      kind = "list";
    } else if (c.kind === "dict" && c.entries.length && c.entries.every(([k]) => cellOf(k))) {
      items = c.entries.map(([k]) => k);
      kind = "set";
    }
    if (!kind) continue;
    const cells: GridOverlay["cells"] = [];
    items.forEach((x, order) => {
      const cell = cellOf(x);
      if (cell) cells.push({ ...cell, order });
    });
    if (cells.length || (kind && items.length === 0)) out.push({ name: b.name, kind, cells });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Linked structures

export interface LinkedNode {
  id: string;
  label: Value | undefined;
  next: string | null;
  /** next points to an object that isn't a list node (or wasn't captured) */
  nextOther?: Value;
}

/** Collects list nodes reachable from the given roots via `.next` (cycle-safe). */
export function collectListNodes(roots: string[], heap: Heap, limit = 200): { nodes: Map<string, LinkedNode>; truncated: boolean } {
  const nodes = new Map<string, LinkedNode>();
  let truncated = false;
  for (const r of roots) {
    let cur: string | null = r;
    while (cur && !nodes.has(cur)) {
      if (nodes.size >= limit) {
        truncated = true;
        break;
      }
      const o: HeapObject | undefined = heap[cur];
      if (!o || o.kind !== "object") {
        if (o?.kind === "elided") truncated = true;
        break;
      }
      const nx = attrOf(o, "next");
      const nxObj = nx && nx.t === "ref" ? heap[nx.id] : undefined;
      const nextId = nx && nx.t === "ref" && nxObj && isListNode(nxObj) ? nx.id : null;
      const node: LinkedNode = { id: cur, label: nodeLabel(o), next: nextId };
      if (nx && nx.t === "ref" && !nextId) node.nextOther = nx;
      nodes.set(cur, node);
      cur = nextId;
    }
  }
  return { nodes, truncated };
}

export interface TreeLayoutNode {
  id: string;
  label: Value | undefined;
  x: number;
  depth: number;
  left: string | null;
  right: string | null;
}

/**
 * Tidy-ish binary tree layout: in-order index gives x, depth gives y.
 * Returns null if the object graph is not a tree (shared child or cycle) so
 * the caller can fall back to a general object-graph view.
 */
export function layoutTree(rootId: string, heap: Heap, limit = 255): { nodes: TreeLayoutNode[]; width: number; height: number; truncated: boolean } | null {
  const nodes: TreeLayoutNode[] = [];
  const seen = new Set<string>();
  let x = 0;
  let maxDepth = 0;
  let truncated = false;
  let notTree = false;
  const childId = (o: HeapObject, k: string): string | null => {
    const v = attrOf(o, k);
    if (!v || v.t !== "ref") return null;
    const c = heap[v.id];
    if (!c) return null;
    if (c.kind === "elided") {
      truncated = true;
      return null;
    }
    return isTreeNode(c) ? v.id : null;
  };
  const visit = (id: string, depth: number): void => {
    if (notTree) return;
    if (seen.has(id)) {
      notTree = true;
      return;
    }
    if (nodes.length >= limit) {
      truncated = true;
      return;
    }
    seen.add(id);
    const o = heap[id] as HeapObject;
    const l = childId(o, "left");
    const r = childId(o, "right");
    const node: TreeLayoutNode = { id, label: nodeLabel(o), x: 0, depth, left: l, right: r };
    if (l) visit(l, depth + 1);
    node.x = x++;
    nodes.push(node);
    maxDepth = Math.max(maxDepth, depth);
    if (r) visit(r, depth + 1);
  };
  visit(rootId, 0);
  if (notTree) return null;
  return { nodes, width: x, height: maxDepth + 1, truncated };
}

/** Roots of a set of tree nodes: those not reachable as a child of another referenced node. */
export function treeRoots(ids: string[], heap: Heap): string[] {
  const descendants = new Set<string>();
  const walk = (id: string, guard: Set<string>): void => {
    if (guard.has(id)) return;
    guard.add(id);
    const o = heap[id];
    for (const k of ["left", "right"]) {
      const v = attrOf(o, k);
      if (v && v.t === "ref" && isTreeNode(heap[v.id])) {
        descendants.add(v.id);
        walk(v.id, guard);
      }
    }
  };
  for (const id of ids) walk(id, new Set());
  const out: string[] = [];
  for (const id of ids) if (!descendants.has(id) && !out.includes(id)) out.push(id);
  return out;
}

// ---------------------------------------------------------------------------
// Graphs

export interface GraphModel {
  nodes: Array<{ key: string; label: Value }>;
  edges: Array<{ from: string; to: string }>;
  directed: boolean;
}

export function graphFromDict(o: HeapObject, heap: Heap): GraphModel | null {
  if (o.kind !== "dict") return null;
  const nodes = new Map<string, Value>();
  const edges: GraphModel["edges"] = [];
  for (const [k, v] of o.entries) {
    const key = valueKey(k, heap);
    if (!nodes.has(key)) nodes.set(key, k);
    const c = v.t === "ref" ? heap[v.id] : undefined;
    if (!c || (c.kind !== "list" && c.kind !== "set" && c.kind !== "tuple")) continue;
    for (const n of c.items) {
      const nk = valueKey(n, heap);
      if (!nodes.has(nk)) nodes.set(nk, n);
      edges.push({ from: key, to: nk });
    }
  }
  const set = new Set(edges.map((e) => `${e.from}->${e.to}`));
  const directed = edges.some((e) => !set.has(`${e.to}->${e.from}`));
  return { nodes: [...nodes].map(([key, label]) => ({ key, label })), edges, directed };
}

/** Adjacency list given as list-of-lists of node indices (only when the user selects the Graph view). */
export function graphFromList(o: HeapObject, heap: Heap): GraphModel | null {
  if (o.kind !== "list" && o.kind !== "tuple") return null;
  const nodes: GraphModel["nodes"] = o.items.map((_, i) => ({ key: `n:${i}`, label: { t: "int", v: i } as Value }));
  const edges: GraphModel["edges"] = [];
  o.items.forEach((row, i) => {
    const c = row.t === "ref" ? heap[row.id] : undefined;
    if (!c || (c.kind !== "list" && c.kind !== "set" && c.kind !== "tuple")) return;
    for (const n of c.items) {
      if (n.t === "int" && typeof n.v === "number") {
        if (!nodes[n.v]) return;
        edges.push({ from: `n:${i}`, to: `n:${n.v}` });
      }
    }
  });
  const set = new Set(edges.map((e) => `${e.from}->${e.to}`));
  const directed = edges.some((e) => !set.has(`${e.to}->${e.from}`));
  return { nodes, edges, directed };
}

/** Number of incoming references to each object (variables + other objects). */
export function referenceCounts(ev: TraceEvent): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (v: Value): void => {
    if (v.t === "ref") counts.set(v.id, (counts.get(v.id) ?? 0) + 1);
  };
  for (const f of ev.stack) {
    for (const [, v] of f.locals) bump(v);
    for (const [, v] of f.closure ?? []) bump(v);
  }
  for (const [, v] of ev.globals) bump(v);
  for (const o of Object.values(ev.heap)) {
    if (o.kind === "list" || o.kind === "tuple" || o.kind === "set" || o.kind === "deque") o.items.forEach(bump);
    else if (o.kind === "dict") o.entries.forEach(([k, v]) => (bump(k), bump(v)));
    else if (o.kind === "object") o.attrs.forEach(([, v]) => bump(v));
  }
  return counts;
}
