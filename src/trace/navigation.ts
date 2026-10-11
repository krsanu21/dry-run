import type { Trace } from "./store";

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
export function initialFocus(trace: Trace): number {
  const last = trace.last;
  if (!last) return 0;
  if (last.type === "exception" && last.exception?.uncaught) {
    // walk back to the first exception event of the final propagation chain
    let j = trace.length - 2;
    let firstOfChain = -1;
    while (j >= 0) {
      const ev = trace.events[j];
      if (!ev) break;
      if (ev.type === "exception") firstOfChain = j;
      else if (!(ev.type === "return" && ev.unwind) && ev.type !== "stdout") break;
      j--;
    }
    return firstOfChain >= 0 ? firstOfChain : trace.length - 1;
  }
  return 0;
}
