import type { Value } from "./schema";
import { type Heap, primitiveKey, valueKey } from "./values";

/**
 * A constrained, side-effect-free expression language evaluated against a
 * recorded snapshot. It never executes user code and never touches the live
 * runtime. Supported syntax (Python- and JS-flavoured):
 *
 *   literals      12  3.5  'str'  "str"  True False None true false null
 *   names         x
 *   access        a[i]  a[-1]  obj.attr  m["key"]  a.length  s.size
 *   arithmetic    + - * / // % **   unary -
 *   comparison    == != === !== < <= > >=   in   not in
 *   logic         and or not   && || !
 *   builtins      len(x) min(a, b, …) max(…) abs(x) sum(xs) sorted(xs) str(x) int(x)
 *
 * Values computed by the evaluator (e.g. `i + 1`) are primitives; values read
 * from the snapshot keep their identity (`ref`).
 */

export class EvalError extends Error {}

type Node =
  | { k: "num"; v: number; isFloat: boolean }
  | { k: "str"; v: string }
  | { k: "const"; v: Value }
  | { k: "name"; name: string }
  | { k: "index"; obj: Node; idx: Node }
  | { k: "attr"; obj: Node; name: string }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "list"; items: Node[] };

interface Tok {
  t: "num" | "str" | "id" | "op" | "eof";
  v: string;
  pos: number;
}

const OPS = ["===", "!==", "**", "//", "==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "(", ")", "[", "]", ".", ","];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      const s = m ? m[0] : c;
      toks.push({ t: "num", v: s, pos: i });
      i += s.length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1] as string;
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new EvalError("Unterminated string literal");
      toks.push({ t: "str", v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      const s = (m as RegExpExecArray)[0];
      toks.push({ t: "id", v: s, pos: i });
      i += s.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new EvalError(`Unsupported character '${c}'`);
    toks.push({ t: "op", v: op, pos: i });
    i += op.length;
  }
  toks.push({ t: "eof", v: "", pos: src.length });
  return toks;
}

const BIN_PREC: Record<string, number> = {
  or: 1,
  "||": 1,
  and: 2,
  "&&": 2,
  in: 4,
  "not in": 4,
  "==": 4,
  "!=": 4,
  "===": 4,
  "!==": 4,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "//": 6,
  "%": 6,
  "**": 8,
};

export function parseExpression(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok => toks[p] as Tok;
  const next = (): Tok => toks[p++] as Tok;
  const expect = (v: string): void => {
    const t = next();
    if (t.v !== v) throw new EvalError(`Expected '${v}' at position ${t.pos}`);
  };

  function binOp(): string | null {
    const t = peek();
    if (t.t === "op" && BIN_PREC[t.v] !== undefined) return t.v;
    if (t.t === "id" && (t.v === "and" || t.v === "or" || t.v === "in")) return t.v;
    if (t.t === "id" && t.v === "not" && toks[p + 1]?.v === "in") return "not in";
    return null;
  }

  function parseBin(minPrec: number): Node {
    let left = parseUnary();
    for (;;) {
      const op = binOp();
      if (!op) break;
      const prec = BIN_PREC[op] as number;
      if (prec < minPrec) break;
      next();
      if (op === "not in") next();
      const right = parseBin(op === "**" ? prec : prec + 1);
      left = { k: "bin", op, a: left, b: right };
    }
    return left;
  }

  function parseUnary(): Node {
    const t = peek();
    if ((t.t === "op" && (t.v === "-" || t.v === "+" || t.v === "!")) || (t.t === "id" && t.v === "not")) {
      next();
      const a = parseBin(t.v === "not" ? 3 : 7);
      return { k: "un", op: t.v === "!" ? "not" : t.v, a };
    }
    return parsePostfix(parsePrimary());
  }

  function parsePrimary(): Node {
    const t = next();
    if (t.t === "num") {
      const isFloat = /[.eE]/.test(t.v);
      return { k: "num", v: Number(t.v), isFloat };
    }
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "id") {
      switch (t.v) {
        case "True":
        case "true":
          return { k: "const", v: { t: "bool", v: true } };
        case "False":
        case "false":
          return { k: "const", v: { t: "bool", v: false } };
        case "None":
        case "null":
          return { k: "const", v: { t: "none" } };
        case "undefined":
          return { k: "const", v: { t: "undefined" } };
      }
      if (peek().v === "(") {
        next();
        const args: Node[] = [];
        if (peek().v !== ")") {
          for (;;) {
            args.push(parseBin(1));
            if (peek().v === ",") next();
            else break;
          }
        }
        expect(")");
        return { k: "call", fn: t.v, args };
      }
      return { k: "name", name: t.v };
    }
    if (t.v === "(") {
      const e = parseBin(1);
      expect(")");
      return e;
    }
    if (t.v === "[") {
      const items: Node[] = [];
      if (peek().v !== "]") {
        for (;;) {
          items.push(parseBin(1));
          if (peek().v === ",") next();
          else break;
        }
      }
      expect("]");
      return { k: "list", items };
    }
    throw new EvalError(t.t === "eof" ? "Unexpected end of expression" : `Unexpected '${t.v}' at position ${t.pos}`);
  }

  function parsePostfix(n: Node): Node {
    for (;;) {
      const t = peek();
      if (t.v === "[") {
        next();
        const idx = parseBin(1);
        expect("]");
        n = { k: "index", obj: n, idx };
      } else if (t.v === ".") {
        next();
        const id = next();
        if (id.t !== "id") throw new EvalError("Expected attribute name after '.'");
        n = { k: "attr", obj: n, name: id.v };
      } else return n;
    }
  }

  const e = parseBin(1);
  if (peek().t !== "eof") throw new EvalError(`Unexpected '${peek().v}' at position ${peek().pos}`);
  return e;
}

