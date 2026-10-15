import type { FunctionInfo } from "../analysis/types";
import type { EventDiff, ObjectChange } from "./diff";
import { variableHistory } from "./history";
import { evaluateSource, type Scope, scopeFrom } from "./expr";
import type { HeapObject, Language, TraceEvent, TraceFrame, Value } from "./schema";
import type { Trace } from "./store";
import { formatPrimitive, formatValue, type Heap, typeLabel, valuesEqual } from "./values";

/**
 * Trace Peek: what a variable's value was at the selected step.
 *
 * Everything here is a pure function of the recorded trace. It never runs code,
 * never calls into a runtime and never looks at anything newer than the
 * selected event, so the answer for a given (trace, step, frame, position) is
 * identical however the user got there — stepping forwards or backwards,
 * scrubbing, or after the program has finished.
 */

// ---------------------------------------------------------------------------
// What is under the cursor

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(" "),
);
const JS_KEYWORDS = new Set(
  "break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield async await of static get set undefined NaN Infinity".split(" "),
);

const isIdChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$]/.test(c);

/**
 * Whether the character at `col` is code, as opposed to a comment or the text of a string.
 * Placeholders in Python f-strings and JavaScript template literals count as code.
 */
export function inCode(text: string, col: number, lang: Language): boolean {
  let str: { quote: string; template: boolean; depth: number } | null = null;
  for (let i = 0; i < col && i < text.length; i++) {
    const c = text[i] as string;
    if (!str) {
      if ((lang === "python" && c === "#") || (lang === "javascript" && c === "/" && text[i + 1] === "/")) return false;
      if (c === '"' || c === "'" || (lang === "javascript" && c === "`")) {
        let j = i - 1;
        let prefix = "";
        while (j >= 0 && /[A-Za-z]/.test(text[j] as string) && prefix.length < 3) prefix = (text[j--] as string) + prefix;
        const quote = lang === "python" && text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
        str = { quote, template: c === "`" || (lang === "python" && /f/i.test(prefix)), depth: 0 };
        i += quote.length - 1;
      }
    } else if (str.depth === 0) {
      if (c === "\\") i++;
      else if (text.startsWith(str.quote, i)) {
        i += str.quote.length - 1;
        str = null;
      } else if (str.template) {
        if (str.quote === "`" ? c === "$" && text[i + 1] === "{" : c === "{") {
          if (str.quote !== "`" && text[i + 1] === "{") i++; // escaped {{
          else {
            str.depth = 1;
            if (str.quote === "`") i++;
          }
        }
      }
    } else if (c === "{") str.depth++;
    else if (c === "}") str.depth--;
  }
  return !str || str.depth > 0;
}

export interface ExpressionAt {
  /** the first name of the expression: the variable that has to be looked up */
  head: string;
  /** the expression up to and including the hovered name: `node`, `node.next`, `self.seen` */
  expr: string;
  /** document range (within the line) of the hovered name */
  from: number;
  to: number;
}

/**
 * The variable (or attribute chain) at `col`, or null when the position is not on a variable
 * (keyword, number, string text, comment, method call result, …).
 */
export function expressionAt(text: string, col: number, lang: Language): ExpressionAt | null {
  let c = col;
  if (!isIdChar(text[c]) && isIdChar(text[c - 1])) c = col - 1; // caret at the end of a word
  if (!isIdChar(text[c])) return null;
  let s = c;
  while (s > 0 && isIdChar(text[s - 1])) s--;
  let e = c + 1;
  while (e < text.length && isIdChar(text[e])) e++;
  const word = text.slice(s, e);
  if (/^[0-9]/.test(word)) return null;
  if ((lang === "python" ? PY_KEYWORDS : JS_KEYWORDS).has(word)) return null;
  if (!inCode(text, s, lang)) return null;

  const segments = [word];
  let p = s;
  for (;;) {
    if (text[p - 1] !== ".") break;
    let q = p - 1;
    if (lang === "javascript" && text[q - 1] === "?") q--; // optional chaining: a?.b
    const dot = q;
    if (!isIdChar(text[q - 1])) return null; // `f().x`, `a[i].x`, `(expr).x`: not a plain variable chain
    while (q > 0 && isIdChar(text[q - 1])) q--;
    const seg = text.slice(q, dot);
    if (/^[0-9]/.test(seg)) return null;
    segments.unshift(seg);
    p = q;
  }
  const head = segments[0] as string;
  if ((lang === "python" ? PY_KEYWORDS : JS_KEYWORDS).has(head) && !(lang === "javascript" && head === "this")) return null;
  return { head, expr: segments.join("."), from: s, to: e };
}

