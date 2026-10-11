import type { HeapObject, TraceEvent, TraceFrame, Value } from "./schema";
import { type Heap, valueKey } from "./values";

/**
 * Change detection between two recorded events. All indicators shown in the
 * UI are derived here by comparing adjacent snapshots — never from variable
 * names or assumptions about the algorithm.
 */

export type CellStatus = "same" | "new" | "changed";

export interface SequenceChange {
  kind: "sequence";
  /** status of every item in the AFTER object, by index */
  status: CellStatus[];
  /** items present before but gone now; `at` is the after-index they were removed before */
  removed: Array<{ value: Value; at: number; beforeIndex: number }>;
  lengthBefore: number;
  lengthAfter: number;
}

export interface MapChange {
  kind: "map";
  added: Set<string>;
  changed: Set<string>;
  removed: Array<[Value, Value]>;
}

export interface SetChange {
  kind: "set";
  added: Set<string>;
  removed: Value[];
}

export interface AttrChange {
  kind: "attrs";
  added: Set<string>;
  changed: Set<string>;
  removed: string[];
  /** previous values of changed attributes, for "was → now" labels */
  previous: Map<string, Value>;
}

export type ObjectChange = { isNew: true } | ({ isNew: false } & (SequenceChange | MapChange | SetChange | AttrChange | { kind: "opaque" }));

export interface VarChange {
  frameId: string;
  name: string;
  kind: "added" | "changed" | "removed";
  before?: Value;
  after?: Value;
  /** the variable now points at a different object (or primitive) */
  rebound: boolean;
}

export interface EventDiff {
  vars: VarChange[];
  /** objects in the AFTER heap that are new or whose contents changed */
  objects: Map<string, ObjectChange>;
  /** frames that appeared / disappeared */
  framesEntered: string[];
  framesExited: string[];
}

function itemKey(v: Value, heap: Heap): string {
  return valueKey(v, heap);
}

