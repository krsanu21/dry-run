import { describe, expect, it } from "vitest";
import { errorHint } from "../../src/ui/errorHints";

describe("errorHint", () => {
  it("explains common Python runtime errors using the actual types from the message", () => {
    expect(errorHint("AttributeError", "'int' object has no attribute 'append'", "python")).toMatch(/int.*\.append/);
    expect(errorHint("AttributeError", "'NoneType' object has no attribute 'next'", "python")).toMatch(/None/);
    expect(errorHint("IndexError", "list index out of range", "python")).toMatch(/len/);
    expect(errorHint("KeyError", "5", "python")).toMatch(/get/);
    expect(errorHint("TypeError", "unhashable type: 'list'", "python")).toMatch(/tuple/);
    expect(errorHint("RecursionError", "maximum recursion depth exceeded", "python")).toMatch(/base case/);
    expect(errorHint("UnboundLocalError", "cannot access local variable 'x'", "python")).toMatch(/local/);
  });

  it("explains syntax and indentation errors", () => {
    expect(errorHint("IndentationError", "expected an indented block after 'for' statement on line 3", "python")).toMatch(/indentation/);
    expect(errorHint("SyntaxError", "invalid syntax", "python")).toMatch(/before/);
  });

  it("explains common JavaScript errors", () => {
    expect(errorHint("TypeError", "Cannot read properties of undefined (reading 'next')", "javascript")).toMatch(/undefined/);
    expect(errorHint("ReferenceError", "foo is not defined", "javascript")).toMatch(/declared/);
    expect(errorHint("RangeError", "Maximum call stack size exceeded", "javascript")).toMatch(/base case/);
  });

  it("returns null when it has nothing useful to add", () => {
    expect(errorHint("SyntaxError", "expected ':'", "python")).toBeNull();
    expect(errorHint("MyCustomError", "boom", "python")).toBeNull();
    expect(errorHint("KeyError", "5", "javascript")).toBeNull();
  });
});
