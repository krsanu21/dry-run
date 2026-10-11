import type { EventDiff } from "./diff";
import type { Language, TraceEvent, TraceFrame, Value } from "./schema";
import { formatValue, type Heap } from "./values";

/**
 * Human-readable explanations of a step, derived only from recorded events and
 * the diff between them. Answers: what just happened, what is the state now,
 * what might be worth investigating next.
 */

export interface StepExplanation {
  happened: string[];
  now: string;
  hints: string[];
}

function fv(v: Value | undefined, heap: Heap, lang: Language, max = 60): string {
  return v === undefined ? "—" : formatValue(v, heap, lang, { maxLength: max, maxDepth: 3 });
}

function frameLabel(f: TraceFrame | undefined): string {
  if (!f) return "program";
  if (f.name === "<module>") return "top level";
  return `${f.name}()`;
}

export function sourceLine(source: string, line: number): string {
  return (source.split("\n")[line - 1] ?? "").trim();
}

/** Names that refer to an object id in the given event (variables and self/this attributes). */
function namesFor(ev: TraceEvent, id: string): string[] {
  const out: string[] = [];
  const f = ev.stack[ev.stack.length - 1];
  const scan = (pairs: ReadonlyArray<readonly [string, Value]>): void => {
    for (const [k, v] of pairs) {
      if (v.t === "ref" && v.id === id && !out.includes(k)) out.push(k);
    }
  };
  if (f) scan(f.locals);
  if (f?.closure) scan(f.closure);
  scan(ev.globals);
  if (!out.length && f) {
    for (const [k, v] of f.locals) {
      const o = v.t === "ref" ? ev.heap[v.id] : undefined;
      if (o?.kind === "object") for (const [a, av] of o.attrs) if (av.t === "ref" && av.id === id) out.push(`${k}.${a}`);
    }
  }
  return out;
}

export function describeChanges(diff: EventDiff, prev: TraceEvent, cur: TraceEvent, lang: Language): string[] {
  const out: string[] = [];
  const activeId = cur.stack[cur.stack.length - 1]?.id;
  for (const c of diff.vars) {
    if (c.frameId !== activeId && c.frameId !== "globals") continue;
    if (c.kind === "added") out.push(`${c.name} = ${fv(c.after, cur.heap, lang)}`);
    else if (c.kind === "changed") {
      const sameObj = c.before?.t === "ref" && c.after?.t === "ref" && c.before.id === c.after.id;
      if (!sameObj) out.push(`${c.name}: ${fv(c.before, prev.heap, lang, 30)} → ${fv(c.after, cur.heap, lang, 30)}`);
    } else out.push(`${c.name} went out of scope`);
  }
  for (const [id, ch] of diff.objects) {
    if (ch.isNew) continue;
    const names = namesFor(cur, id);
    if (!names.length) continue;
    const who = names.join(" / ");
    const obj = cur.heap[id];
    switch (ch.kind) {
      case "sequence": {
        const changed = ch.status.map((s, i) => (s === "changed" ? i : -1)).filter((i) => i >= 0);
        const added = ch.status.map((s, i) => (s === "new" ? i : -1)).filter((i) => i >= 0);
        const items = obj && "items" in obj ? obj.items : [];
        const prevObj = prev.heap[id];
        const prevItems = prevObj && "items" in prevObj ? prevObj.items : [];
        if (changed.length && changed.length <= 3)
          for (const i of changed) out.push(`${who}[${i}]: ${fv(prevItems[i], prev.heap, lang, 20)} → ${fv(items[i], cur.heap, lang, 20)}`);
        else if (changed.length) out.push(`${who}: ${changed.length} items changed`);
        if (added.length) out.push(`${who}: added ${added.map((i) => fv(items[i], cur.heap, lang, 20)).join(", ")} at index ${added.join(", ")}`);
        if (ch.removed.length) out.push(`${who}: removed ${ch.removed.map((r) => fv(r.value, prev.heap, lang, 20)).join(", ")}`);
        break;
      }
      case "map":
        if (ch.added.size) out.push(`${who}: added ${ch.added.size === 1 ? "key " : `${ch.added.size} keys `}${[...ch.added].slice(0, 3).map((k) => k.replace(/^[a-z]:/, "")).join(", ")}`);
        if (ch.changed.size) out.push(`${who}: updated ${[...ch.changed].slice(0, 3).map((k) => k.replace(/^[a-z]:/, "")).join(", ")}`);
        if (ch.removed.length) out.push(`${who}: removed ${ch.removed.length} key(s)`);
        break;
      case "set":
        if (ch.added.size) out.push(`${who}: added ${[...ch.added].slice(0, 3).map((k) => k.replace(/^[a-z]:/, "").replace(/^t\((.*)\)$/, "($1)").replace(/n:/g, "")).join(", ")}`);
        if (ch.removed.length) out.push(`${who}: removed ${ch.removed.map((v) => fv(v, prev.heap, lang, 16)).join(", ")}`);
        break;
      case "attrs":
        for (const a of ch.changed) out.push(`${who}.${a}: ${fv(ch.previous.get(a), prev.heap, lang, 24)} → ${fv(obj && obj.kind === "object" ? obj.attrs.find(([k]) => k === a)?.[1] : undefined, cur.heap, lang, 24)}`);
        for (const a of ch.added) out.push(`${who}.${a} set`);
        break;
      default:
        out.push(`${who} changed`);
    }
  }
  return out;
}

