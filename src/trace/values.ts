import type { HeapObject, Language, Value } from "./schema";

export type Heap = Readonly<Record<string, HeapObject>>;

export function isRef(v: Value): v is { t: "ref"; id: string } {
  return v.t === "ref";
}

export function deref(v: Value | undefined, heap: Heap): HeapObject | undefined {
  return v && v.t === "ref" ? heap[v.id] : undefined;
}

export function isNumeric(v: Value | undefined): v is { t: "int"; v: number } | { t: "float"; v: number } {
  return !!v && (v.t === "int" || v.t === "float") && typeof v.v === "number";
}

export function numberOf(v: Value | undefined): number | undefined {
  return isNumeric(v) ? v.v : undefined;
}

/** Stable key for a primitive (used for dict keys, set membership, diffing). */
export function primitiveKey(v: Value): string {
  switch (v.t) {
    case "none":
      return "None";
    case "undefined":
      return "undefined";
    case "bool":
      return v.v ? "b:1" : "b:0";
    case "int":
      return `n:${v.v}`;
    case "float":
      return Number.isInteger(v.v) ? `n:${v.v}` : `f:${v.v}`;
    case "str":
      return `s:${v.v}`;
    case "symbol":
      return `y:${v.v}`;
    case "ref":
      return `r:${v.id}`;
  }
}

/**
 * Structural key of a value: primitives by value, tuples by content (they are
 * values in Python), everything else by identity. Used to match dict keys and
 * set members across snapshots.
 */
export function valueKey(v: Value, heap: Heap, depth = 0): string {
  if (v.t !== "ref") return primitiveKey(v);
  const o = heap[v.id];
  if (o && o.kind === "tuple" && depth < 6) return `t(${o.items.map((x) => valueKey(x, heap, depth + 1)).join(",")})`;
  return `r:${v.id}`;
}

function quote(s: string, lang: Language): string {
  if (lang === "javascript") return JSON.stringify(s);
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
}

export function formatPrimitive(v: Value, lang: Language): string {
  switch (v.t) {
    case "none":
      return lang === "python" ? "None" : "null";
    case "undefined":
      return "undefined";
    case "bool":
      return lang === "python" ? (v.v ? "True" : "False") : String(v.v);
    case "int":
      return String(v.v);
    case "float":
      if (typeof v.v === "string") return v.v;
      return lang === "python" && Number.isInteger(v.v) ? `${v.v}.0` : String(v.v);
    case "str":
      return quote(v.v, lang) + (v.len !== undefined ? `…(+${v.len - v.v.length})` : "");
    case "symbol":
      return v.v;
    case "ref":
      return `#${v.id}`;
  }
}

export interface FormatOptions {
  maxLength?: number;
  maxDepth?: number;
}

/** Human-readable rendering of a captured value. Truncation is always marked with "…". */
export function formatValue(v: Value, heap: Heap, lang: Language, opts: FormatOptions = {}): string {
  const maxLength = opts.maxLength ?? 120;
  const maxDepth = opts.maxDepth ?? 3;
  const seen = new Set<string>();
  const out = fmt(v, 0);
  return out.length > maxLength ? out.slice(0, maxLength - 1) + "…" : out;

  function fmt(x: Value, d: number): string {
    if (x.t !== "ref") return formatPrimitive(x, lang);
    const o = heap[x.id];
    if (!o) return `<#${x.id}>`;
    if (seen.has(x.id)) return lang === "python" ? "[…cycle]" : "[Circular]";
    if (d >= maxDepth) return summarizeObject(o, lang);
    seen.add(x.id);
    let s: string;
    switch (o.kind) {
      case "list":
      case "tuple":
      case "set":
      case "deque": {
        const inner = o.items.map((i) => fmt(i, d + 1));
        if (o.truncated) inner.push(`…+${o.truncated.total - o.truncated.shown}`);
        const body = inner.join(", ");
        if (o.kind === "tuple") s = `(${body}${o.items.length === 1 && lang === "python" ? "," : ""})`;
        else if (o.kind === "set") s = lang === "python" ? (o.items.length ? `{${body}}` : "set()") : `Set{${body}}`;
        else if (o.kind === "deque") s = `deque([${body}])`;
        else s = `[${body}]`;
        if (o.typeName !== "list" && o.typeName !== "tuple" && o.typeName !== "set" && o.typeName !== "deque" && o.typeName !== "Array" && o.typeName !== "Set")
          s = `${o.typeName}(${s})`;
        break;
      }
      case "dict": {
        const inner = o.entries.map(([k, val]) => `${fmt(k, d + 1)}: ${fmt(val, d + 1)}`);
        if (o.truncated) inner.push(`…+${o.truncated.total - o.truncated.shown}`);
        s = `{${inner.join(", ")}}`;
        if (o.typeName !== "dict" && o.typeName !== "Object") s = `${o.typeName}(${s})`;
        break;
      }
      case "object": {
        const inner = o.attrs.map(([k, val]) => `${k}=${fmt(val, d + 1)}`);
        if (o.truncated) inner.push("…");
        s = `${o.typeName}(${inner.join(", ")})`;
        break;
      }
      case "function":
        s = lang === "python" ? `<function ${o.repr}>` : `ƒ ${o.repr}`;
        break;
      case "class":
        s = `<class ${o.repr}>`;
        break;
      case "other":
        s = o.repr;
        break;
      case "elided":
        s = summarizeObject(o, lang);
        break;
    }
    seen.delete(x.id);
    return s;
  }
}