export interface Scope {
  lookup(name: string): Value | undefined;
  heap: Heap;
}

export function scopeFrom(bindings: ReadonlyArray<readonly [string, Value]>, heap: Heap): Scope {
  const m = new Map<string, Value>();
  for (const [k, v] of bindings) if (!m.has(k)) m.set(k, v);
  return { lookup: (n) => m.get(n), heap };
}

const int = (n: number): Value => ({ t: "int", v: n });
const num = (n: number, float: boolean): Value => (float || !Number.isInteger(n) ? { t: "float", v: n } : int(n));
const bool = (b: boolean): Value => ({ t: "bool", v: b });

function truthy(v: Value, heap: Heap): boolean {
  switch (v.t) {
    case "none":
    case "undefined":
      return false;
    case "bool":
      return v.v;
    case "int":
    case "float":
      return Number(v.v) !== 0;
    case "str":
      return v.v.length > 0;
    case "symbol":
      return true;
    case "ref": {
      const o = heap[v.id];
      if (o && (o.kind === "list" || o.kind === "tuple" || o.kind === "set" || o.kind === "deque" || o.kind === "dict")) return o.length > 0;
      return true;
    }
  }
}

function asNumber(v: Value, what: string): number {
  if ((v.t === "int" || v.t === "float") && typeof v.v === "number") return v.v;
  if (v.t === "bool") return v.v ? 1 : 0;
  throw new EvalError(`${what} is not a number`);
}

function lengthOf(v: Value, heap: Heap): number {
  if (v.t === "str") return v.len ?? v.v.length;
  const o = v.t === "ref" ? heap[v.id] : undefined;
  if (o && "length" in o && typeof o.length === "number") return o.length;
  throw new EvalError("value has no length");
}

function elements(v: Value, heap: Heap): Value[] {
  if (v.t === "str") return [...v.v].map((c) => ({ t: "str", v: c }));
  const o = v.t === "ref" ? heap[v.id] : undefined;
  if (!o) throw new EvalError("value is not iterable");
  if (o.kind === "list" || o.kind === "tuple" || o.kind === "set" || o.kind === "deque") {
    if (o.truncated) throw new EvalError("collection was truncated in this snapshot");
    return o.items;
  }
  if (o.kind === "dict") {
    if (o.truncated) throw new EvalError("collection was truncated in this snapshot");
    return o.entries.map(([k]) => k);
  }
  throw new EvalError("value is not iterable");
}