export function diffSequence(before: readonly Value[], hb: Heap, lenBefore: number, after: readonly Value[], ha: Heap, lenAfter: number): SequenceChange {
  const n = before.length;
  const m = after.length;
  const kb = before.map((v) => itemKey(v, hb));
  const ka = after.map((v) => itemKey(v, ha));
  let pre = 0;
  while (pre < n && pre < m && kb[pre] === ka[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && kb[n - 1 - suf] === ka[m - 1 - suf]) suf++;
  const status: CellStatus[] = new Array<CellStatus>(m).fill("same");
  const removed: SequenceChange["removed"] = [];
  const midB = n - pre - suf;
  const midA = m - pre - suf;
  // Middle region: compare positionally (changed only if different), the surplus is new/removed.
  const paired = Math.min(midA, midB);
  for (let i = 0; i < paired; i++) status[pre + i] = kb[pre + i] === ka[pre + i] ? "same" : "changed";
  for (let i = paired; i < midA; i++) status[pre + i] = "new";
  for (let i = paired; i < midB; i++) removed.push({ value: before[pre + i] as Value, at: pre + midA, beforeIndex: pre + i });
  return { kind: "sequence", status, removed, lengthBefore: lenBefore, lengthAfter: lenAfter };
}

function diffObject(b: HeapObject, hb: Heap, a: HeapObject, ha: Heap): ObjectChange | null {
  if (b === a) return null;
  if (b.kind !== a.kind) return { isNew: false, kind: "opaque" };
  switch (a.kind) {
    case "list":
    case "tuple":
    case "deque": {
      const bb = b as typeof a;
      const d = diffSequence(bb.items, hb, bb.length, a.items, ha, a.length);
      if (!d.removed.length && d.status.every((s) => s === "same") && bb.length === a.length) return null;
      return { isNew: false, ...d };
    }
    case "set": {
      const bb = b as typeof a;
      const before = new Map(bb.items.map((v) => [valueKey(v, hb), v] as const));
      const afterKeys = new Set(a.items.map((v) => valueKey(v, ha)));
      const added = new Set([...afterKeys].filter((k) => !before.has(k)));
      const removed = [...before.entries()].filter(([k]) => !afterKeys.has(k)).map(([, v]) => v);
      if (!added.size && !removed.length) return null;
      return { isNew: false, kind: "set", added, removed };
    }
    case "dict": {
      const bb = b as typeof a;
      const before = new Map(bb.entries.map(([k, v]) => [valueKey(k, hb), [k, v] as [Value, Value]] as const));
      const added = new Set<string>();
      const changed = new Set<string>();
      const seen = new Set<string>();
      for (const [k, v] of a.entries) {
        const key = valueKey(k, ha);
        seen.add(key);
        const prev = before.get(key);
        if (!prev) added.add(key);
        else if (itemKey(prev[1], hb) !== itemKey(v, ha)) changed.add(key);
      }
      const removed = [...before.entries()].filter(([k]) => !seen.has(k)).map(([, e]) => e);
      if (!added.size && !changed.size && !removed.length) return null;
      return { isNew: false, kind: "map", added, changed, removed };
    }
    case "object": {
      const bb = b as typeof a;
      const before = new Map(bb.attrs);
      const added = new Set<string>();
      const changed = new Set<string>();
      const previous = new Map<string, Value>();
      for (const [k, v] of a.attrs) {
        const prev = before.get(k);
        if (prev === undefined) added.add(k);
        else if (itemKey(prev, hb) !== itemKey(v, ha)) {
          changed.add(k);
          previous.set(k, prev);
        }
      }
      const after = new Set(a.attrs.map(([k]) => k));
      const removed = bb.attrs.map(([k]) => k).filter((k) => !after.has(k));
      if (!added.size && !changed.size && !removed.length) return null;
      return { isNew: false, kind: "attrs", added, changed, removed, previous };
    }
    default:
      return { isNew: false, kind: "opaque" };
  }
}

function frameVars(f: TraceFrame): Map<string, Value> {
  const m = new Map<string, Value>(f.locals);
  if (f.closure) for (const [k, v] of f.closure) if (!m.has(k)) m.set(k, v);
  return m;
}

function varKey(v: Value, heap: Heap): string {
  return v.t === "ref" ? `r:${v.id}` : valueKey(v, heap);
}

export function diffEvents(prev: TraceEvent | undefined, cur: TraceEvent): EventDiff {
  const objects = new Map<string, ObjectChange>();
  const vars: VarChange[] = [];
  if (!prev) {
    // The first event has no adjacent earlier state, so nothing is marked as changed.
    return { vars, objects, framesEntered: cur.stack.map((f) => f.id), framesExited: [] };
  }
  for (const [id, obj] of Object.entries(cur.heap)) {
    const p = prev.heap[id];
    if (!p) objects.set(id, { isNew: true });
    else {
      const c = diffObject(p, prev.heap, obj, cur.heap);
      if (c) objects.set(id, c);
    }
  }
  const prevFrames = new Map(prev.stack.map((f) => [f.id, f] as const));
  const curIds = new Set(cur.stack.map((f) => f.id));
  const framesEntered: string[] = [];
  for (const f of cur.stack) {
    const pf = prevFrames.get(f.id);
    if (!pf) {
      framesEntered.push(f.id);
      continue;
    }
    compareBindings(f.id, frameVars(pf), prev.heap, frameVars(f), cur.heap, vars);
  }
  compareBindings("globals", new Map(prev.globals), prev.heap, new Map(cur.globals), cur.heap, vars);
  const framesExited = prev.stack.filter((f) => !curIds.has(f.id)).map((f) => f.id);
  return { vars, objects, framesEntered, framesExited };
}

function compareBindings(frameId: string, before: Map<string, Value>, hb: Heap, after: Map<string, Value>, ha: Heap, out: VarChange[]): void {
  for (const [name, v] of after) {
    const p = before.get(name);
    if (p === undefined) out.push({ frameId, name, kind: "added", after: v, rebound: true });
    else if (varKey(p, hb) !== varKey(v, ha)) out.push({ frameId, name, kind: "changed", before: p, after: v, rebound: true });
  }
  for (const [name, p] of before) if (!after.has(name)) out.push({ frameId, name, kind: "removed", before: p, rebound: true });
}

/** Small LRU cache so scrubbing back and forth does not recompute diffs. */
export class DiffCache {
  private readonly map = new Map<string, EventDiff>();
  constructor(private readonly capacity = 64) {}
  get(prev: TraceEvent | undefined, cur: TraceEvent): EventDiff {
    const key = `${prev?.index ?? -1}:${cur.index}`;
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const d = diffEvents(prev, cur);
    this.map.set(key, d);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as string);
    return d;
  }
}
