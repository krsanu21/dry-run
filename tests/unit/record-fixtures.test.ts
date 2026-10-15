import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeJavaScript } from "../../src/adapters/javascript/analyze";
import { EXAMPLES } from "../../src/examples";
import type { Language, RunMode } from "../../src/trace/schema";
import { validateTrace } from "../../src/trace/validate";
import { pythonRuntime, traceLang } from "../helpers";

/**
 * Records real traces (wire events + static analysis) as JSON fixtures for
 * visualizer component tests, so rendering is tested independently of the
 * runtimes. Run with `npm run fixtures` (sets RECORD_FIXTURES=1).
 */
const RECORD = process.env.RECORD_FIXTURES === "1";
const dir = join(__dirname, "..", "fixtures");

interface Spec {
  name: string;
  language: Language;
  source: string;
  mode: RunMode;
  entry?: string;
  args?: string[];
  conversions?: Array<"raw" | "linked-list" | "binary-tree">;
  limits?: Record<string, number>;
}

const fromExample = (id: string): Spec => {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) throw new Error(id);
  return { name: id, language: ex.language, source: ex.source, mode: ex.entry ? "function" : "script", entry: ex.entry, args: ex.tests[0]?.args, conversions: ex.conversions as Spec["conversions"] };
};

const SPECS: Spec[] = [
  ...["two-sum", "reverse-array", "grid-bfs", "lcs", "kth-largest", "reverse-linked-list", "inorder-traversal", "dfs-components", "house-robber", "sliding-window", "js-two-sum", "merge-intervals"].map(fromExample),
  { name: "aliasing", language: "python", mode: "script", source: "a = [1, 2]\nb = a\na[0] = 99\nnodes = [a, a]\n" },
  {
    name: "cycle-list",
    language: "python",
    mode: "script",
    source: "class ListNode:\n    def __init__(self, val):\n        self.val = val\n        self.next = None\na = ListNode(1)\nb = ListNode(2)\na.next = b\nb.next = a\ndone = True\n",
  },
  { name: "truncation", language: "python", mode: "script", source: "big = list(range(500))\nnest = [[[[[[1]]]]]]\nok = 1\n", limits: { maxItems: 40, maxDepth: 3 } },
  { name: "deque-ops", language: "python", mode: "script", source: "from collections import deque\nq = deque([1, 2, 3])\nq.popleft()\nq.append(4)\nseen = {1, 2}\nseen.add(3)\nseen.discard(1)\nd = {'a': 1}\nd['b'] = 2\ndel d['a']\nx = 0\n" },
];

describe.skipIf(!RECORD)("record fixtures", () => {
  it("writes fixtures", async () => {
    mkdirSync(dir, { recursive: true });
    const rt = await pythonRuntime();
    for (const s of SPECS) {
      const { trace, wire, summary } = await traceLang(s.language, {
        source: s.source,
        mode: s.mode,
        entry: s.entry,
        args: s.args,
        argConversions: s.conversions,
        ...(s.limits ? { limits: s.limits as never } : {}),
      });
      expect(validateTrace(trace)).toEqual([]);
      const analysis = s.language === "python" ? rt.analyze(s.source) : analyzeJavaScript(s.source);
      writeFileSync(join(dir, `${s.name}.json`), JSON.stringify({ name: s.name, language: s.language, mode: s.mode, source: s.source, entry: s.entry, analysis, summary, wire }));
    }
  });
});
