import type { HeapObject, Language, TraceEvent, Value } from "./schema";
import type { Trace } from "./store";
import { formatValue, valueKey } from "./values";

/**
 * Variable history from recorded snapshots only (no re-execution).
 * A segment is a maximal run of events where the variable is bound to the
 * same primitive value or the same object identity. For objects, events where
 * the object's *contents* changed are listed separately, so identity changes
 * (rebinding) and mutations are distinguishable.
 */
export interface HistorySegment {
  from: number;
  to: number;
  /** value text at the start of the segment */
  text: string;
  /** set when the variable is bound to an object */
  objectId?: string;
  /** event indices within the segment where the object's contents changed */
  mutations: number[];
}

export interface VariableHistory {
  name: string;
  frameId: string;
  frameName: string;
  segments: HistorySegment[];
  /** gaps where the frame was active but the variable was not bound */
  unboundRanges: Array<{ from: number; to: number }>;
}

function lookup(ev: TraceEvent, frameId: string, name: string): { frameActive: boolean; value?: Value } {
  if (frameId === "globals") {
    const g = ev.globals.find(([k]) => k === name)?.[1];
    if (g) return { frameActive: true, value: g };
    const mod = ev.stack.find((f) => f.name === "<module>");
    const v = mod?.locals.find(([k]) => k === name)?.[1];
    return v ? { frameActive: true, value: v } : { frameActive: ev.globals.length > 0 || !!mod };
  }
  const f = ev.stack.find((fr) => fr.id === frameId);
  if (!f) return { frameActive: false };
  const v = f.locals.find(([k]) => k === name)?.[1] ?? f.closure?.find(([k]) => k === name)?.[1];
  return v ? { frameActive: true, value: v } : { frameActive: true };
}

export function variableHistory(trace: Trace, frameId: string, name: string, lang: Language, upTo = Infinity): VariableHistory {
  const segments: HistorySegment[] = [];
  const unbound: Array<{ from: number; to: number }> = [];
  let cur: (HistorySegment & { key: string; lastObj?: HeapObject }) | null = null;
  let gap: { from: number; to: number } | null = null;
  let frameName = frameId === "globals" ? "globals" : "";
  const end = Math.min(trace.length - 1, upTo);
  for (let i = 0; i <= end; i++) {
    const ev = trace.events[i] as TraceEvent;
    if (!frameName) frameName = ev.stack.find((f) => f.id === frameId)?.name ?? "";
    const { frameActive, value } = lookup(ev, frameId, name);
    if (!value) {
      if (cur) {
        segments.push(strip(cur));
        cur = null;
      }
      if (frameActive) {
        if (gap && gap.to === i - 1) gap.to = i;
        else {
          gap = { from: i, to: i };
          unbound.push(gap);
        }
      }
      continue;
    }
    const key = value.t === "ref" ? `r:${value.id}` : valueKey(value, ev.heap);
    if (cur && cur.key === key && cur.to === i - 1) {
      cur.to = i;
      if (value.t === "ref") {
        const o = ev.heap[value.id];
        if (o && cur.lastObj && o !== cur.lastObj) cur.mutations.push(i);
        cur.lastObj = o;
      }
      continue;
    }
    if (cur) segments.push(strip(cur));
    cur = {
      from: i,
      to: i,
      text: formatValue(value, ev.heap, lang, { maxLength: 80, maxDepth: 3 }),
      mutations: [],
      key,
      ...(value.t === "ref" ? { objectId: value.id } : {}),
      ...(value.t === "ref" && ev.heap[value.id] ? { lastObj: ev.heap[value.id] as HeapObject } : {}),
    };
  }
  if (cur) segments.push(strip(cur));
  return { name, frameId, frameName, segments, unboundRanges: unbound };
}

function strip(s: HistorySegment & { key: string; lastObj?: HeapObject }): HistorySegment {
  return { from: s.from, to: s.to, text: s.text, mutations: s.mutations, ...(s.objectId ? { objectId: s.objectId } : {}) };
}