export function explainStep(prev: TraceEvent | undefined, cur: TraceEvent, diff: EventDiff, source: string, lang: Language, entryNote?: string): StepExplanation {
  const happened: string[] = [];
  const hints: string[] = [];
  const top = cur.stack[cur.stack.length - 1];
  const changes = prev ? describeChanges(diff, prev, cur, lang) : [];

  if (!prev) happened.push(entryNote ?? "Execution started.");
  else if (prev.type === "line") {
    const prevTop = prev.stack[prev.stack.length - 1];
    happened.push(`Line ${prev.loc.line} ran${prevTop && prevTop.id !== top?.id && cur.type !== "call" ? ` in ${frameLabel(prevTop)}` : ""}: ${sourceLine(source, prev.loc.line)}`);
  } else if (prev.type === "call") happened.push(`Entered ${frameLabel(prev.stack[prev.stack.length - 1])}.`);
  else if (prev.type === "return") {
    const f = prev.stack[prev.stack.length - 1];
    if (prev.yielded) happened.push(`${frameLabel(f)} yielded ${fv(prev.returnValue, prev.heap, lang)} and is suspended.`);
    else if (prev.unwind) happened.push(`${frameLabel(f)} was exited by an exception.`);
    else happened.push(`${frameLabel(f)} returned ${fv(prev.returnValue, prev.heap, lang)} to ${frameLabel(cur.stack[cur.stack.length - 1])}.`);
  } else if (prev.type === "exception") happened.push(`${prev.exception?.type ?? "Exception"} propagated.`);
  else if (prev.type === "stdout") happened.push("Output was written.");

  if (cur.type === "call") {
    const args = top ? top.locals.filter(([k]) => top.args.includes(k)) : [];
    happened.push(`Called ${top?.name ?? "?"}(${args.map(([k, v]) => `${k}=${fv(v, cur.heap, lang, 30)}`).join(", ")})${top?.isGenerator ? " — generator frame" : ""}.`);
  }
  if (cur.type === "stdout") {
    const out = cur.stdoutEnd;
    happened.push(`Printed output (stdout is now ${out} characters).`);
  }
  happened.push(...changes);

  let now = "";
  switch (cur.type) {
    case "line":
      now = `About to run line ${cur.loc.line} (not executed yet): ${sourceLine(source, cur.loc.line)}`;
      break;
    case "call":
      now = `Inside ${frameLabel(top)} — arguments are bound; the body has not started.`;
      break;
    case "return":
      if (cur.yielded) now = `${frameLabel(top)} is yielding ${fv(cur.returnValue, cur.heap, lang)}.`;
      else if (cur.unwind) now = `${frameLabel(top)} is being exited because of an exception.`;
      else now = `${frameLabel(top)} is returning ${fv(cur.returnValue, cur.heap, lang)}.`;
      break;
    case "exception":
      now = cur.exception?.uncaught
        ? `Uncaught ${cur.exception.type}: ${cur.exception.message}`
        : `${cur.exception?.type ?? "Exception"} raised at line ${cur.loc.line}: ${cur.exception?.message ?? ""}`;
      break;
    case "stdout":
      now = "Output written; execution continues.";
      break;
    case "complete":
      now = cur.result ? `Finished. The entry point returned ${fv(cur.result, cur.heap, lang, 120)}.` : "Finished normally.";
      break;
    case "limit":
      now = `Stopped: ${cur.limit?.message ?? "resource limit"}`;
      break;
  }

  // Hints grounded in the recorded state.
  if (cur.type === "return" && !cur.unwind && !cur.yielded && (cur.returnValue?.t === "none" || cur.returnValue?.t === "undefined")) {
    const text = sourceLine(source, cur.loc.line);
    if (!/^return\b/.test(text) && !/\breturn\b/.test(text))
      hints.push(`${frameLabel(top)} reached the end without a return statement, so it returns ${lang === "python" ? "None" : "undefined"}.`);
  }
  if (cur.type === "exception") hints.push(`Look at the values used on line ${cur.loc.line} in the variables panel — step back (←) to see how they got there.`);
  if (cur.type === "limit") {
    if (cur.limit?.kind === "events") hints.push("Raise “Max events” in Settings, or use a smaller test case. Check loop conditions for a loop that never ends.");
    else if (cur.limit?.kind === "time") hints.push("Raise the time limit in Settings, or look for a loop whose condition never becomes false.");
    else if (cur.limit?.kind === "stack") hints.push("Recursion went deeper than the stack limit — check the base case, or raise “Max stack depth”.");
    else if (cur.limit?.kind === "cancelled") hints.push("You stopped this run. The steps recorded so far are kept.");
  }
  if (cur.type === "line" && prev && prev.type === "line" && prev.loc.line === cur.loc.line && changes.length === 0 && top?.id === prev.stack[prev.stack.length - 1]?.id)
    hints.push("The same line again with no visible state change — if this repeats, the loop may not be making progress.");
  return { happened, now, hints };
}
