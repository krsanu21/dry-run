import { describe, expect, it } from "vitest";
import { expressionAt, inCode } from "../../src/trace/peek";

const at = (line: string, marker: string, lang: "python" | "javascript" = "python") => {
  const col = line.indexOf(marker);
  if (col < 0) throw new Error(`marker ${marker} not in ${line}`);
  return expressionAt(line, col, lang);
};

describe("expressionAt", () => {
  it("finds plain variables anywhere in the word, and at its end", () => {
    expect(at("    total = total + nums[i]", "nums")).toMatchObject({ head: "nums", expr: "nums", from: 20, to: 24 });
    expect(expressionAt("x = left + right", 7, "python")?.head).toBe("left"); // inside the word
    expect(expressionAt("x = left + right", 8, "python")?.head).toBe("left"); // caret right after the word
  });

  it("follows attribute chains up to the hovered attribute", () => {
    const line = "node = node.next.val";
    expect(at(line, "node.next")).toMatchObject({ head: "node", expr: "node" }); // the first `node` after '= '? indexOf finds the first one
    expect(expressionAt(line, line.indexOf("next") + 1, "python")).toMatchObject({ head: "node", expr: "node.next" });
    expect(expressionAt(line, line.indexOf("val") + 1, "python")).toMatchObject({ head: "node", expr: "node.next.val" });
    expect(expressionAt("self.seen[x]", 7, "python")).toMatchObject({ head: "self", expr: "self.seen" });
    expect(expressionAt("a?.b", 3, "javascript")).toMatchObject({ head: "a", expr: "a.b" });
  });

  it("ignores things that are not variables", () => {
    for (const [line, marker] of [
      ["for i in range(3):", "for"],
      ["if x is None:", "None"],
      ["    return 42", "42"],
      ["x = 3.5e2", "e2"],
      ["y = foo().bar", "bar"],
      ["y = a[0].val", "val"],
      ["y = (a + b).c", "c"],
    ] as const)
      expect(at(line, marker), line).toBeNull();
    expect(at("const x = true;", "true", "javascript")).toBeNull();
    expect(at("return this.x", "return", "javascript")).toBeNull();
  });

  it("ignores string text and comments but sees variables inside f-string and template placeholders", () => {
    expect(at('print("total is total")', "total is")).toBeNull();
    expect(at("x = 1  # total here", "total")).toBeNull();
    expect(at("y = 2 // total", "total", "javascript")).toBeNull();
    expect(at('print(f"sum={total} done")', "total")).toMatchObject({ head: "total" });
    expect(at('print(f"sum={total} done")', "done")).toBeNull();
    expect(at('print(f"{{total}}")', "total")).toBeNull(); // escaped braces are text
    expect(at("log(`sum=${total} and total`)", "total}", "javascript")).toMatchObject({ head: "total" });
    expect(at("log(`sum=${total} and total`)", "and total".replace("and ", "") + "`", "javascript")).toBeNull();
    expect(at("s = 'it''s total'", "total")).toBeNull();
    expect(at('s = "a \\" total"', "total")).toBeNull();
    expect(at('s = """a total"""', "total")).toBeNull();
    expect(at('s = "x"; t = total', "total")).toMatchObject({ head: "total" });
  });

  it("inCode agrees at string boundaries", () => {
    const line = 'a = "b" + c';
    expect(inCode(line, line.indexOf("a"), "python")).toBe(true);
    expect(inCode(line, line.indexOf("b"), "python")).toBe(false);
    expect(inCode(line, line.indexOf("c"), "python")).toBe(true);
  });
});