// ---------------------------------------------------------------------------
// Model

export interface PeekHighlight {
  /** the hovered variable, so the pointer / row with this name can be marked */
  name: string;
  frameId: string | null;
  /** the object the value refers to, so its structure / node can be marked */
  objectId?: string;
}

export interface PeekRow {
  key: string;
  value: string;
  mark?: "new" | "changed";
}

export type PeekStatus =
  | "value" // found
  | "not-yet" // bound later in this call, not yet at this step
  | "unbound" // never bound in this call (e.g. the branch that assigns it did not run), or deleted
  | "inactive" // belongs to a function that is not running at this step
  | "stale" // the code changed since the trace was recorded
  | "unresolved"; // e.g. an attribute chain that cannot be followed

export interface PeekChange {
  kind: "first" | "unchanged" | "new" | "rebound" | "mutated";
  headline: string;
  was?: string;
  details: string[];
}

export interface PeekModel {
  status: PeekStatus;
  /** what is shown as the title: `node`, `node.next` */
  expr: string;
  head: string;
  scopeKind?: "local" | "closure" | "global";
  /** `fib(n=3) · recursion depth 3 of 5`, `global`, … */
  scopeLabel?: string;
  type?: string;
  length?: number;
  objectId?: string;
  /** one-line rendering of the value */
  summary?: string;
  /** the whole text of a string value */
  text?: string;
  rows: PeekRow[];
  rowsMore: number;
  /** truncation / capture limits that affect what is shown */
  notes: string[];
  /** other names that refer to the same object right now */
  aliases: string[];
  /** the same variable in other active calls of the same function (recursion) */
  others: Array<{ depth: number; value: string; selected: boolean }>;
  /** how the variable got here: the steps where it took a new value (latest last), and in-place changes since */
  history: Array<{ step: number; value: string }>;
  mutatedAt: number[];
  change?: PeekChange;
  /** why nothing is shown, for the unavailable statuses */
  message?: string;
  /** "before line 10 runs · step 12" */
  moment: string;
  stepIndex: number;
  line: number;
  jump?: { step: number; label: string };
  highlight?: PeekHighlight;
}

export interface PeekInput {
  trace: Trace;
  /** the selected event (what the scrubber points at) */
  event: TraceEvent;
  /** the event whose state is displayed — differs from `event` only for a frameless final event */
  state: TraceEvent;
  prev: TraceEvent | undefined;
  /** changes between `prev` and `state`; empty when showing a final state */
  diff: EventDiff;
  /** the frame selected in the call stack (null = innermost) */
  selectedFrameId: string | null;
  functions: readonly FunctionInfo[];
  language: Language;
}

export interface PeekQuery {
  line: number;
  head: string;
  expr: string;
}

const MAX_ROWS = 8;
const ROW_VALUE = 36;

// ---------------------------------------------------------------------------
// Trace-wide indexes (built lazily, rebuilt only if the trace grew)

interface TraceIndex {
  length: number;
  /** every variable name that was ever bound anywhere in the trace */
  names: Set<string>;
  /** line -> names of the frames that executed that line */
  owners: Map<number, Set<string>>;
  /** function name -> names bound in its frames */
  locals: Map<string, Set<string>>;
  /** function name -> first call event index */
  firstCall: Map<string, number>;
}

const indexes = new WeakMap<Trace, TraceIndex>();

