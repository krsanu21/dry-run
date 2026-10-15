import { parse, type Options as AcornOptions } from "acorn";
import { generate } from "astring";
import type * as E from "estree";
import type { Diagnostic } from "../../trace/schema";

/**
 * AST-based instrumentation for the JavaScript adapter.
 *
 * The user's program is parsed with acorn, transformed, and printed with
 * astring. No regular-expression rewriting is involved. The transformation
 * only INSERTS calls into the `__dr` runtime; it never wraps user functions in
 * new functions, so `this`, `arguments`, hoisting, and closures keep their
 * original meaning.
 *
 * Inserted boundaries (see docs/trace-schema.md, "JavaScript adapter"):
 *   - `__dr.L(frame, line, col, getter)` before each statement → `line` event
 *   - loop headers: before each re-test of `while`/`do…while`, before each
 *     update+test of `for(;;)`, at the start of each `for…of`/`for…in` iteration
 *   - `__dr.C(...)` at function entry → `call`;  `__dr.R(...)` wraps return values → `return`
 *   - `catch` blocks call `__dr.K` → `exception`; a function-level catch calls `__dr.X`
 *     when an exception escapes a frame; `finally` calls `__dr.F` to pop the frame
 *   - `yield v` → `__dr.YI(f, yield __dr.YO(f, …, v))` (suspend/resume of generator frames)
 *
 * Getters are arrow functions `() => [["x", () => x], …]` evaluated lazily by
 * the runtime; each binding is read inside try/catch so temporal-dead-zone
 * bindings are reported as not-yet-initialized instead of throwing.
 */

export const RESERVED_PREFIX = "__dr";
const FRAME = "__dr_f";
const RT = "__dr";

export interface InstrumentResult {
  ok: boolean;
  code: string;
  diagnostics: Diagnostic[];
  /** Top-level binding names of the program. */
  topLevelNames: string[];
}

interface Scope {
  names: string[];
  kind: "program" | "function" | "block";
  hasThis: boolean;
  isGenerator: boolean;
}

type AnyNode = E.Node & { start?: number; end?: number; loc?: E.SourceLocation | null };

// ---------------------------------------------------------------------------
// tiny AST builders
const id = (name: string): E.Identifier => ({ type: "Identifier", name });
const lit = (value: string | number | boolean | null): E.Literal => ({ type: "Literal", value }) as E.Literal;
const member = (obj: E.Expression, prop: string): E.MemberExpression => ({
  type: "MemberExpression",
  object: obj,
  property: id(prop),
  computed: false,
  optional: false,
});
const call = (callee: E.Expression, args: E.Expression[]): E.CallExpression => ({
  type: "CallExpression",
  callee,
  arguments: args,
  optional: false,
});
const rtCall = (fn: string, args: E.Expression[]): E.CallExpression => call(member(id(RT), fn), args);
const exprStmt = (e: E.Expression): E.ExpressionStatement => ({ type: "ExpressionStatement", expression: e });
const arrow = (body: E.Expression): E.ArrowFunctionExpression => ({
  type: "ArrowFunctionExpression",
  params: [],
  body,
  expression: true,
  async: false,
  generator: false,
});
const arr = (els: E.Expression[]): E.ArrayExpression => ({ type: "ArrayExpression", elements: els });
const block = (body: E.Statement[]): E.BlockStatement => ({ type: "BlockStatement", body });
const seq = (exprs: E.Expression[]): E.SequenceExpression => ({ type: "SequenceExpression", expressions: exprs });

function lineOf(n: AnyNode, offset: number): number {
  return (n.loc?.start.line ?? 1) + offset;
}
function colOf(n: AnyNode): number {
  return n.loc?.start.column ?? 0;
}

// ---------------------------------------------------------------------------
// binding collection

