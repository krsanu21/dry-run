import type * as E from "estree";
import { EMPTY_ANALYSIS, type FunctionInfo, type IndexAccess, type SourceAnalysis } from "../../analysis/types";
import { parseJs, patternNames } from "./instrument";

type N = E.Node & { start: number; end: number; loc: E.SourceLocation };

function walk(node: unknown, fn: (n: N, parent: N | null) => void, parent: N | null = null): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, fn, parent);
    return;
  }
  const n = node as N;
  if (typeof n.type !== "string") return;
  fn(n, parent);
  for (const k of Object.keys(n)) {
    if (k === "loc") continue;
    walk((n as unknown as Record<string, unknown>)[k], fn, n);
  }
}

function identifiers(node: E.Node): string[] {
  const out = new Set<string>();
  walk(node, (n, p) => {
    if (n.type === "Identifier" && !(p && p.type === "MemberExpression" && !p.computed && p.property === n)) out.add(n.name);
  });
  return [...out].sort();
}

/** Static facts about a JavaScript program, using the same acorn parser as the tracer. */
export function analyzeJavaScript(source: string): SourceAnalysis {
  const parsed = parseJs(source);
  if ("error" in parsed) return { ...EMPTY_ANALYSIS, ok: false, diagnostics: [parsed.error] };
  const ast = parsed.ast;
  const functions: FunctionInfo[] = [];
  const classes: SourceAnalysis["classes"] = [];
  const slice = (n: E.Node): string => source.slice((n as N).start, (n as N).end);

  const fnInfo = (name: string, f: E.Function, at: N, className?: string): FunctionInfo => ({
    name,
    qualname: className ? `${className}.${name}` : name,
    params: f.params.flatMap((p) => patternNames(p)).map((n) => ({ name: n })),
    line: at.loc.start.line,
    endLine: at.loc.end.line,
    ...(className ? { className } : {}),
  });

  for (const stmt of ast.body) {
    const s = stmt as N;
    if (stmt.type === "FunctionDeclaration" && stmt.id) functions.push(fnInfo(stmt.id.name, stmt, s));
    else if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations) {
        if (d.id.type === "Identifier" && d.init && (d.init.type === "FunctionExpression" || d.init.type === "ArrowFunctionExpression"))
          functions.push(fnInfo(d.id.name, d.init, s));
      }
    } else if (stmt.type === "ClassDeclaration" && stmt.id) {
      const cname = stmt.id.name;
      const methods: string[] = [];
      const attrs = new Set<string>();
      for (const m of stmt.body.body) {
        if (m.type === "MethodDefinition" && m.key.type === "Identifier") {
          methods.push(m.key.name);
          if (m.kind === "method" && !m.static) functions.push(fnInfo(m.key.name, m.value, m as unknown as N, cname));
        }
      }
      walk(stmt, (n) => {
        if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression" && n.left.object.type === "ThisExpression" && n.left.property.type === "Identifier")
          attrs.add(n.left.property.name);
      });
      classes.push({ name: cname, line: s.loc.start.line, endLine: s.loc.end.line, methods, attrs: [...attrs].sort() });
    }
  }
  // nested functions (for range lookups only)
  walk(ast, (n) => {
    if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") && !functions.some((f) => f.line === n.loc.start.line)) {
      const name = n.type !== "ArrowFunctionExpression" && n.id ? n.id.name : "<anonymous>";
      functions.push({ ...fnInfo(name, n, n), qualname: `<nested>.${name}` });
    }
  });

  // Maximal computed-member chains: grid[r][c] → base grid, indices [r, c]
  const accesses: IndexAccess[] = [];
  const writeTargets = new Set<E.Node>();
  walk(ast, (n) => {
    if (n.type === "AssignmentExpression") writeTargets.add(n.left);
    if (n.type === "UpdateExpression") writeTargets.add(n.argument);
  });
  walk(ast, (n, parent) => {
    if (n.type !== "MemberExpression" || !n.computed) return;
    if (parent && parent.type === "MemberExpression" && parent.computed && parent.object === n) return;
    const idx: E.Expression[] = [];
    let cur: E.Expression | E.Super = n;
    while (cur.type === "MemberExpression" && cur.computed) {
      idx.push(cur.property as E.Expression);
      cur = cur.object;
    }
    idx.reverse();
    const write = writeTargets.has(n);
    const access: IndexAccess = {
      line: n.loc.start.line,
      base: slice(cur),
      indices: idx.map(slice),
      indexNames: idx.map(identifiers),
      write,
      kind: "subscript",
    };
    accesses.push(access);
    // compound assignment / update also read the cell
    if (write && parent && ((parent.type === "AssignmentExpression" && parent.operator !== "=") || parent.type === "UpdateExpression"))
      accesses.push({ ...access, write: false });
  });

  // Counters: names updated with ++/--/+=/-=.
  const counters = new Set<string>();
  walk(ast, (n) => {
    if (n.type === "UpdateExpression" && n.argument.type === "Identifier") counters.add(n.argument.name);
    if (n.type === "AssignmentExpression" && (n.operator === "+=" || n.operator === "-=") && n.left.type === "Identifier") counters.add(n.left.name);
  });
  // Loop-structure evidence: `i < xs.length`, `i <= xs.length - 1`, `xs.forEach((x, i) => …)`.
  walk(ast, (n) => {
    if (n.type === "BinaryExpression" && ["<", "<=", ">", ">=", "!==", "!=", "===", "=="].includes(n.operator)) {
      const sides = [n.left, n.right];
      const names = sides.filter((x): x is E.Identifier => x.type === "Identifier" && counters.has(x.name)).map((x) => x.name);
      for (const side of sides) {
        walk(side, (m) => {
          if (m.type === "MemberExpression" && !m.computed && m.property.type === "Identifier" && m.property.name === "length" && m.object.type !== "Super")
            for (const nm of names) accesses.push({ line: n.loc.start.line, base: slice(m.object), indices: [nm], indexNames: [[nm]], write: false, kind: "loop" });
        });
      }
    }
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.property.type === "Identifier" && ["forEach", "map", "filter", "reduce"].includes(n.callee.property.name)) {
      const cb = n.arguments[0];
      if (cb && (cb.type === "ArrowFunctionExpression" || cb.type === "FunctionExpression")) {
        const idxParam = cb.params[n.callee.property.name === "reduce" ? 2 : 1];
        if (idxParam && idxParam.type === "Identifier" && n.callee.object.type !== "Super")
          accesses.push({ line: n.loc.start.line, base: slice(n.callee.object), indices: [idxParam.name], indexNames: [[idxParam.name]], write: false, kind: "loop" });
      }
    }
  });

  const sizeNames = new Set<string>();
  walk(ast, (n) => {
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init && n.init.type === "MemberExpression" && !n.init.computed && n.init.property.type === "Identifier" && n.init.property.name === "length")
      sizeNames.add(n.id.name);
  });

  const sol = classes.find((c) => c.name === "Solution");
  const entryCandidates = sol
    ? functions.filter((f) => f.className === "Solution" && !f.name.startsWith("_")).map((f) => f.qualname)
    : functions.filter((f) => !f.className && !f.qualname.startsWith("<nested>") && !["ListNode", "TreeNode"].includes(f.name)).map((f) => f.qualname);
  const topLevelCode = ast.body.some(
    (s) =>
      s.type !== "FunctionDeclaration" &&
      s.type !== "ClassDeclaration" &&
      !(s.type === "VariableDeclaration" && s.declarations.every((d) => d.init && (d.init.type === "FunctionExpression" || d.init.type === "ArrowFunctionExpression"))) &&
      !(s.type === "ExpressionStatement" && s.expression.type === "Literal"),
  );
  return {
    ok: true,
    diagnostics: [],
    functions,
    classes,
    accesses,
    heapBases: [],
    sizeNames: [...sizeNames].sort(),
    entryCandidates,
    scriptLike: entryCandidates.length === 0 || (topLevelCode && !sol),
  };
}
