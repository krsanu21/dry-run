import { describe, expect, it } from "vitest";
import { examplesInSource, parseExamples } from "../../src/trace/examples";

const P = ["nums", "target"];

describe("parseExamples", () => {
  it("reads LeetCode's `name = value` input line", () => {
    expect(parseExamples("nums = [2,7,11,15], target = 9", P)).toEqual({ cases: [{ args: ["[2,7,11,15]", "9"], expected: "" }], problems: [] });
  });

  it("reads a whole example block, including the output", () => {
    const r = parseExamples("Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]\nExplanation: Because nums[0] + nums[1] == 9, we return [0, 1].", P);
    expect(r.cases).toEqual([{ args: ["[2,7,11,15]", "9"], expected: "[0,1]" }]);
    expect(r.problems).toEqual([]);
  });

  it("reads several examples at once", () => {
    const r = parseExamples("Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]\n\nExample 2:\nInput: nums = [3,2,4], target = 6\nOutput: [1,2]", P);
    expect(r.cases.map((c) => c.args)).toEqual([
      ["[2,7,11,15]", "9"],
      ["[3,2,4]", "6"],
    ]);
    expect(r.cases.map((c) => c.expected)).toEqual(["[0,1]", "[1,2]"]);
  });

  it("reads LeetCode's one-value-per-line testcase format and positional values", () => {
    expect(parseExamples("[2,7,11,15]\n9", P).cases[0]?.args).toEqual(["[2,7,11,15]", "9"]);
    expect(parseExamples("[3,3], 6", P).cases[0]?.args).toEqual(["[3,3]", "6"]);
  });

  it("matches names regardless of order and keeps nested commas and strings intact", () => {
    expect(parseExamples('target = 6, nums = [[1,2],[3,4]]', P).cases[0]?.args).toEqual(["[[1,2],[3,4]]", "6"]);
    expect(parseExamples('s = "a, b", t = "c"', ["s", "t"]).cases[0]?.args).toEqual(['"a, b"', '"c"']);
  });

  it("explains values it cannot use", () => {
    const r = parseExamples("nums = [1,2], k = 2", P);
    expect(r.cases[0]?.args).toEqual(["[1,2]", ""]);
    expect(r.problems).toEqual(['found "k = 2" but there is no parameter called k']);
    expect(parseExamples("[1], 2, 3", P).problems[0]).toMatch(/more values than parameters/);
    expect(parseExamples("nums = [1, 2", P).problems[0]).toMatch(/^nums:/);
    expect(parseExamples("   ", P).problems[0]).toMatch(/No values found/);
  });
});

describe("examplesInSource", () => {
  it("finds examples in a docstring or comments, and ignores ordinary code", () => {
    const py = 'class Solution:\n    """\n    Example 1:\n    Input: nums = [2,7,11,15], target = 9\n    Output: [0,1]\n    Example 2:\n    Input: nums = [3,2,4], target = 6\n    Output: [1,2]\n    """\n    def twoSum(self, nums, target):\n        input_ok = nums == target\n        return []\n';
    expect(examplesInSource(py, P).map((c) => c.expected)).toEqual(["[0,1]", "[1,2]"]);
    const js = "// Input: nums = [1,2], target = 3\n// Output: [0,1]\nfunction twoSum(nums, target) {}\n";
    expect(examplesInSource(js, P)).toEqual([{ args: ["[1,2]", "3"], expected: "[0,1]" }]);
    expect(examplesInSource("def f(nums, target):\n    return nums\n", P)).toEqual([]);
  });
});
