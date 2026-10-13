import type { TraceEvent } from "./schema";
import { isTerminal, type Trace } from "./store";

/**
 * Navigation over a recorded trace. Every function is a pure lookup into
 * recorded history — nothing re-executes the program.
 *
 * Depth = number of user frames on the stack at an event.
 *
 *  stepInto  → the next recorded event (finest granularity; enters calls).
 *  stepOver  → the next event at the same or a shallower depth (skips the
 *              bodies of calls made from the current line).
 *  stepOut   → the first event after the current frame has been popped
 *              (depth strictly shallower than now).
 *  stepBack  → the previous recorded event.
 *  nextBreakpoint / prevBreakpoint → nearest `line` event whose line is a breakpoint.
 *
 * Terminal events have depth 0 and are therefore always reachable by
 * stepOver / stepOut.
 */
export interface NavResult {
  index: number;
  /** false when no event matched and the result was clamped to the end/start. */
  found: boolean;
}

function depth(trace: Trace, i: number): number {
  return trace.events[i]?.stack.length ?? 0;
}

export function stepInto(trace: Trace, i: number): NavResult {
  const last = trace.length - 1;
  return i < last ? { index: i + 1, found: true } : { index: Math.max(0, last), found: false };
}

export function stepBack(_trace: Trace, i: number): NavResult {
  return i > 0 ? { index: i - 1, found: true } : { index: 0, found: false };
}

export function stepOver(trace: Trace, i: number): NavResult {
  const d = depth(trace, i);
  for (let j = i + 1; j < trace.length; j++) {
    const ev = trace.events[j];
    if (!ev || ev.type === "stdout") continue;
    if (ev.stack.length <= d) return { index: j, found: true };
  }
  return { index: Math.max(0, trace.length - 1), found: false };
}

export function stepOut(trace: Trace, i: number): NavResult {
  const d = depth(trace, i);
  for (let j = i + 1; j < trace.length; j++) {
    const ev = trace.events[j];
    if (!ev || ev.type === "stdout") continue;
    if (ev.stack.length < d) return { index: j, found: true };
  }
  return { index: Math.max(0, trace.length - 1), found: false };
}

/** Step backward over calls: previous event at the same or shallower depth. */
export function stepBackOver(trace: Trace, i: number): NavResult {
  const d = depth(trace, i);
  for (let j = i - 1; j >= 0; j--) {
    const ev = trace.events[j];
    if (!ev || ev.type === "stdout") continue;
    if (ev.stack.length <= d) return { index: j, found: true };
  }
  return { index: 0, found: false };
}

export function nextBreakpoint(trace: Trace, i: number, breakpoints: ReadonlySet<number>): NavResult {
  let best = Infinity;
  for (const line of breakpoints) {
    const arr = trace.lineIndex.get(line);
    if (!arr) continue;
    const k = upperBound(arr, i);
    const hit = arr[k];
    if (hit !== undefined && hit < best) best = hit;
  }
  return best === Infinity ? { index: Math.max(0, trace.length - 1), found: false } : { index: best, found: true };
}

export function prevBreakpoint(trace: Trace, i: number, breakpoints: ReadonlySet<number>): NavResult {
  let best = -1;
  for (const line of breakpoints) {
    const arr = trace.lineIndex.get(line);
    if (!arr) continue;
    const k = lowerBound(arr, i) - 1;
    const hit = arr[k];
    if (hit !== undefined && hit > best) best = hit;
  }
  return best < 0 ? { index: 0, found: false } : { index: best, found: true };
}

/** Index of the first element strictly greater than x (sorted ascending). */
export function upperBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as number) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first element >= x. */
export function lowerBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The event the UI should land on after a run finishes: the raise point for
 * uncaught exceptions (full stack available there), otherwise the first event.
 */
/** Index of the event where an uncaught exception was raised (start of the final propagation chain), or -1. */
export function errorOrigin(trace: Trace): number {
  const last = trace.last;
  if (!last || last.type !== "exception" || !last.exception?.uncaught) return -1;
  let j = trace.length - 2;
  let firstOfChain = -1;
  while (j >= 0) {
    const ev = trace.events[j];
    if (!ev) break;
    if (ev.type === "exception") firstOfChain = j;
    else if (!(ev.type === "return" && ev.unwind) && ev.type !== "stdout") break;
    j--;
  }
  return firstOfChain;
}

/**
 * Where to put the cursor after a run: the raise point of an uncaught exception,
 * the stopping point of a limit, otherwise the start.
 */
export function initialFocus(trace: Trace): number {
  const last = trace.last;
  if (!last) return 0;
  if (last.type === "exception" && last.exception?.uncaught) {
    const o = errorOrigin(trace);
    return o >= 0 ? o : trace.length - 1;
  }
  if (last.type === "limit") return trace.length - 1;
  return 0;
}

/**
 * The event whose program state should be displayed at `i`. Terminal events
 * after the stack has unwound carry no frames, so they display the last live
 * state instead: the raise point for an uncaught exception, otherwise the last
 * event that still had frames.
 */
export function stateIndex(trace: Trace, i: number): number {
  const ev = trace.events[i];
  if (!ev || !isTerminal(ev) || ev.stack.length > 0) return i;
  if (ev.type === "exception") {
    const o = errorOrigin(trace);
    if (o >= 0 && o < i) return o;
  }
  for (let j = i - 1; j >= 0; j--) if ((trace.events[j] as TraceEvent).stack.length > 0) return j;
  return i;
}