function indexOf(trace: Trace): TraceIndex {
  const hit = indexes.get(trace);
  if (hit && hit.length === trace.length) return hit;
  const idx: TraceIndex = { length: trace.length, names: new Set(), owners: new Map(), locals: new Map(), firstCall: new Map() };
  for (const ev of trace.events) {
    for (const [k] of ev.globals) idx.names.add(k);
    for (const f of ev.stack) {
      let set = idx.locals.get(f.name);
      if (!set) idx.locals.set(f.name, (set = new Set()));
      for (const [k] of f.locals) {
        idx.names.add(k);
        set.add(k);
      }
      for (const [k] of f.closure ?? []) idx.names.add(k);
    }
    const top = ev.stack[ev.stack.length - 1];
    if (top && ev.type !== "limit" && ev.type !== "complete") {
      let o = idx.owners.get(ev.loc.line);
      if (!o) idx.owners.set(ev.loc.line, (o = new Set()));
      o.add(top.name);
      if (ev.type === "call" && !idx.firstCall.has(top.name)) idx.firstCall.set(top.name, ev.index);
    }
  }
  indexes.set(trace, idx);
  return idx;
}

// ---------------------------------------------------------------------------
// Scope

const isPseudo = (name: string): boolean => name.startsWith("<") && name !== "<module>";
const sameFunction = (frameName: string, fnName: string): boolean => frameName === fnName || frameName.endsWith(`.${fnName}`);

/** Names of the frames that can own `line`: what actually ran there, else the enclosing function in the source. */
function ownersOfLine(index: TraceIndex, line: number, functions: readonly FunctionInfo[]): Set<string> {
  const seen = index.owners.get(line);
  if (seen && seen.size) return seen;
  let best: FunctionInfo | undefined;
  for (const f of functions) if (f.line <= line && line <= f.endLine && (!best || f.endLine - f.line < best.endLine - best.line)) best = f;
  return new Set(best ? [best.name] : []);
}

interface Resolved {
  /** the frame the name is looked up in (undefined = module / global scope) */
  frame: TraceFrame | undefined;
  /** the function the hovered line belongs to, when it is not running */
  inactiveFunction?: string;
}

function chooseFrame(state: TraceEvent, selectedFrameId: string | null, owners: Set<string>): Resolved {
  // nothing known about the line, or module-level code
  const moduleLevel = owners.size === 0 || owners.has("<module>");
  if (moduleLevel) return { frame: state.stack.find((f) => f.name === "<module>") };
  const matches = (f: TraceFrame): boolean => [...owners].some((n) => sameFunction(f.name, n));
  const selected = selectedFrameId ? state.stack.find((f) => f.id === selectedFrameId) : undefined;
  if (selected && matches(selected)) return { frame: selected };
  for (let i = state.stack.length - 1; i >= 0; i--) if (matches(state.stack[i] as TraceFrame)) return { frame: state.stack[i] as TraceFrame };
  return { frame: undefined, inactiveFunction: [...owners][0] };
}

/** Bindings visible from a frame, nearest first: comprehension frames above it, its locals, closure, module, globals. */
function bindingsOf(ev: TraceEvent, frameId: string | undefined): Array<{ name: string; value: Value; kind: "local" | "closure" | "global" }> {
  const out: Array<{ name: string; value: Value; kind: "local" | "closure" | "global" }> = [];
  const seen = new Set<string>();
  const add = (pairs: ReadonlyArray<readonly [string, Value]>, kind: "local" | "closure" | "global"): void => {
    for (const [name, value] of pairs)
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ name, value, kind });
      }
  };
  const i = frameId ? ev.stack.findIndex((f) => f.id === frameId) : -1;
  if (i >= 0) {
    for (let k = ev.stack.length - 1; k > i; k--) if (isPseudo((ev.stack[k] as TraceFrame).name)) add((ev.stack[k] as TraceFrame).locals, "local");
    const f = ev.stack[i] as TraceFrame;
    add(f.locals, f.name === "<module>" ? "global" : "local");
    add(f.closure ?? [], "closure");
  }
  const mod = ev.stack.find((f) => f.name === "<module>");
  if (mod) add(mod.locals, "global");
  add(ev.globals, "global");
  return out;
}