export function patternNames(p: E.Pattern | null | undefined, out: string[] = []): string[] {
  if (!p) return out;
  switch (p.type) {
    case "Identifier":
      out.push(p.name);
      break;
    case "ObjectPattern":
      for (const prop of p.properties) {
        if (prop.type === "RestElement") patternNames(prop.argument, out);
        else patternNames(prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const el of p.elements) patternNames(el, out);
      break;
    case "AssignmentPattern":
      patternNames(p.left, out);
      break;
    case "RestElement":
      patternNames(p.argument, out);
      break;
    default:
      break;
  }
  return out;
}

function lexicalNames(stmts: ReadonlyArray<E.Statement | E.ModuleDeclaration | E.Directive>): string[] {
  const out: string[] = [];
  for (const s of stmts) {
    if (s.type === "VariableDeclaration" && s.kind !== "var") for (const d of s.declarations) patternNames(d.id, out);
    else if (s.type === "ClassDeclaration" && s.id) out.push(s.id.name);
    else if (s.type === "FunctionDeclaration" && s.id) out.push(s.id.name);
  }
  return out;
}

/** `var` declarations hoisted to the enclosing function (not descending into nested functions). */
function hoistedVars(node: E.Node, out: string[] = []): string[] {
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const node = n as E.Node;
    if (typeof node.type !== "string") return;
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return;
    if (node.type === "VariableDeclaration" && node.kind === "var") for (const d of node.declarations) patternNames(d.id, out);
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "type") continue;
      visit((node as unknown as Record<string, unknown>)[key]);
    }
  };
  if (node.type === "BlockStatement" || node.type === "Program") (node.body as E.Node[]).forEach(visit);
  else visit(node);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------

function cleanAcornMessage(msg: string): string {
  return msg.replace(/\s*\(\d+:\d+\)$/, "");
}

export function parseJs(source: string): { ast: E.Program } | { error: Diagnostic } {
  const opts: AcornOptions = {
    ecmaVersion: "latest",
    sourceType: "script",
    locations: true,
    allowHashBang: true,
  };
  try {
    return { ast: parse(source, opts) as unknown as E.Program };
  } catch (e) {
    const err = e as { message: string; loc?: { line: number; column: number } };
    return {
      error: {
        severity: "error",
        kind: "SyntaxError",
        message: cleanAcornMessage(err.message),
        line: err.loc?.line ?? 1,
        column: err.loc?.column ?? 0,
      },
    };
  }
}

/** Checks for constructs the tracer does not support. Errors block execution; warnings do not. */
function checkConstructs(ast: E.Program, diags: Diagnostic[]): void {
  const visit = (n: unknown, inAsync: boolean): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach((x) => visit(x, inAsync));
      return;
    }
    const node = n as AnyNode;
    if (typeof node.type !== "string") return;
    const line = node.loc?.start.line ?? 1;
    const column = node.loc?.start.column ?? 0;
    if (node.type === "Identifier" && node.name.startsWith(RESERVED_PREFIX))
      diags.push({ severity: "error", kind: "ReservedName", line, column, message: `Identifiers starting with "${RESERVED_PREFIX}" are reserved by the Dry Run tracer.` });
    if (node.type === "WithStatement")
      diags.push({ severity: "error", kind: "UnsupportedConstruct", line, column, message: "`with` statements are not supported by the JavaScript tracer." });
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") && node.async && !inAsync) {
      diags.push({ severity: "warning", kind: "UnsupportedConstruct", line, column, message: "async functions run untraced (await/promises are not traced)." });
      inAsync = true;
    }
    if (node.type === "YieldExpression" && node.delegate)
      diags.push({ severity: "warning", kind: "UnsupportedConstruct", line, column, message: "`yield*` delegation is not traced as a suspend/resume boundary." });
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "eval")
      diags.push({ severity: "warning", kind: "UnsupportedConstruct", line, column, message: "Code run through eval() is not traced." });
    if (node.type === "ImportExpression" || node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration")
      diags.push({ severity: "error", kind: "UnsupportedConstruct", line, column, message: "Modules (import/export) are not supported; paste a script." });
    for (const key of Object.keys(node)) {
      if (key === "loc") continue;
      visit((node as unknown as Record<string, unknown>)[key], inAsync);
    }
  };
  visit(ast, false);
}

class Instrumenter {
  private scopes: Scope[] = [];
  constructor(private readonly lineOffset: number) {}

