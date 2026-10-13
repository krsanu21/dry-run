import { describe, expect, it } from "vitest";
import { parseLiteral, toJson } from "../../src/trace/literal";

const j = (s: string): unknown => JSON.parse(toJson(s) ?? "null");

describe("parseLiteral", () => {
  it("passes plain JSON through unchanged in meaning", () => {
    expect(j("[1, 2, [3, null], {\"a\": true}]")).toEqual([1, 2, [3, null], { a: true }]);
    expect(j('"hi"')).toBe("hi");
    expect(j("-3.5e2")).toBe(-350);
  });

  it("converts tuples, including the edge-list from the bug report", () => {
    expect(j("[\n (1, 2),\n (1, 3),\n (2, 4),\n (2, 5),\n (3, 6)\n]")).toEqual([[1, 2], [1, 3], [2, 4], [2, 5], [3, 6]]);
    expect(j("(1,)")).toEqual([1]);
    expect(j("()")).toEqual([]);
    expect(j("(5)")).toBe(5);
  });

  it("converts int-keyed dicts to string keys", () => {
    expect(j("{1: [2, 3], 2: [1, 4, 5],\n 6: [3]\n}")).toEqual({ "1": [2, 3], "2": [1, 4, 5], "6": [3] });
    expect(j("{'a': 1, \"b\": 2,}")).toEqual({ a: 1, b: 2 });
    expect(j("{a: 1}")).toEqual({ a: 1 });
    expect(j("{}")).toEqual({});
  });

  it("converts sets to arrays", () => {
    expect(j("{1, 2, 3}")).toEqual([1, 2, 3]);
    expect(j("{(1, 2), (3, 4)}")).toEqual([[1, 2], [3, 4]]);
  });

  it("maps Python and JS keywords", () => {
    expect(j("[True, False, None, undefined, true, null]")).toEqual([true, false, null, null, true, null]);
  });

  it("handles single quotes, escapes and trailing commas", () => {
    expect(j("['a\\'b', \"c\\nd\",]")).toEqual(["a'b", "c\nd"]);
  });

  it("drops a leading assignment and a trailing semicolon", () => {
    expect(j("edges = [(1, 2)]")).toEqual([[1, 2]]);
    expect(j("const nums = [1, 2];")).toEqual([1, 2]);
    expect(j("graph: dict = {1: [2]}")).toEqual({ "1": [2] });
  });

  it("ignores comments", () => {
    expect(j("[1, # one\n 2 // two\n]")).toEqual([1, 2]);
  });

  it("keeps big integers exact", () => {
    expect(toJson("[12345678901234567890]")).toBe("[12345678901234567890]");
  });

  it("reports readable errors with a position", () => {
    const r = parseLiteral("[1, 2");
    expect(r.ok).toBe(false);
    const v = parseLiteral("[foo(1)]");
    expect(v.ok ? "" : v.error).toMatch(/foo/);
    expect(parseLiteral("[1] x").ok).toBe(false);
    expect(parseLiteral("").ok).toBe(false);
    expect(parseLiteral('"abc').ok).toBe(false);
    expect(parseLiteral("{[1]: 2}").ok).toBe(false);
  });
});