function scopeOf(ev: TraceEvent, frameId: string | undefined): Scope {
  return scopeFrom(
    bindingsOf(ev, frameId).map((b) => [b.name, b.value] as const),
    ev.heap,
  );
}

// ---------------------------------------------------------------------------
// Value rendering

/** The type as the language would name it: `int` / `number`, `str` / `string`, … */
function typeName(v: Value, heap: Heap, lang: Language): string {
  if (lang === "javascript" && v.t !== "ref") return { none: "null", undefined: "undefined", bool: "boolean", int: "number", float: "number", str: "string", symbol: "symbol" }[v.t];
  return typeLabel(v, heap);
}

const fmt = (v: Value, heap: Heap, lang: Language, maxLength = ROW_VALUE, maxDepth = 1): string => formatValue(v, heap, lang, { maxLength, maxDepth });

function describeFrame(f: TraceFrame, ev: TraceEvent, lang: Language): string {
  if (f.name === "<module>") return "top level";
  const args = f.args
    .slice(0, 4)
    .map((a) => {
      const v = f.locals.find(([k]) => k === a)?.[1];
      return `${a}=${v ? fmt(v, ev.heap, lang, 14, 0) : "?"}`;
    })
    .join(", ");
  return `${f.name}(${args}${f.args.length > 4 ? ", …" : ""})`;
}

function rowsFor(o: HeapObject, heap: Heap, lang: Language, change: ObjectChange | undefined): { rows: PeekRow[]; more: number } {
  const rows: PeekRow[] = [];
  const seqChange = change && !change.isNew && change.kind === "sequence" ? change : undefined;
  const mapChange = change && !change.isNew && change.kind === "map" ? change : undefined;
  const attrChange = change && !change.isNew && change.kind === "attrs" ? change : undefined;
  let total = 0;
  switch (o.kind) {
    case "list":
    case "tuple":
    case "deque":
    case "set":
      total = o.items.length;
      o.items.slice(0, MAX_ROWS).forEach((v, i) => {
        const st = seqChange?.status[i];
        rows.push({ key: o.kind === "set" ? "•" : String(i), value: fmt(v, heap, lang), ...(st === "new" ? { mark: "new" as const } : st === "changed" ? { mark: "changed" as const } : {}) });
      });
      break;
    case "dict":
      total = o.entries.length;
      o.entries.slice(0, MAX_ROWS).forEach(([k, v]) => {
        const key = formatValue(k, heap, lang, { maxLength: 24, maxDepth: 0 });
        rows.push({ key, value: fmt(v, heap, lang), ...(mapChange?.added.has(keyOf(k, heap)) ? { mark: "new" as const } : mapChange?.changed.has(keyOf(k, heap)) ? { mark: "changed" as const } : {}) });
      });
      break;
    case "object":
      total = o.attrs.length;
      o.attrs.slice(0, MAX_ROWS).forEach(([k, v]) => rows.push({ key: k, value: fmt(v, heap, lang), ...(attrChange?.added.has(k) ? { mark: "new" as const } : attrChange?.changed.has(k) ? { mark: "changed" as const } : {}) }));
      break;
    default:
      break;
  }
  return { rows, more: Math.max(0, total - rows.length) };
}

function keyOf(v: Value, heap: Heap): string {
  return v.t === "ref" ? formatValue(v, heap, "python", { maxLength: 200, maxDepth: 2 }) : formatPrimitive(v, "python");
}

function lengthOf(v: Value, heap: Heap): number | undefined {
  if (v.t === "str") return v.len ?? v.v.length;
  const o = v.t === "ref" ? heap[v.id] : undefined;
  if (!o) return undefined;
  if (o.kind === "list" || o.kind === "tuple" || o.kind === "deque" || o.kind === "set" || o.kind === "dict" || o.kind === "elided") return o.length;
  return undefined;
}