export function summarizeObject(o: HeapObject, _lang: Language): string {
  switch (o.kind) {
    case "list":
    case "tuple":
    case "set":
    case "deque":
    case "dict":
      return `${o.typeName}[${o.length}]`;
    case "object":
      return `${o.typeName}{…}`;
    case "elided":
      return `${o.typeName}${o.length !== undefined ? `[${o.length}]` : ""} (not captured: ${o.reason} limit)`;
    default:
      return o.repr;
  }
}

/** Deep structural equality between two captured values (identity-insensitive, cycle-safe). */
export function valuesEqual(a: Value, ha: Heap, b: Value, hb: Heap): boolean {
  const pairs = new Set<string>();
  return eq(a, b, 0);

  function eq(x: Value, y: Value, d: number): boolean {
    if (d > 200) return true;
    if (x.t !== "ref" || y.t !== "ref") {
      if (x.t === "ref" || y.t === "ref") return false;
      if ((x.t === "int" || x.t === "float") && (y.t === "int" || y.t === "float")) return Number(x.v) === Number(y.v);
      return primitiveKey(x) === primitiveKey(y);
    }
    const key = `${x.id}|${y.id}`;
    if (pairs.has(key)) return true;
    pairs.add(key);
    const ox = ha[x.id];
    const oy = hb[y.id];
    if (!ox || !oy) return ox === oy;
    if (ox.kind !== oy.kind) return false;
    switch (ox.kind) {
      case "list":
      case "tuple":
      case "deque": {
        const o2 = oy as typeof ox;
        if (ox.length !== o2.length || ox.items.length !== o2.items.length) return false;
        return ox.items.every((v, i) => eq(v, o2.items[i] as Value, d + 1));
      }
      case "set": {
        const o2 = oy as typeof ox;
        if (ox.length !== o2.length) return false;
        const ks = new Set(o2.items.map((v) => valueKey(v, hb)));
        return ox.items.every((v) => ks.has(valueKey(v, ha)));
      }
      case "dict": {
        const o2 = oy as typeof ox;
        if (ox.length !== o2.length) return false;
        const m = new Map(o2.entries.map(([k, v]) => [valueKey(k, hb), v] as const));
        return ox.entries.every(([k, v]) => {
          const other = m.get(valueKey(k, ha));
          return other !== undefined && eq(v, other, d + 1);
        });
      }
      case "object": {
        const o2 = oy as typeof ox;
        if (ox.typeName !== o2.typeName || ox.attrs.length !== o2.attrs.length) return false;
        const m = new Map(o2.attrs);
        return ox.attrs.every(([k, v]) => {
          const other = m.get(k);
          return other !== undefined && eq(v, other, d + 1);
        });
      }
      case "function":
      case "class":
      case "other":
        return x.id === y.id || ox.repr === (oy as typeof ox).repr;
      case "elided":
        return x.id === y.id;
    }
  }
}

/** Converts a captured value into plain JSON (for comparisons and export). Cycles become "<cycle>". */
export function toPlain(v: Value, heap: Heap, depth = 0, seen: Set<string> = new Set()): unknown {
  if (depth > 100) return "…";
  switch (v.t) {
    case "none":
      return null;
    case "undefined":
      return null;
    case "bool":
      return v.v;
    case "int":
      return v.big ? v.v : v.v;
    case "float":
      return v.v;
    case "str":
      return v.v;
    case "symbol":
      return v.v;
    case "ref": {
      const o = heap[v.id];
      if (!o) return null;
      if (seen.has(v.id)) return "<cycle>";
      seen.add(v.id);
      let out: unknown;
      switch (o.kind) {
        case "list":
        case "tuple":
        case "set":
        case "deque":
          out = o.items.map((x) => toPlain(x, heap, depth + 1, seen));
          break;
        case "dict": {
          const rec: Record<string, unknown> = {};
          for (const [k, val] of o.entries) {
            const pk = toPlain(k, heap, depth + 1, seen);
            rec[typeof pk === "string" ? pk : JSON.stringify(pk)] = toPlain(val, heap, depth + 1, seen);
          }
          out = rec;
          break;
        }
        case "object": {
          const rec: Record<string, unknown> = {};
          for (const [k, val] of o.attrs) rec[k] = toPlain(val, heap, depth + 1, seen);
          out = rec;
          break;
        }
        default:
          out = o.kind === "elided" ? `<${o.typeName}: not captured>` : o.repr;
      }
      seen.delete(v.id);
      return out;
    }
  }
}

export function typeLabel(v: Value, heap: Heap): string {
  if (v.t !== "ref") {
    return { none: "None", undefined: "undefined", bool: "bool", int: "int", float: "float", str: "str", symbol: "symbol" }[v.t];
  }
  return heap[v.id]?.typeName ?? "object";
}
