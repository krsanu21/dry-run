import { useMemo } from "react";
import { DiffCache, type EventDiff } from "../trace/diff";
import { stateIndex } from "../trace/navigation";
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

const NO_CHANGES: EventDiff = { vars: [], objects: new Map(), framesEntered: [], framesExited: [] };

export interface CurrentStep {
  trace: Trace;
  /** the selected event */
  event: TraceEvent;
  prev: TraceEvent | undefined;
  /**
   * The event whose program state is displayed (variables, visualizations, watches).
   * Usually `event`; for a terminal event after the stack unwound it is the last live
   * state — see `nav.stateIndex`.
   */
  state: TraceEvent;
  /** true when `state` is an earlier event shown in place of a frameless terminal event */
  final: boolean;
  /** frame of `state` whose scope is being inspected (selected or innermost) */
  frame: TraceFrame | undefined;
  /** changes to highlight; empty when showing a final state */
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
    const si = stateIndex(trace, index);
    const state = trace.events[si] as TraceEvent;
    const final = si !== index;
    const frame = (selectedFrameId ? state.stack.find((f) => f.id === selectedFrameId) : undefined) ?? state.stack[state.stack.length - 1];
    return {
      trace,
      event,
      prev: trace.events[index - 1],
      state,
      final,
      frame,
      diff: final ? NO_CHANGES : (diffFor(trace, index) as EventDiff),
      refCounts: referenceCounts(state),
      index,
    };
    // version: trace is mutated while streaming
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, version, cursor, selectedFrameId]);
}