/** Capture limits that apply to a value, in plain words. */
function captureNotes(v: Value, heap: Heap, lang: Language): string[] {
  const notes: string[] = [];
  if (v.t === "str" && v.len !== undefined && v.len > v.v.length) notes.push(`String shortened in the snapshot: the first ${v.v.length} of ${v.len} characters were kept.`);
  if (v.t !== "ref") return notes;
  const o = heap[v.id];
  if (!o) {
    notes.push("This object is not part of the recorded snapshot.");
    return notes;
  }
  if (o.kind === "elided") notes.push(`Not captured: the ${o.reason} limit was reached${o.length !== undefined ? ` (${o.length} items)` : ""}. Raise the limit in Settings to record it.`);
  if ("truncated" in o && o.truncated) notes.push(`Only ${o.truncated.shown} of ${o.truncated.total} items were captured (${o.truncated.reason === "items" ? "item" : "snapshot budget"} limit).`);
  // anything the value reaches that was not captured (bounded walk)
  if (o.kind !== "elided" && reachesElided(v.id, heap)) notes.push("Part of this structure was not captured (depth or object limit); deeper levels cannot be inspected at this step.");
  void lang;
  return notes;
}

function reachesElided(root: string, heap: Heap): boolean {
  const seen = new Set<string>([root]);
  const todo = [root];
  for (let n = 0; todo.length && n < 600; n++) {
    const o = heap[todo.pop() as string];
    if (!o) continue;
    if (o.kind === "elided") return true;
    const kids: Value[] = o.kind === "list" || o.kind === "tuple" || o.kind === "deque" || o.kind === "set" ? o.items : o.kind === "dict" ? o.entries.flat() : o.kind === "object" ? o.attrs.map(([, x]) => x) : [];
    for (const x of kids)
      if (x.t === "ref" && !seen.has(x.id)) {
        seen.add(x.id);
        todo.push(x.id);
      }
  }
  return false;
}