  // -- getters ---------------------------------------------------------------
  private getter(): E.ArrowFunctionExpression {
    // Scopes of the current function (innermost last), then enclosing functions' scopes as closure.
    const localScopes: Scope[] = [];
    const closureScopes: Scope[] = [];
    let hasThis = false;
    let crossedFunction = false;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i] as Scope;
      if (s.kind === "program" && crossedFunction) break;
      (crossedFunction ? closureScopes : localScopes).push(s);
      if (s.kind === "function" || s.kind === "program") {
        if (!crossedFunction) hasThis = s.hasThis;
        crossedFunction = true;
      }
    }
    // Innermost declaration wins; display order is declaration order (outer scopes first).
    const owner = new Map<string, Scope>();
    for (const s of [...localScopes, ...closureScopes]) for (const n of s.names) if (!owner.has(n)) owner.set(n, s);
    const ordered = (scopes: Scope[]): string[] => {
      const out: string[] = [];
      for (const s of [...scopes].reverse()) for (const n of s.names) if (owner.get(n) === s && !n.startsWith(RESERVED_PREFIX) && !out.includes(n)) out.push(n);
      return out;
    };
    const local = ordered(localScopes);
    const closure = ordered(closureScopes);
    const pairs: E.Expression[] = [];
    if (hasThis) pairs.push(arr([lit("this"), arrow({ type: "ThisExpression" })]));
    for (const n of local) pairs.push(arr([lit(n), arrow(id(n))]));
    for (const n of closure) pairs.push(arr([lit(n), arrow(id(n)), lit(1)]));
    return arrow(arr(pairs));
  }

  private hook(n: AnyNode): E.CallExpression {
    return rtCall("L", [id(FRAME), lit(lineOf(n, this.lineOffset)), lit(colOf(n)), this.getter()]);
  }

  private hookStmt(n: AnyNode): E.ExpressionStatement {
    return exprStmt(this.hook(n));
  }

  private withScope<T>(scope: Scope, fn: () => T): T {
    this.scopes.push(scope);
    try {
      return fn();
    } finally {
      this.scopes.pop();
    }
  }

  private currentFunctionIsGenerator(): boolean {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i] as Scope;
      if (s.kind !== "block") return s.isGenerator;
    }
    return false;
  }

  // -- program -----------------------------------------------------------------
  program(ast: E.Program, topNames: string[]): E.Program {
    const body = ast.body as Array<E.Statement | E.Directive>;
    const directives = body.filter((s): s is E.Directive => s.type === "ExpressionStatement" && "directive" in s && typeof s.directive === "string");
    const rest = body.slice(directives.length) as E.Statement[];
    const scope: Scope = { names: topNames, kind: "program", hasThis: false, isGenerator: false };
    return this.withScope(scope, () => {
      const globalsGetter = this.getter();
      const prologue: E.Statement[] = [
        {
          type: "VariableDeclaration",
          kind: "const",
          declarations: [
            {
              type: "VariableDeclarator",
              id: id(FRAME),
              init: rtCall("M", [globalsGetter]),
            },
          ],
        },
      ];
      return { ...ast, body: [...directives, ...prologue, ...this.list(rest)] };
    });
  }

  // -- statements -------------------------------------------------------------
  /** Statements that share a line with their parent header (e.g. `if (c) return x;`) get no extra line event. */
  private readonly sameLine = new WeakSet<E.Statement>();

  private list(stmts: E.Statement[]): E.Statement[] {
    const out: E.Statement[] = [];
    for (const s of stmts) {
      if (needsStatementHook(s) && !this.sameLine.has(s)) out.push(this.hookStmt(s));
      out.push(this.stmt(s));
    }
    return out;
  }

  private asBlock(s: E.Statement, parent?: AnyNode): E.BlockStatement {
    if (s.type === "BlockStatement") return s;
    if (parent && (s as AnyNode).loc?.start.line === parent.loc?.start.line) this.sameLine.add(s);
    return block([s]);
  }

  private blockStmt(b: E.BlockStatement, extraNames: string[] = []): E.BlockStatement {
    const scope: Scope = { names: [...extraNames, ...lexicalNames(b.body)], kind: "block", hasThis: false, isGenerator: false };
    return this.withScope(scope, () => ({ ...b, body: this.list(b.body) }));
  }

  private stmt(s: E.Statement): E.Statement {
    switch (s.type) {
      case "BlockStatement":
        return this.blockStmt(s);
      case "FunctionDeclaration":
        return this.fn(s, s.id?.name ?? "<anonymous>", false) as E.FunctionDeclaration;
      case "ReturnStatement":
        return {
          ...s,
          argument: rtCall("R", [
            id(FRAME),
            lit(lineOf(s, this.lineOffset)),
            lit(colOf(s)),
            this.getter(),
            s.argument ? this.expr(s.argument) : id("undefined"),
          ]),
        };
      case "IfStatement":
        return this.ifStmt(s, false);
      case "ForStatement": {
        const names = s.init && s.init.type === "VariableDeclaration" && s.init.kind !== "var" ? s.init.declarations.flatMap((d) => patternNames(d.id)) : [];
        const scope: Scope = { names, kind: "block", hasThis: false, isGenerator: false };
        return this.withScope(scope, () => {
          const init = s.init ? (s.init.type === "VariableDeclaration" ? this.varDecl(s.init) : this.expr(s.init)) : null;
          const test = s.test ? this.expr(s.test) : null;
          const update = s.update ? this.expr(s.update) : null;
          const header = this.hook(s);
          return {
            ...s,
            init,
            test,
            update: update ? seq([header, update]) : header,
            body: this.blockStmt(this.asBlock(s.body, s)),
          };
        });
      }
      case "WhileStatement":
        return { ...s, test: seq([this.hook(s), this.expr(s.test)]), body: this.blockStmt(this.asBlock(s.body, s)) };
      case "DoWhileStatement": {
        const testNode = s.test as AnyNode;
        return { ...s, body: this.blockStmt(this.asBlock(s.body)), test: seq([this.hook(testNode), this.expr(s.test)]) };
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const names = s.left.type === "VariableDeclaration" && s.left.kind !== "var" ? s.left.declarations.flatMap((d) => patternNames(d.id)) : [];
        const right = this.expr(s.right);
        const scope: Scope = { names, kind: "block", hasThis: false, isGenerator: false };
        return this.withScope(scope, () => {
          const header = this.hookStmt(s);
          const body = this.blockStmt(this.asBlock(s.body, s));
          const left = s.left.type === "VariableDeclaration" ? s.left : (this.expr(s.left as E.Expression) as unknown as E.Pattern);
          return { ...s, left, right, body: { ...body, body: [header, ...body.body] } } as E.ForInStatement | E.ForOfStatement;
        });
      }
      case "SwitchStatement": {
        const disc = this.expr(s.discriminant);
        const names = lexicalNames(s.cases.flatMap((c) => c.consequent));
        const scope: Scope = { names, kind: "block", hasThis: false, isGenerator: false };
        return this.withScope(scope, () => ({
          ...s,
          discriminant: disc,
          cases: s.cases.map((c) => ({ ...c, test: c.test ? this.expr(c.test) : null, consequent: this.list(c.consequent) })),
        }));
      }
      case "TryStatement": {
        const blockOut = this.blockStmt(s.block);
        let handler: E.CatchClause | null = null;
        if (s.handler) {
          const h = s.handler;
          const param = h.param;
          let paramId: E.Pattern = param ?? id("__dr_c");
          const pre: E.Statement[] = [];
          const names = param ? patternNames(param) : [];
          if (param && param.type !== "Identifier") {
            paramId = id("__dr_c");
            pre.push({ type: "VariableDeclaration", kind: "let", declarations: [{ type: "VariableDeclarator", id: param, init: id("__dr_c") }] });
          }
          const caught = exprStmt(rtCall("K", [id(FRAME), id((paramId as E.Identifier).name)]));
          const inner = this.blockStmt(h.body, names);
          handler = { ...h, param: paramId, body: { ...inner, body: [caught, ...pre, ...inner.body] } };
        }
        return { ...s, block: blockOut, handler, finalizer: s.finalizer ? this.blockStmt(s.finalizer) : null };
      }
      case "LabeledStatement":
        return { ...s, body: this.stmt(s.body) };
      case "VariableDeclaration":
        return this.varDecl(s);
      case "ClassDeclaration":
        return this.classNode(s) as E.ClassDeclaration;
      case "ExpressionStatement":
        return { ...s, expression: this.expr(s.expression) };
      case "ThrowStatement":
        return { ...s, argument: this.expr(s.argument) };
      default:
        return this.generic(s) as E.Statement;
    }
  }

  private ifStmt(s: E.IfStatement, isElseIf: boolean): E.IfStatement {
    const test = this.expr(s.test);
    let alternate: E.Statement | null = null;
    if (s.alternate) alternate = s.alternate.type === "IfStatement" ? this.ifStmt(s.alternate, true) : this.blockStmt(this.asBlock(s.alternate));
    return {
      ...s,
      test: isElseIf ? seq([this.hook(s), test]) : test,
      consequent: this.blockStmt(this.asBlock(s.consequent, s)),
      alternate,
    };
  }

  private varDecl(d: E.VariableDeclaration): E.VariableDeclaration {
    return {
      ...d,
      declarations: d.declarations.map((x) => ({
        ...x,
        init: x.init ? this.exprNamed(x.init, x.id.type === "Identifier" ? x.id.name : undefined) : x.init ?? null,
      })),
    };
  }

  // -- functions --------------------------------------------------------------
  private fn(
    f: E.FunctionDeclaration | E.FunctionExpression | E.ArrowFunctionExpression,
    name: string,
    hasThis: boolean,
  ): E.FunctionDeclaration | E.FunctionExpression | E.ArrowFunctionExpression {
    if (f.async) return f; // runs untraced (warning emitted)
    const isArrow = f.type === "ArrowFunctionExpression";
    const paramNames = f.params.flatMap((p) => patternNames(p));
    const bodyBlock: E.BlockStatement =
      f.body.type === "BlockStatement" ? f.body : block([{ type: "ReturnStatement", argument: f.body, loc: (f.body as AnyNode).loc } as E.ReturnStatement]);
    const hoisted = hoistedVars(bodyBlock);
    const thisFlag = !isArrow && hasThis;
    const fnScope: Scope = {
      names: [...paramNames, ...hoisted.filter((n) => !paramNames.includes(n))],
      kind: "function",
      hasThis: thisFlag,
      isGenerator: !!f.generator,
    };
    return this.withScope(fnScope, () => {
      const params = f.params.map((p) => this.generic(p) as E.Pattern);
      const entryGetter = this.getter();
      const directives = bodyBlock.body.filter(
        (s): s is E.Directive => s.type === "ExpressionStatement" && "directive" in s && typeof (s as E.Directive).directive === "string",
      );
      const rest = bodyBlock.body.slice(directives.length) as E.Statement[];
      const lex = lexicalNames(rest);
      const inner = this.withScope({ names: lex, kind: "block", hasThis: false, isGenerator: !!f.generator }, () => this.list(rest));
      const endLine = ((f as AnyNode).loc?.end.line ?? 1) + this.lineOffset;
      const frameDecl: E.VariableDeclaration = {
        type: "VariableDeclaration",
        kind: "const",
        declarations: [
          {
            type: "VariableDeclarator",
            id: id(FRAME),
            init: rtCall("C", [
              lit(name),
              lit(lineOf(f, this.lineOffset)),
              lit(colOf(f)),
              lit(endLine),
              arr(paramNames.map((p) => lit(p))),
              entryGetter,
              lit(!!f.generator),
            ]),
          },
        ],
      };
      const tryStmt: E.TryStatement = {
        type: "TryStatement",
        block: block(inner),
        handler: {
          type: "CatchClause",
          param: id("__dr_e"),
          body: block([exprStmt(rtCall("X", [id(FRAME), id("__dr_e")])), { type: "ThrowStatement", argument: id("__dr_e") }]),
        },
        finalizer: block([exprStmt(rtCall("F", [id(FRAME)]))]),
      };
      const newBody = block([...directives, frameDecl, tryStmt]);
      if (isArrow) return { ...f, params, body: newBody, expression: false } as E.ArrowFunctionExpression;
      return { ...f, params, body: newBody } as E.FunctionDeclaration | E.FunctionExpression;
    });
  }

  private classNode(c: E.ClassDeclaration | E.ClassExpression): E.ClassDeclaration | E.ClassExpression {
    const className = c.id?.name ?? "<class>";
    const body = c.body.body.map((m) => {
      if (m.type === "MethodDefinition") {
        const key = m.key.type === "Identifier" ? m.key.name : m.key.type === "PrivateIdentifier" ? `#${m.key.name}` : "<computed>";
        const name = m.kind === "constructor" ? className : key;
        return { ...m, key: m.computed ? this.expr(m.key as E.Expression) : m.key, value: this.fn(m.value, name, true) as E.FunctionExpression };
      }
      return this.generic(m) as typeof m;
    });
    return {
      ...c,
      superClass: c.superClass ? this.expr(c.superClass) : c.superClass ?? null,
      body: { ...c.body, body },
    } as E.ClassDeclaration | E.ClassExpression;
  }

  // -- expressions ------------------------------------------------------------
  private exprNamed(e: E.Expression, name: string | undefined): E.Expression {
    if (name && (e.type === "FunctionExpression" || e.type === "ArrowFunctionExpression"))
      return this.fn(e, e.type === "FunctionExpression" && e.id ? e.id.name : name, false) as E.Expression;
    if (name && e.type === "ClassExpression" && !e.id) return this.classNode({ ...e, id: id(name) }) as E.Expression;
    return this.expr(e);
  }

  private expr(e: E.Expression): E.Expression {
    switch (e.type) {
      case "FunctionExpression":
        return this.fn(e, e.id?.name ?? "<anonymous>", false) as E.Expression;
      case "ArrowFunctionExpression":
        return this.fn(e, "<arrow>", false) as E.Expression;
      case "ClassExpression":
        return this.classNode(e) as E.Expression;
      case "YieldExpression": {
        const arg = e.argument ? this.expr(e.argument) : id("undefined");
        if (e.delegate || !this.currentFunctionIsGenerator()) return { ...e, argument: arg };
        const suspended = rtCall("YO", [id(FRAME), lit(lineOf(e, this.lineOffset)), lit(colOf(e)), this.getter(), arg]);
        return rtCall("YI", [id(FRAME), { ...e, argument: suspended }]);
      }
      case "AssignmentExpression":
        return {
          ...e,
          left: e.left.type === "Identifier" ? e.left : (this.generic(e.left) as E.Pattern),
          right: this.exprNamed(e.right, e.left.type === "Identifier" ? e.left.name : undefined),
        };
      case "ObjectExpression":
        return {
          ...e,
          properties: e.properties.map((p) => {
            if (p.type === "Property") {
              const keyName = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : undefined;
              const value = p.value as E.Expression;
              if (value.type === "FunctionExpression" || value.type === "ArrowFunctionExpression") {
                return { ...p, key: p.computed ? this.expr(p.key as E.Expression) : p.key, value: this.fn(value, keyName ?? "<method>", value.type === "FunctionExpression") as E.Expression };
              }
              return { ...p, key: p.computed ? this.expr(p.key as E.Expression) : p.key, value: this.expr(value) };
            }
            return { ...p, argument: this.expr(p.argument) };
          }),
        };
      default:
        return this.generic(e) as E.Expression;
    }
  }

  /** Recurse into children of nodes that need no special treatment. */
  private generic(n: E.Node): E.Node {
    const out: Record<string, unknown> = { ...(n as unknown as Record<string, unknown>) };
    for (const key of Object.keys(out)) {
      if (key === "loc" || key === "type" || key === "start" || key === "end") continue;
      const v = out[key];
      if (Array.isArray(v)) out[key] = v.map((x) => (x && typeof x === "object" && typeof (x as E.Node).type === "string" ? this.dispatch(x as E.Node) : x));
      else if (v && typeof v === "object" && typeof (v as E.Node).type === "string") out[key] = this.dispatch(v as E.Node);
    }
    return out as unknown as E.Node;
  }

  private dispatch(n: E.Node): E.Node {
    if (isStatement(n)) return this.stmt(n);
    if (isExpression(n)) return this.expr(n);
    return this.generic(n);
  }
}