export function evaluate(node: Node, scope: Scope): Value {
  const heap = scope.heap;
  switch (node.k) {
    case "num":
      return num(node.v, node.isFloat);
    case "str":
      return { t: "str", v: node.v };
    case "const":
      return node.v;
    case "list":
      throw new EvalError("list literals are only supported as arguments to min()/max()");
    case "name": {
      const v = scope.lookup(node.name);
      if (v === undefined) throw new EvalError(`'${node.name}' is not in scope at this step`);
      return v;
    }
    case "attr": {
      const base = evaluate(node.obj, scope);
      if ((node.name === "length" || node.name === "size") && base.t !== "ref") return int(lengthOf(base, heap));
      const o = base.t === "ref" ? heap[base.id] : undefined;
      if (!o) throw new EvalError(`cannot read .${node.name} of ${base.t}`);
      if ((node.name === "length" || node.name === "size") && "length" in o) return int(o.length as number);
      if (o.kind === "object") {
        const hit = o.attrs.find(([k]) => k === node.name);
        if (hit) return hit[1];
      }
      if (o.kind === "dict" && o.typeName === "Object") {
        const hit = o.entries.find(([k]) => k.t === "str" && k.v === node.name);
        if (hit) return hit[1];
      }
      if (o.kind === "elided") throw new EvalError(`object was not captured (${o.reason} limit)`);
      throw new EvalError(`${o.typeName} has no attribute '${node.name}' in this snapshot`);
    }
    case "index": {
      const base = evaluate(node.obj, scope);
      const idx = evaluate(node.idx, scope);
      if (base.t === "str") {
        let i = asNumber(idx, "index");
        if (i < 0) i += base.v.length;
        const c = base.v[i];
        if (c === undefined) throw new EvalError(`string index ${i} out of range`);
        return { t: "str", v: c };
      }
      const o = base.t === "ref" ? heap[base.id] : undefined;
      if (!o) throw new EvalError("value is not subscriptable");
      if (o.kind === "list" || o.kind === "tuple" || o.kind === "deque") {
        let i = asNumber(idx, "index");
        if (!Number.isInteger(i)) throw new EvalError("index must be an integer");
        if (i < 0) i += o.length;
        if (i < 0 || i >= o.length) throw new EvalError(`index ${i} out of range (length ${o.length})`);
        const item = o.items[i];
        if (item === undefined) throw new EvalError(`index ${i} was not captured (collection truncated)`);
        return item;
      }
      if (o.kind === "dict") {
        const key = valueKey(idx, heap);
        const hit = o.entries.find(([k]) => valueKey(k, heap) === key || (k.t !== "ref" && idx.t !== "ref" && looseKey(k) === looseKey(idx)));
        if (hit) return hit[1];
        if (o.truncated) throw new EvalError("key not found in captured part (dict truncated)");
        throw new EvalError(`key ${idx.t === "str" ? JSON.stringify(idx.v) : primitiveKey(idx).slice(2)} not present`);
      }
      if (o.kind === "object") {
        const name = idx.t === "str" ? idx.v : String(asNumber(idx, "key"));
        const hit = o.attrs.find(([k]) => k === name);
        if (hit) return hit[1];
        throw new EvalError(`no property '${name}'`);
      }
      if (o.kind === "elided") throw new EvalError(`object was not captured (${o.reason} limit)`);
      throw new EvalError(`${o.typeName} is not subscriptable`);
    }
    case "un": {
      const a = evaluate(node.a, scope);
      if (node.op === "not") return bool(!truthy(a, heap));
      const n = asNumber(a, "operand");
      return num(node.op === "-" ? -n : n, a.t === "float");
    }
    case "bin": {
      if (node.op === "and" || node.op === "&&") {
        const a = evaluate(node.a, scope);
        return truthy(a, heap) ? evaluate(node.b, scope) : a;
      }
      if (node.op === "or" || node.op === "||") {
        const a = evaluate(node.a, scope);
        return truthy(a, heap) ? a : evaluate(node.b, scope);
      }
      const a = evaluate(node.a, scope);
      const b = evaluate(node.b, scope);
      switch (node.op) {
        case "in":
        case "not in": {
          let r: boolean;
          if (b.t === "str") {
            if (a.t !== "str") throw new EvalError("'in <string>' requires a string");
            r = b.v.includes(a.v);
          } else {
            const key = valueKey(a, heap);
            r = elements(b, heap).some((e) => valueKey(e, heap) === key || (e.t !== "ref" && a.t !== "ref" && looseKey(e) === looseKey(a)));
          }
          return bool(node.op === "in" ? r : !r);
        }
        case "==":
        case "===":
        case "!=":
        case "!==": {
          let r: boolean;
          if (a.t === "ref" || b.t === "ref") r = a.t === "ref" && b.t === "ref" && a.id === b.id;
          else r = looseKey(a) === looseKey(b);
          return bool(node.op === "==" || node.op === "===" ? r : !r);
        }
        case "<":
        case "<=":
        case ">":
        case ">=": {
          if (a.t === "str" && b.t === "str") {
            const c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
            return bool(cmp(node.op, c));
          }
          const x = asNumber(a, "left operand");
          const y = asNumber(b, "right operand");
          return bool(cmp(node.op, x < y ? -1 : x > y ? 1 : 0));
        }
        default: {
          if (node.op === "+" && a.t === "str" && b.t === "str") return { t: "str", v: a.v + b.v };
          const x = asNumber(a, "left operand");
          const y = asNumber(b, "right operand");
          const isF = a.t === "float" || b.t === "float";
          switch (node.op) {
            case "+":
              return num(x + y, isF);
            case "-":
              return num(x - y, isF);
            case "*":
              return num(x * y, isF);
            case "/":
              if (y === 0) throw new EvalError("division by zero");
              return { t: "float", v: x / y };
            case "//":
              if (y === 0) throw new EvalError("division by zero");
              return num(Math.floor(x / y), isF);
            case "%":
              if (y === 0) throw new EvalError("modulo by zero");
              return num(((x % y) + y) % y, isF);
            case "**":
              return num(x ** y, isF);
          }
          throw new EvalError(`unsupported operator ${node.op}`);
        }
      }
    }
    case "call":
      return callBuiltin(node.fn, node.args, scope);
  }
}

