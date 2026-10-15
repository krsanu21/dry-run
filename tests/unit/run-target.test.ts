import { describe, expect, it } from "vitest";
import { analyzeJavaScript } from "../../src/adapters/javascript/analyze";
import { runTarget } from "../../src/ui/actions";
import { normalizeWorkspace, WHOLE_FILE, type Workspace } from "../../src/ui/store";
import { pythonRuntime } from "../helpers";

const ws = (source: string, target = "", language: "python" | "javascript" = "python"): Workspace =>
  normalizeWorkspace({ source, language, target, tests: [{ args: [] }] }) as Workspace;

const py = async (source: string, target = "") => runTarget(ws(source, target), (await pythonRuntime()).analyze(source));
const js = (source: string, target = "") => runTarget(ws(source, target, "javascript"), analyzeJavaScript(source));

describe("what Run runs (Python)", () => {
  it("a Solution method, nothing called at the top level: calls the method", async () => {
    const t = await py("class Solution:\n    def twoSum(self, nums, target):\n        return []\n");
    expect(t).toMatchObject({ kind: "function", entry: "Solution.twoSum", auto: true });
  });

  it("top-level calls, print or input: the whole file, offering the function as an alternative", async () => {
    const dfs = "def dfs(g, n, seen):\n    seen.add(n)\n\ng = {1: [2]}\ndfs(g, 1, set())\n";
    expect(await py(dfs)).toMatchObject({ kind: "file", auto: true, alt: "dfs" });
    expect(await py("def f(x):\n    return x\n\nprint(f(2))\n")).toMatchObject({ kind: "file" });
    expect(await py("n = int(input())\nprint(n * 2)\n")).toMatchObject({ kind: "file" });
    expect(await py("def main():\n    pass\n\nif __name__ == '__main__':\n    main()\n")).toMatchObject({ kind: "file" });
    expect(await py("class S:\n    def go(self):\n        return 1\n\nS().go()\n")).toMatchObject({ kind: "file" });
  });

  it("constants and builtin calls at the top level are setup, not a driver", async () => {
    const t = await py("from collections import defaultdict\nMOD = 10**9 + 7\nmemo = defaultdict(list)\nsquares = [i * i for i in range(10)]\n\ndef f(n):\n    return squares[n] % MOD\n");
    expect(t).toMatchObject({ kind: "function", entry: "f" });
  });

  it("several plain functions and no driver: the last one defined (helpers come first)", async () => {
    expect(await py("def helper(x):\n    return x\n\ndef countComponents(n, edges):\n    return helper(n)\n")).toMatchObject({ kind: "function", entry: "countComponents" });
  });

  it("nothing to call: the whole file", async () => {
    expect(await py("x = 1\ny = x + 1\n")).toMatchObject({ kind: "file" });
  });

  it("an explicit choice wins, and a choice that no longer exists falls back to automatic", async () => {
    const src = "def a(x):\n    return x\n\ndef b(y):\n    return y\n";
    expect(await py(src, "a")).toMatchObject({ kind: "function", entry: "a", auto: false });
    expect(await py(src, WHOLE_FILE)).toMatchObject({ kind: "file", auto: false });
    expect(await py(src, "gone")).toMatchObject({ kind: "function", entry: "b", auto: true });
  });

  it("knows when the program reads input", async () => {
    expect((await pythonRuntime()).analyze("x = input()\n").usesInput).toBe(true);
    expect((await pythonRuntime()).analyze("import sys\nfor line in sys.stdin:\n    pass\n").usesInput).toBe(true);
    expect((await pythonRuntime()).analyze("def f(x):\n    return x\n").usesInput).toBe(false);
  });
});

describe("what Run runs (JavaScript)", () => {
  it("functions only: the last function; a Solution class: its method", () => {
    expect(js("function helper(x) { return x; }\nfunction maxDepth(root) { return helper(root); }\n")).toMatchObject({ kind: "function", entry: "maxDepth" });
    expect(js("class Solution {\n  twoSum(nums, target) { return []; }\n}\n")).toMatchObject({ kind: "function", entry: "Solution.twoSum" });
  });
  it("top-level calls into the program or console.log: the whole file", () => {
    expect(js("function f(x) { return x; }\nconsole.log(f(2));\n")).toMatchObject({ kind: "file", alt: "f" });
    expect(js("function f(x) { return x; }\nconst r = f(3);\n")).toMatchObject({ kind: "file" });
    expect(js("const MOD = 1e9 + 7;\nconst xs = Array.from({ length: 3 }, (_, i) => i);\nfunction f(n) { return xs[n] % MOD; }\n")).toMatchObject({ kind: "function", entry: "f" });
  });
});

describe("stored work from before run targets", () => {
  it("maps the old run mode, entry, names and per-case fields", () => {
    const old = {
      id: "w1",
      title: "Old",
      language: "python",
      source: "x = 1\n",
      mode: "script",
      entry: "",
      tests: [{ id: "t1", name: "Example 1", args: ["[1]"], expected: "1", conversions: ["linked-list"], stdin: "4\n" }],
      activeTestId: "t1",
      breakpoints: [3],
      fragment: { initialState: "{}", setup: "", startLine: 1, endLine: 1 },
      updatedAt: 5,
    };
    const w = normalizeWorkspace(old) as Workspace;
    expect(w).toMatchObject({ target: WHOLE_FILE, conversions: ["linked-list"], stdin: "4\n", breakpoints: [3], activeTestId: "t1" });
    expect(w.tests).toEqual([{ id: "t1", args: ["[1]"], expected: "1" }]);
    expect(Object.keys(w)).not.toContain("fragment");
    expect(normalizeWorkspace({ ...old, mode: "function", entry: "Solution.f" })?.target).toBe("Solution.f");
    expect(normalizeWorkspace({ ...old, mode: "fragment" })?.target).toBe("");
    expect(normalizeWorkspace({ nope: 1 })).toBeNull();
  });
});
