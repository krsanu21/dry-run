import { useMemo } from "react";
import { DiffCache, type EventDiff } from "../trace/diff";
import type { TraceEvent, TraceFrame } from "../trace/schema";
import type { Trace } from "../trace/store";
import { isListNode, isTreeNode, referenceCounts } from "../viz/model";
import { useApp } from "./store";

const diffCaches = new WeakMap<Trace, DiffCache>();
const nodeVarCache = new WeakMap<Trace, { length: number; names: Set<string> }>();

export function diffFor(trace: Trace, i: number): EventDiff | null {
  const ev = trace.events[i];
  if (!ev) return null;
  let c = diffCaches.get(trace);
  if (!c) {
    c = new DiffCache();
    diffCaches.set(trace, c);
  }
  return c.get(trace.events[i - 1], ev);
}

/** Names that referenced a list/tree node at any recorded event (computed once per trace length). */
export function historicalNodeVars(trace: Trace): Set<string> {
  const hit = nodeVarCache.get(trace);
  if (hit && hit.length === trace.length) return hit.names;
  const names = new Set<string>();
  for (const ev of trace.events) {
    for (const f of ev.stack)
      for (const [k, v] of f.locals) {
        if (v.t !== "ref" || names.has(k)) continue;
        const o = ev.heap[v.id];
        if (isListNode(o) || isTreeNode(o)) names.add(k);
      }
  }
  nodeVarCache.set(trace, { length: trace.length, names });
  return names;
}

export interface CurrentStep {
  trace: Trace;
  event: TraceEvent;
  prev: TraceEvent | undefined;
  /** frame whose scope is being inspected (selected or innermost) */
  frame: TraceFrame | undefined;
  diff: EventDiff;
  refCounts: Map<string, number>;
  index: number;
}

export function useCurrentStep(): CurrentStep | null {
  const trace = useApp((s) => s.run.trace);
  const version = useApp((s) => s.run.version);
  const cursor = useApp((s) => s.cursor);
  const selectedFrameId = useApp((s) => s.selectedFrameId);
  return useMemo(() => {
    if (!trace || trace.length === 0) return null;
    const index = Math.min(cursor, trace.length - 1);
    const event = trace.events[index] as TraceEvent;
    const frame = (selectedFrameId ? event.stack.find((f) => f.id === selectedFrameId) : undefined) ?? event.stack[event.stack.length - 1];
    return {
      trace,
      event,
      prev: trace.events[index - 1],
      frame,
      diff: diffFor(trace, index) as EventDiff,
      refCounts: referenceCounts(event),
      index,
    };
    // version: trace is mutated while streaming
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, version, cursor, selectedFrameId]);
}