function cmp(op: string, c: number): boolean {
  return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
}

function looseKey(v: Value): string {
  if (v.t === "float" && typeof v.v === "number" && Number.isInteger(v.v)) return `n:${v.v}`;
  if (v.t === "undefined") return "None";
  return primitiveKey(v);
}

function callBuiltin(fn: string, argNodes: Node[], scope: Scope): Value {
  const heap = scope.heap;
  const listArgs = (): Value[] => {
    if (argNodes.length === 1 && argNodes[0]?.k !== "list") return elements(evaluate(argNodes[0] as Node, scope), heap);
    if (argNodes.length === 1 && argNodes[0]?.k === "list") return argNodes[0].items.map((n) => evaluate(n, scope));
    return argNodes.map((n) => evaluate(n, scope));
  };
  switch (fn) {
    case "len":
      if (argNodes.length !== 1) throw new EvalError("len() takes one argument");
      return int(lengthOf(evaluate(argNodes[0] as Node, scope), heap));
    case "abs": {
      const v = evaluate(argNodes[0] as Node, scope);
      return num(Math.abs(asNumber(v, "argument")), v.t === "float");
    }
    case "min":
    case "max": {
      const vals = listArgs();
      if (!vals.length) throw new EvalError(`${fn}() of empty sequence`);
      let best = vals[0] as Value;
      for (const v of vals.slice(1)) {
        const better = fn === "min" ? asNumber(v, "argument") < asNumber(best, "argument") : asNumber(v, "argument") > asNumber(best, "argument");
        if (better) best = v;
      }
      return best;
    }
    case "sum": {
      const vals = listArgs();
      let s = 0;
      let isF = false;
      for (const v of vals) {
        s += asNumber(v, "element");
        if (v.t === "float") isF = true;
      }
      return num(s, isF);
    }
    case "int":
      return int(Math.trunc(asNumber(evaluate(argNodes[0] as Node, scope), "argument")));
    case "str": {
      const v = evaluate(argNodes[0] as Node, scope);
      if (v.t === "ref") throw new EvalError("str() of an object is not supported");
      return { t: "str", v: v.t === "str" ? v.v : primitiveKey(v).replace(/^[a-z]:/, "") };
    }
    default:
      throw new EvalError(`function '${fn}' is not available in watch expressions`);
  }
}

/** Parse + evaluate with error capture. */
export function evaluateSource(src: string, scope: Scope): { ok: true; value: Value } | { ok: false; error: string } {
  try {
    return { ok: true, value: evaluate(parseExpression(src), scope) };
  } catch (e) {
    return { ok: false, error: e instanceof EvalError ? e.message : `cannot evaluate: ${(e as Error).message}` };
  }
}

/** Identifiers referenced by an expression (for dependency hints). */
export function freeNames(src: string): string[] {
  try {
    const out = new Set<string>();
    const walk = (n: Node): void => {
      switch (n.k) {
        case "name":
          out.add(n.name);
          break;
        case "index":
          walk(n.obj);
          walk(n.idx);
          break;
        case "attr":
          walk(n.obj);
          break;
        case "call":
          n.args.forEach(walk);
          break;
        case "un":
          walk(n.a);
          break;
        case "bin":
          walk(n.a);
          walk(n.b);
          break;
        case "list":
          n.items.forEach(walk);
          break;
        default:
          break;
      }
    };
    walk(parseExpression(src));
    return [...out];
  } catch {
    return [];
  }
}