const STATEMENT_TYPES = new Set([
  "BlockStatement",
  "ExpressionStatement",
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "ReturnStatement",
  "SwitchStatement",
  "TryStatement",
  "ThrowStatement",
  "LabeledStatement",
  "VariableDeclaration",
  "FunctionDeclaration",
  "ClassDeclaration",
  "BreakStatement",
  "ContinueStatement",
  "EmptyStatement",
  "DebuggerStatement",
]);

function isStatement(n: E.Node): n is E.Statement {
  return STATEMENT_TYPES.has(n.type);
}

function isExpression(n: E.Node): n is E.Expression {
  return /Expression$|^Identifier$|^Literal$|^TemplateLiteral$|^Super$|^MetaProperty$/.test(n.type) && n.type !== "ExpressionStatement";
}

function needsStatementHook(s: E.Statement): boolean {
  switch (s.type) {
    case "FunctionDeclaration":
    case "EmptyStatement":
    case "BlockStatement":
    case "WhileStatement":
      return false;
    case "LabeledStatement":
      return needsStatementHook(s.body);
    default:
      return true;
  }
}

export function instrument(source: string): InstrumentResult {
  const diagnostics: Diagnostic[] = [];
  const parsed = parseJs(source);
  if ("error" in parsed) return { ok: false, code: "", diagnostics: [parsed.error], topLevelNames: [] };
  const ast = parsed.ast;
  checkConstructs(ast, diagnostics);
  if (diagnostics.some((d) => d.severity === "error")) return { ok: false, code: "", diagnostics, topLevelNames: [] };

  const topNames = [...new Set([...hoistedVars(ast), ...lexicalNames(ast.body)])];
  const ins = new Instrumenter(0);
  const program = ins.program(ast, topNames);
  const code = generate(program);
  return { ok: true, code, diagnostics, topLevelNames: topNames.filter((n) => !n.startsWith(RESERVED_PREFIX)) };
}
