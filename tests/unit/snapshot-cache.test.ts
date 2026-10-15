import { describe, expect, it } from "vitest";
import { EXAMPLES } from "../../src/examples";
import type { TraceEvent } from "../../src/trace/schema";
import { exampleRequest, tracePython, type Req } from "../helpers";

/**
 * The Python tracer skips re-encoding containers and frames whose contents are
 * the same objects as at the previous event. These tests trace each program
 * twice — with the caches and with full re-encoding on every event — and require
 * every reconstructed event to be identical.
 */

function state(ev: TraceEvent): unknown {
  return { type: ev.type, loc: ev.loc, stack: ev.stack, globals: ev.globals, heap: ev.heap, rv: ev.returnValue, result: ev.result, exc: ev.exception };
}

async function expectSameAsUncached(req: Req): Promise<number> {
  const cached = await tracePython(req);
  const full = await tracePython({ ...req, debugNoCache: true } as Req);
  expect(cached.trace.length).toBe(full.trace.length);
  for (let i = 0; i < full.trace.length; i++) {
    const a = JSON.stringify(state(cached.trace.events[i] as TraceEvent));
    const b = JSON.stringify(state(full.trace.events[i] as TraceEvent));
    if (a !== b) expect.fail(`event ${i} differs\ncached: ${a.slice(0, 600)}\nfull:   ${b.slice(0, 600)}`);
  }
  return full.trace.length;
}

const fn = (source: string, args: string[], entry = "f"): Req => ({ source, mode: "function", entry, args });

describe("Python tracer caches match full re-encoding", () => {
  it("mutating an inner row while the outer grid is unchanged", async () => {
    await expectSameAsUncached(fn("def f(n):\n    g = [[0] * n for _ in range(n)]\n    for r in range(n):\n        for c in range(n):\n            g[r][c] = r * c\n    return g\n", ["4"]));
  });

  it("swapping rows, aliasing a row, and replacing a row with an equal copy", async () => {
    await expectSameAsUncached(
      fn("def f():\n    g = [[1, 2], [3, 4], [5, 6]]\n    g[0], g[1] = g[1], g[0]\n    g[2] = g[0]\n    g[2].append(9)\n    g[1] = list(g[1])\n    g[1][0] = 7\n    return g\n", []),
    );
  });

  it("int and bool values that compare equal but are different objects", async () => {
    await expectSameAsUncached(fn("def f():\n    a = [1, 1.0, True]\n    a[0] = True\n    a[1] = 1\n    a[2] = 1.0\n    big = [10**20]\n    big[0] = 10**20 + 1\n    big[0] -= 1\n    return a, big\n", []));
  });

  it("a callee mutates an object owned by a suspended caller", async () => {
    await expectSameAsUncached(fn("def push(st, x):\n    st.append(x)\n    st.append(x * 2)\n\ndef f(n):\n    st = []\n    for i in range(n):\n        push(st, i)\n    return st\n", ["3"]));
  });

  it("an inner function rebinds a suspended outer frame's variable with nonlocal", async () => {
    await expectSameAsUncached(
      fn("def f(n):\n    count = 0\n    best = []\n    def go(k):\n        nonlocal count, best\n        count += 1\n        best = best + [k]\n        if k > 0:\n            go(k - 1)\n            count += 10\n    go(n)\n    return count, best\n", ["4"]),
    );
  });

  it("deep recursion with a memo dict that grows past the item limit", async () => {
    await expectSameAsUncached({
      ...fn("def f(n):\n    memo = {}\n    def go(k):\n        if k < 2:\n            return k\n        if k in memo:\n            return memo[k]\n        memo[k] = go(k - 1) + go(k - 2)\n        return memo[k]\n    return go(n)\n", ["40"]),
      limits: { maxItems: 10 } as never,
    });
  });

  it("dict values change at the same key; keys are deleted and re-added", async () => {
    await expectSameAsUncached(fn("def f():\n    d = {'a': [1], 'b': 2}\n    d['a'] = [1]\n    d['b'] += 1\n    del d['a']\n    d['a'] = 5\n    d.pop('b')\n    return d\n", []));
  });

  it("a list grows past and shrinks below the item limit, and the object budget is hit", async () => {
    await expectSameAsUncached({
      ...fn("def f():\n    a = []\n    for i in range(8):\n        a.append([i])\n    while a:\n        a.pop()\n    return a\n", []),
      limits: { maxItems: 5, maxObjects: 6 } as never,
    });
  });

  it("generators, exceptions and class instances", async () => {
    await expectSameAsUncached(
      fn(
        "class Node:\n    def __init__(self, v):\n        self.v = v\n        self.kids = []\n\ndef gen(n):\n    for i in range(n):\n        yield [i]\n\ndef f():\n    root = Node(0)\n    for x in gen(3):\n        root.kids.append(Node(x))\n    try:\n        root.kids[9]\n    except IndexError:\n        root.v = -1\n    return root\n",
        [],
      ),
    );
  });

  for (const ex of EXAMPLES.filter((e) => e.language === "python"))
    it(`example: ${ex.id}`, async () => {
      const n = await expectSameAsUncached(exampleRequest(ex));
      expect(n).toBeGreaterThan(0);
    });
});