function describeMutation(ch: ObjectChange, prevObj: HeapObject | undefined, cur: HeapObject, ph: Heap, h: Heap, lang: Language): string[] {
  if (ch.isNew) return [];
  const out: string[] = [];
  const f = (v: Value, heap: Heap): string => fmt(v, heap, lang, 28);
  switch (ch.kind) {
    case "sequence": {
      if (cur.kind !== "list" && cur.kind !== "tuple" && cur.kind !== "deque") break;
      const prevItems = prevObj && (prevObj.kind === "list" || prevObj.kind === "tuple" || prevObj.kind === "deque") ? prevObj.items : [];
      ch.status.forEach((st, i) => {
        if (out.length >= 3 || st === "same") return;
        const now = cur.items[i];
        if (!now) return;
        if (st === "new") out.push(`index ${i} added: ${f(now, h)}`);
        else {
          const was = prevItems[i];
          out.push(`index ${i}: ${was ? `${f(was, ph)} → ` : ""}${f(now, h)}`);
        }
      });
      for (const r of ch.removed) if (out.length < 3) out.push(`removed ${f(r.value, ph)} (was at index ${r.beforeIndex})`);
      if (ch.lengthAfter !== ch.lengthBefore) out.push(`length ${ch.lengthBefore} → ${ch.lengthAfter}`);
      break;
    }
    case "map": {
      if (cur.kind !== "dict") break;
      for (const [k, v] of cur.entries) {
        const key = keyOf(k, h);
        if (out.length >= 3) break;
        if (ch.added.has(key)) out.push(`key ${fmt(k, h, lang, 20, 0)} added: ${f(v, h)}`);
        else if (ch.changed.has(key)) {
          const was = prevObj && prevObj.kind === "dict" ? prevObj.entries.find(([pk]) => keyOf(pk, ph) === key)?.[1] : undefined;
          out.push(`key ${fmt(k, h, lang, 20, 0)}: ${was ? `${f(was, ph)} → ` : ""}${f(v, h)}`);
        }
      }
      for (const [k] of ch.removed) if (out.length < 3) out.push(`key ${fmt(k, ph, lang, 20, 0)} removed`);
      break;
    }
    case "set":
      if (cur.kind === "set") for (const v of cur.items) if (out.length < 3 && ch.added.has(keyOf(v, h))) out.push(`added ${f(v, h)}`);
      for (const v of ch.removed) if (out.length < 3) out.push(`removed ${f(v, ph)}`);
      break;
    case "attrs":
      for (const k of ch.changed) if (out.length < 3) out.push(`${k}: ${ch.previous.get(k) ? `${f(ch.previous.get(k) as Value, ph)} → ` : ""}${f((cur.kind === "object" ? cur.attrs.find(([a]) => a === k)?.[1] : undefined) ?? { t: "none" }, h)}`);
      for (const k of ch.added) if (out.length < 3) out.push(`${k} added`);
      for (const k of ch.removed) if (out.length < 3) out.push(`${k} removed`);
      break;
    default:
      out.push("contents changed");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution

function momentOf(state: TraceEvent, event: TraceEvent): string {
  const at = `step ${state.index}`;
  if (state.index !== event.index) return `final state · ${at}`;
  switch (state.type) {
    case "line":
      return `before line ${state.loc.line} runs · ${at}`;
    case "call":
      return `as the call starts · ${at}`;
    case "return":
      return `as the function returns · ${at}`;
    case "exception":
      return `when the exception is raised · ${at}`;
    case "stdout":
      return `after output · ${at}`;
    default:
      return `final state · ${at}`;
  }
}

function base(input: PeekInput, q: PeekQuery): PeekModel {
  return { status: "value", expr: q.expr, head: q.head, rows: [], rowsMore: 0, notes: [], aliases: [], others: [], history: [], mutatedAt: [], moment: momentOf(input.state, input.event), stepIndex: input.state.index, line: q.line };
}

/** First event after `from` (or before, scanning backwards) in which `frame` / the module scope has `name` bound. */
function findBinding(trace: Trace, from: number, frameId: string | undefined, name: string, direction: 1 | -1): number | undefined {
  for (let i = from + direction; i >= 0 && i < trace.length; i += direction) {
    const ev = trace.events[i] as TraceEvent;
    if (frameId) {
      const f = ev.stack.find((x) => x.id === frameId);
      if (!f) {
        if (direction === 1) return undefined; // the call ended
        continue;
      }
      if (f.locals.some(([k]) => k === name) || f.closure?.some(([k]) => k === name)) return i;
    } else if (ev.globals.some(([k]) => k === name) || ev.stack.find((x) => x.name === "<module>")?.locals.some(([k]) => k === name)) return i;
  }
  return undefined;
}

/** Everything needed to say how `v` (the value of `expr` now) differs from the previous step. */
function changeOf(input: PeekInput, frameId: string | undefined, q: PeekQuery, v: Value, scopeKind: string | undefined): PeekChange | undefined {
  const { prev, state, diff, language: lang } = input;
  if (state.index !== input.event.index) return { kind: "first", headline: "Final state — nothing changes after this.", details: [] };
  if (!prev) return { kind: "first", headline: "First recorded step.", details: [] };
  const frameThen = frameId ? prev.stack.find((f) => f.id === frameId) : undefined;
  if (frameId && !frameThen) return { kind: "new", headline: "New — this call started at this step.", details: [] };
  let before: Value | undefined;
  if (q.expr === q.head) before = bindingsOf(prev, frameId).find((b) => b.name === q.head)?.value;
  else {
    const r = evaluateSource(q.expr, scopeOf(prev, frameId));
    before = r.ok ? r.value : undefined;
  }
  if (!before) return { kind: "new", headline: scopeKind === "global" ? "New — assigned by the previous step." : "New — first assigned by the previous step.", details: [] };
  const same = v.t === "ref" && before.t === "ref" ? v.id === before.id : valuesEqual(v, state.heap, before, prev.heap);
  if (!same) {
    return { kind: "rebound", headline: v.t === "ref" || before.t === "ref" ? "Now refers to a different object." : "Changed since the previous step.", was: fmt(before, prev.heap, lang, 60, 2), details: [] };
  }
  if (v.t === "ref") {
    const ch = diff.objects.get(v.id);
    const cur = state.heap[v.id];
    if (ch && !ch.isNew && cur) return { kind: "mutated", headline: "Same object, changed in place by the previous step.", details: describeMutation(ch, prev.heap[v.id], cur, prev.heap, state.heap, lang) };
    if (ch && ch.isNew) return { kind: "new", headline: "New object created by the previous step.", details: [] };
  }
  return { kind: "unchanged", headline: "Unchanged since the previous step.", details: [] };
}

/** What a hover over `q` shows at the selected step; null when the name is not a variable of this program at all. */
export function resolvePeek(input: PeekInput, q: PeekQuery, opts: { stale?: boolean } = {}): PeekModel | null {
  const { trace, state, language: lang } = input;
  const index = indexOf(trace);
  const model = base(input, q);
  const isChain = q.expr !== q.head;

  // names that are never bound anywhere in the trace (builtins, imports, attributes) are not variables
  const known = index.names.has(q.head);
  if (!known) return null;
  // the code was edited after this trace was recorded: line numbers (and so scopes) may no longer match
  if (opts.stale) return unavailable(model, "stale", "The code was edited after this trace was recorded, so the values may not match the code on screen. Run again to peek.");

  const owners = ownersOfLine(index, q.line, input.functions);
  const { frame, inactiveFunction } = chooseFrame(state, input.selectedFrameId, owners);

  if (inactiveFunction !== undefined) {
    // the line belongs to a function that is not on the stack at this step
    const local = index.locals.get(inactiveFunction)?.has(q.head);
    if (!local) {
      // might still be a global read inside it
      const g = bindingsOf(state, undefined).find((b) => b.name === q.head);
      if (!g) return unavailable(model, "inactive", `${inactiveFunction}() is not running at this step, so ${q.head} has no value here.`, index.firstCall.get(inactiveFunction));
      return found(input, model, q, undefined, g.value, "global", { isChain });
    }
    return unavailable(model, "inactive", `${q.head} belongs to ${inactiveFunction}(), which is not running at this step.`, index.firstCall.get(inactiveFunction), inactiveFunction);
  }

  const frameId = frame?.id;
  const binding = bindingsOf(state, frameId).find((b) => b.name === q.head);
  if (!binding) {
    const later = findBinding(trace, state.index, frameId, q.head, 1);
    if (later !== undefined) return unavailable(model, "not-yet", `${q.head} has not been assigned yet at this step.`, later, undefined, `first assigned at step ${later}`);
    const earlier = findBinding(trace, state.index, frameId, q.head, -1);
    if (earlier !== undefined) return unavailable(model, "unbound", `${q.head} is no longer defined here (it was removed or went out of scope).`, earlier, undefined, `last defined at step ${earlier}`);
    return unavailable(model, "unbound", `${q.head} is never assigned in ${frame ? "this call" : "the top-level code"} — the line that assigns it may not run on this path.`);
  }

  let value = binding.value;
  if (isChain) {
    const r = evaluateSource(q.expr, scopeOf(state, frameId));
    if (!r.ok) {
      // an attribute that does not exist (a method name, a typo): nothing useful to show
      return /not found|no attribute|has no/i.test(r.error) ? null : unavailable(model, "unresolved", `${q.expr} cannot be followed at this step: ${r.error}.`);
    }
    value = r.value;
  }
  return found(input, model, q, frame, value, binding.kind, { isChain });
}

function unavailable(m: PeekModel, status: PeekStatus, message: string, jumpStep?: number, _fn?: string, jumpLabel?: string): PeekModel {
  return { ...m, status, message, ...(jumpStep !== undefined ? { jump: { step: jumpStep, label: jumpLabel ? `Go to step ${jumpStep} (${jumpLabel})` : `Go to step ${jumpStep}` } } : {}) };
}

function found(input: PeekInput, m: PeekModel, q: PeekQuery, frame: TraceFrame | undefined, v: Value, scopeKind: "local" | "closure" | "global", _o: { isChain: boolean }): PeekModel {
  const { state, language: lang } = input;
  const heap = state.heap;
  const obj = v.t === "ref" ? heap[v.id] : undefined;
  const out: PeekModel = { ...m, status: "value", scopeKind, type: typeName(v, heap, lang) };

  // scope: which call this value belongs to
  if (scopeKind === "global" || !frame) out.scopeLabel = "global";
  else {
    const same = state.stack.filter((f) => f.name === frame.name);
    const depth = same.indexOf(frame) + 1;
    out.scopeLabel = `${describeFrame(frame, state, lang)}${same.length > 1 ? ` · recursion depth ${depth} of ${same.length}` : ""}${scopeKind === "closure" ? " · enclosing function" : ""}`;
    if (same.length > 1 && q.expr === q.head)
      out.others = same
        .map((f, i) => {
          const b = f.locals.find(([k]) => k === q.head)?.[1] ?? f.closure?.find(([k]) => k === q.head)?.[1];
          return b ? { depth: i + 1, value: fmt(b, heap, lang, 22, 1), selected: f.id === frame.id } : undefined;
        })
        .filter((x): x is { depth: number; value: string; selected: boolean } => !!x)
        .slice(0, 8);
  }

  const len = lengthOf(v, heap);
  if (len !== undefined) out.length = len;
  out.summary = fmt(v, heap, lang, 140, 2);
  if (v.t === "str") out.text = v.v;
  if (obj) {
    out.objectId = v.t === "ref" ? v.id : undefined;
    const { rows, more } = rowsFor(obj, heap, lang, state.index === input.event.index ? input.diff.objects.get((v as { id: string }).id) : undefined);
    out.rows = rows;
    out.rowsMore = more;
    // other names for the same object
    const names: string[] = [];
    const id = (v as { id: string }).id;
    for (const f of state.stack) for (const [k, x] of f.locals) if (x.t === "ref" && x.id === id && !(f === frame && k === q.head)) names.push(f === frame || f.name === "<module>" ? k : `${k} in ${f.name}()`);
    for (const [k, x] of state.globals) if (x.t === "ref" && x.id === id && !(scopeKind === "global" && k === q.head)) names.push(`${k} (global)`);
    // an attribute of another object also refers to it: `head.next`, or `a Node's next` when the holder has no name
    const nameOf = (oid: string): string | undefined => {
      for (const f of state.stack) for (const [k, x] of f.locals) if (x.t === "ref" && x.id === oid) return k;
      return state.globals.find(([, x]) => x.t === "ref" && x.id === oid)?.[0];
    };
    for (const [oid, o] of Object.entries(heap)) {
      if (oid === id || o.kind !== "object") continue;
      for (const [k, x] of o.attrs) {
        if (x.t !== "ref" || x.id !== id || names.length >= 8) continue;
        const holder = nameOf(oid);
        names.push(holder ? `${holder}.${k}` : `a ${o.typeName}'s ${k}`);
      }
    }
    out.aliases = [...new Set(names)].slice(0, 6);
  }
  out.notes = captureNotes(v, heap, lang);
  if (q.expr === q.head) {
    // only up to the selected step: the future is never shown
    const h = variableHistory(input.trace, frame && scopeKind !== "global" ? frame.id : "globals", q.head, lang, state.index);
    out.history = h.segments.slice(-6).map((seg) => ({ step: seg.from, value: seg.text }));
    out.mutatedAt = (h.segments[h.segments.length - 1]?.mutations ?? []).slice(-6);
  }
  const change = changeOf(input, frame?.id, q, v, scopeKind);
  if (change) out.change = change;
  out.highlight = { name: q.head, frameId: frame?.id ?? null, ...(out.objectId ? { objectId: out.objectId } : {}) };
  return out;
}

