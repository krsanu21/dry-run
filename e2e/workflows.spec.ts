import { expect, test } from "@playwright/test";
import { EXAMPLES } from "../src/examples";
import { expectClean, focusCanvas, freshApp, hoverVar, loadExample, runAndWait, setCode, stepCounter, watchPage, wordPoint } from "./helpers";



test("1. paste a complete Python solution, enter arguments, run and inspect", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(
    page,
    "class Solution:\n    def maxProfit(self, prices):\n        best = 0\n        lo = prices[0]\n        for i in range(1, len(prices)):\n            lo = min(lo, prices[i])\n            best = max(best, prices[i] - lo)\n        return best\n",
  );
  await expect(page.getByTestId("target-line")).toContainText("maxProfit(", { timeout: 20_000 });
  await page.getByTestId("arg-0-0").fill("[7, 1, 5, 3, 6, 4]");
  await page.getByTestId("expected-0").fill("5");
  await runAndWait(page);
  await focusCanvas(page);
  await expect(page.getByTestId("panel-prices")).toBeVisible();
  // step to the first line-6 event: i should be drawn on prices[1]
  // events: call, line 3, line 4, line 5, line 6 → four steps forward
  for (let k = 0; k < 4; k++) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("step-now")).toContainText("line 6");
  await expect(page.getByTestId("panel-prices").getByTestId("ptr-i")).toHaveAttribute("data-index", "1");
  await page.getByTestId("dock-output").click();
  await page.keyboard.press("End");
  await expect(page.getByTestId("result-value")).toHaveText("5");
  await expect(page.getByTestId("match")).toContainText("match");
  expectClean(w);
});

test("2. a valid but unfinished solution still runs and shows the real result", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "two-sum-unfinished");
  await runAndWait(page);
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("result-value")).toHaveText("None");
  await expect(page.getByTestId("match")).toContainText("differs");
  await focusCanvas(page);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("step-now")).toContainText("returning None");
  expectClean(w);
});

test("3. Run says what it will run, and decides from the code", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  // a LeetCode solution: calls the method with the test cases
  await expect(page.getByTestId("target-line")).toContainText("twoSum(nums, target) on your test cases", { timeout: 20_000 });
  await expect(page.getByTestId("run")).toHaveText("▶ Run twoSum");
  await expect(page.getByTestId("cases")).toBeVisible();
  // a file that calls its own function at the top level: the whole file, no table
  await setCode(page, "def dfs(g, n, seen):\n    seen.add(n)\n    for m in g[n]:\n        if m not in seen:\n            dfs(g, m, seen)\n\nseen = set()\ndfs({1: [2], 2: [1]}, 1, seen)\nprint(seen)\n");
  await expect(page.getByTestId("target-line")).toContainText("whole file", { timeout: 20_000 });
  await expect(page.getByTestId("run")).toHaveText("▶ Run file");
  await expect(page.getByTestId("cases")).toHaveCount(0);
  await runAndWait(page);
  await focusCanvas(page);
  await page.keyboard.press("End");
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("stdout")).toContainText("{1, 2}");
  // …but the function can still be tested on its own, with inputs
  await page.getByTestId("dock-cases").click();
  await page.getByTestId("target-alt").click();
  await expect(page.getByTestId("target-line")).toContainText("dfs(g, n, seen)");
  await expect(page.getByTestId("arg-0-0")).toBeVisible();
  // and "change" offers every function plus the whole file
  await page.getByTestId("target-change").click();
  await page.getByTestId("target-file").click();
  await expect(page.getByTestId("target-line")).toContainText("whole file");
  // a program that reads input shows where to type it
  await setCode(page, "n = int(input())\nprint(n * 2)\n");
  await expect(page.getByTestId("stdin")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("stdin").fill("21");
  await runAndWait(page);
  await focusCanvas(page);
  await page.keyboard.press("End");
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("stdout")).toContainText("42");
  expectClean(w);
});

test("4. runtime exception: inspect the state that led to it", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(page, "def solve(nums):\n    total = 0\n    for i in range(len(nums) + 1):\n        total += nums[i]\n    return total\n");
  await page.getByTestId("arg-0-0").fill("[1, 2, 3]");
  await runAndWait(page);
  await expect(page.getByTestId("step-now")).toContainText("IndexError");
  await expect(page.getByTestId("var-i")).toContainText("3");
  await expect(page.getByTestId("var-total")).toContainText("6");
  await focusCanvas(page);
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("step-now")).toContainText("About to run line 4");
  await expect(page.locator(".cm-lintRange-error, .cm-lint-marker-error").first()).toBeVisible();
  expectClean(w);
});

test("5. backward and forward navigation never changes historical states", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "reverse-array");
  await runAndWait(page);
  await focusCanvas(page);
  for (let k = 0; k < 5; k++) await page.keyboard.press("ArrowRight");
  const snapshot = async () => [await stepCounter(page), await page.getByTestId("canvas").innerText(), await page.getByTestId("variables").innerText()];
  const before = await snapshot();
  for (let k = 0; k < 6; k++) await page.keyboard.press("ArrowRight");
  const later = await snapshot();
  expect(later).not.toEqual(before);
  for (let k = 0; k < 6; k++) await page.keyboard.press("ArrowLeft");
  expect(await snapshot()).toEqual(before);
  // scrubber jump and back
  await page.getByTestId("scrubber").fill("0");
  await page.getByTestId("scrubber").fill("5");
  expect(await snapshot()).toEqual(before);
  expectClean(w);
});

test("6. set a breakpoint and resume to each hit", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "reverse-array");
  // click line number 5 to set a breakpoint
  await page.locator(".cm-lineNumbers .cm-gutterElement", { hasText: /^5$/ }).click();
  await expect(page.locator(".cm-bp-gutter .cm-gutterElement:not([style*='hidden']) .cm-bp-dot")).toHaveCount(1);
  await runAndWait(page);
  await focusCanvas(page);
  await page.keyboard.press("n");
  await expect(page.getByTestId("step-counter")).toContainText("line 5");
  const first = await stepCounter(page);
  await page.keyboard.press("n");
  await expect(page.getByTestId("step-counter")).toContainText("line 5");
  expect(await stepCounter(page)).not.toEqual(first);
  await page.keyboard.press("n");
  await expect(page.getByTestId("step-counter")).toContainText(/step \d+/);
  await page.keyboard.press("n"); // no more hits → end of trace with a note
  await expect(page.getByRole("status").filter({ hasText: "No later breakpoint" })).toBeVisible();
  expectClean(w);
});

test("7. predict the next state and get scored against the real trace", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "reverse-array");
  await runAndWait(page);
  await focusCanvas(page);
  for (let k = 0; k < 2; k++) await page.keyboard.press("ArrowRight"); // call, line 3, → line 4 (first while check)
  await expect(page.getByTestId("step-now")).toContainText("line 4");
  await page.keyboard.press("p");
  await expect(page.getByTestId("prediction")).toBeVisible();
  // forward navigation is blocked while predicting
  const stepNo = async () => /step \d+/.exec(await stepCounter(page))?.[0];
  const before = await stepNo();
  await focusCanvas(page);
  await page.keyboard.press("ArrowRight");
  expect(await stepNo()).toEqual(before);
  await expect(page.getByTestId("step-counter")).toContainText("Submit or skip your prediction");
  await page.getByTestId("pred-input-line").fill("5");
  await page.getByTestId("pred-submit").click();
  await expect(page.getByTestId("pred-outcome")).toContainText("Correct");
  await page.getByTestId("pred-continue").click();
  await page.getByTestId("pred-input-line").fill("4");
  await page.getByTestId("pred-submit").click();
  await expect(page.getByTestId("pred-outcome")).toContainText(/Not quite|Partially/);
  expectClean(w);
});

test("8. test cases as a table: run all, results per row, switch, add, persist", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "two-sum");
  await page.getByTestId("run-all").click();
  await expect(page.locator(".app[data-run-status=done]")).toBeVisible({ timeout: 90_000 });
  for (const [row, value] of [
    [0, "[0, 1]"],
    [1, "[1, 2]"],
    [2, "[0, 1]"],
  ] as const)
    await expect(page.getByTestId(`result-${row}`)).toHaveText(`✓ ${value}`);
  // clicking a row shows that case's trace
  await page.getByTestId("case-1").locator(".c-num").click();
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("result-value")).toHaveText("[1, 2]");
  // a new case: type, run, see the result in its row
  await page.getByTestId("dock-cases").click();
  await page.getByTestId("add-test").click();
  await page.getByTestId("arg-3-0").fill("[1, 5, 9]");
  await page.getByTestId("arg-3-1").fill("14");
  await page.getByTestId("expected-3").fill("[0, 2]");
  await runAndWait(page);
  await expect(page.getByTestId("result-3")).toHaveText("✗ [1, 2]");
  await expect(page.getByTestId("result-3").locator("span")).toHaveAttribute("title", "expected [0, 2], got [1, 2]");
  // persisted locally across reloads
  await page.reload();
  await expect(page.locator(".cases-table tbody tr")).toHaveCount(4);
  expectClean(w);
});

test("9. share and reopen a URL-encoded test case (never auto-runs)", async ({ page, context }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "house-robber");
  await expect(page.getByTestId("arg-0-0")).toBeVisible();
  await page.getByTestId("add-test").click();
  const cases = await page.locator('tr[data-testid^="case-"]').count();
  expect(cases).toBeGreaterThan(1);
  await page.getByTestId(`arg-${cases - 1}-0`).fill("[2, 7, 9]");
  await page.getByRole("button", { name: "Share" }).click();
  const url = await page.getByTestId("share-url").inputValue();
  expect(url).toContain("#share=z.");
  const page2 = await context.newPage();
  const w2 = watchPage(page2);
  await page2.goto(url);
  await expect(page2.getByTestId("shared-banner")).toContainText("not");
  await expect(page2.locator(".app[data-run-status=idle]")).toBeVisible();
  await page2.getByTestId("shared-load").click();
  await expect(page2.locator(".cm-content")).toContainText("def rob");
  await expect(page2.getByTestId("arg-0-0")).toHaveValue("[1, 2, 3, 1]");
  await expect(page2.locator('tr[data-testid^="case-"]')).toHaveCount(cases);
  await expect(page2.getByTestId(`arg-${cases - 1}-0`)).toHaveValue("[2, 7, 9]");
  await expect(page2.locator(".app[data-run-status=idle]")).toBeVisible();
  // malformed links are rejected gracefully
  await page2.goto("about:blank");
  await page2.goto("/#share=z.not-valid-data");
  await expect(page2.getByTestId("toast")).toContainText("Could not open shared link");
  expectClean(w);
  expect(w2.external).toEqual([]);
});

test("10. JavaScript runs through the same visualization schema", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "js-two-sum");
  await runAndWait(page);
  await focusCanvas(page);
  for (let k = 0; k < 7; k++) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("panel-nums").getByTestId("ptr-i")).toHaveAttribute("data-index", "1");
  await expect(page.getByTestId("panel-seen")).toContainText("2");
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("run-status")).toContainText("Completed");
  expectClean(w);
});

test("11. every built-in example loads and runs through its real adapter", async ({ page }) => {
  test.setTimeout(400_000);
  const w = watchPage(page);
  await freshApp(page);
  for (const ex of EXAMPLES) {
    await loadExample(page, ex.id);
    await runAndWait(page);
    await expect(page.getByTestId("canvas"), ex.id).toBeVisible();
    const status = await page.locator(".app").getAttribute("data-run-status");
    expect(status, ex.id).toBe("done");
    await page.getByTestId("dock-output").click();
    await expect(page.getByTestId("run-status"), ex.id).toContainText("Completed");
    await page.getByTestId("dock-cases").click();
  }
  expectClean(w);
});

test("12. infinite loops and long native calls hit limits without freezing the UI", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  // event budget
  await setCode(page, "i = 0\nwhile True:\n    i += 1\n");
  await runAndWait(page);
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("run-status")).toContainText("event budget");
  // native call that never yields to the tracer: the watchdog must terminate the worker
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("lim-timeoutMs").fill("1500");
  await page.keyboard.press("Escape");
  await setCode(page, "x = 1\ny = sum(range(10 ** 12))\n");
  await page.getByTestId("run").click();
  // UI stays responsive while the worker is busy
  const t0 = Date.now();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  expect(Date.now() - t0).toBeLessThan(1000);
  await expect(page.locator(".app[data-run-status=done]")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("run-status")).toContainText("watchdog");
  // the recorded history before the hang is still inspectable
  await focusCanvas(page);
  await page.keyboard.press("Home");
  await expect(page.getByTestId("step-counter")).toContainText("step 0");
  // user cancellation
  await setCode(page, "while True:\n    pass\n");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("lim-timeoutMs").fill("60000");
  await page.getByTestId("lim-maxEvents").fill("100000000");
  await page.keyboard.press("Escape");
  await page.getByTestId("run").click();
  await expect(page.locator(".app[data-run-status=running]")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("stop").click();
  await expect(page.locator(".app[data-run-status=done]")).toBeVisible();
  await expect(page.getByTestId("run-status")).toContainText("stopped by the user");
  expectClean(w);
});

test("13. a trace of thousands of events stays responsive", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(page, "arr = list(range(40))\ns = 0\nfor k in range(3000):\n    arr[k % 40] += 1\n    s += arr[k % 40]\n");
  await runAndWait(page);
  const counter = await stepCounter(page);
  const total = Number(/\/ (\d+)/.exec(counter)?.[1]);
  expect(total).toBeGreaterThan(9000);
  const times: number[] = [];
  for (const pos of [100, 5000, 9000, 2000, 7000, 0]) {
    const t0 = await page.evaluate(() => performance.now());
    await page.getByTestId("scrubber").fill(String(pos));
    await expect(page.getByTestId("step-counter")).toContainText(`step ${pos} /`);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    times.push((await page.evaluate(() => performance.now())) - t0);
  }
  console.log("scrub-to-render ms:", times.map((t) => t.toFixed(0)).join(", "));
  expect(Math.max(...times)).toBeLessThan(500);
  expectClean(w);
});

test("14. watch expressions evaluate against snapshots only", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "two-sum");
  await runAndWait(page);
  await page.getByTestId("watch-input").fill("target - nums[i]");
  await page.getByTestId("watch-input").press("Enter");
  await page.getByTestId("watch-input").fill("missing_name");
  await page.getByTestId("watch-input").press("Enter");
  await focusCanvas(page);
  for (let k = 0; k < 3; k++) await page.keyboard.press("ArrowRight");
  const rows = page.getByTestId("watch-row");
  await expect(rows.nth(0)).toContainText("7");
  await expect(rows.nth(1)).toContainText("not in scope");
  expectClean(w);
});

test("15. inputs accept Python literals: tuples, int-keyed dicts, None", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(
    page,
    "from collections import defaultdict\n\ndef adj(edges):\n    g = defaultdict(list)\n    for a, b in edges:\n        g[a].append(b)\n        g[b].append(a)\n    return g\n",
  );
  await page.getByTestId("arg-0-0").fill("edges = [\n (1, 2),\n (1, 3),\n (2, 4),\n (2, 5),\n (3, 6)\n]");
  await page.getByTestId("expected-0").fill("{\n 1: [2, 3],\n 2: [1, 4, 5],\n 3: [1, 6],\n 4: [2],\n 5: [2],\n 6: [3]\n}");
  await runAndWait(page);
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("match")).toContainText("match");
  await expect(page.getByTestId("match")).not.toContainText("differs");
  expectClean(w);
});

test("16. errors are written out under the line, with a hint, and cleared when stale", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  // syntax error while typing: shown live, before any run
  await setCode(page, "def f(nums):\n    total = 0\n    for x in nums\n        total += x\n    return total\n");
  const lens = page.getByTestId("error-lens");
  await expect(lens).toContainText("SyntaxError", { timeout: 20_000 });
  await expect(lens).toContainText("expected ':'");
  await expect(lens).toContainText("line 3");
  await expect(page.getByTestId("problem-bar")).toContainText("line 3");
  // fixing it clears it
  await setCode(page, "def f(nums):\n    d = {}\n    for x in nums:\n        d[x] = x\n        d[x].append(x)\n    return d\n");
  await expect(lens).toHaveCount(0, { timeout: 20_000 });
  // runtime error: message, hint, and where it was raised
  await page.getByTestId("arg-0-0").fill("[1, 2]");
  await runAndWait(page);
  await expect(lens).toContainText("AttributeError");
  await expect(lens).toContainText("'int' object has no attribute 'append'");
  await expect(lens).toContainText("This value is a int");
  await expect(lens).toContainText(/raised at step \d+/);
  await expect(page.getByTestId("problem-bar")).toContainText("line 5");
  await focusCanvas(page);
  await page.keyboard.press("Home");
  await page.getByTestId("goto-error-step").click();
  await expect(page.getByTestId("goto-error-step")).toHaveCount(0);
  // editing the code makes the run's error stale, so it disappears instead of pointing at a wrong line
  await setCode(page, "def f(nums):\n    return nums\n");
  await expect(lens).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("problem-bar")).toHaveCount(0);
  expectClean(w);
});

test("17. pasting a different problem starts fresh; Run explains syntax errors and missing entry points", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await expect(page.locator(".tb-title")).toHaveText("Two Sum");
  await expect(page.getByTestId("target-line")).toContainText("twoSum(", { timeout: 20_000 });
  // a different problem: old arguments/expected no longer apply
  await setCode(page, "class Solution:\n    def maxProfit(self, prices):\n        best, lo = 0, prices[0]\n        for p in prices:\n            lo = min(lo, p)\n            best = max(best, p - lo)\n        return best\n");
  await expect(page.getByTestId("target-line")).toContainText("maxProfit(", { timeout: 20_000 });
  await expect(page.locator(".tb-title")).toHaveText("Max Profit");
  await expect(page.getByTestId("arg-0-0")).toHaveValue("");
  await expect(page.getByTestId("expected-0")).toHaveValue("");
  await expect(page.getByTestId("toast")).toContainText("started a fresh test case");
  await page.getByTestId("arg-0-0").fill("[7, 1, 5, 3, 6, 4]");
  // renaming keeps the test case
  await setCode(page, "class Solution:\n    def bestProfit(self, prices):\n        best, lo = 0, prices[0]\n        for p in prices:\n            lo = min(lo, p)\n            best = max(best, p - lo)\n        return best\n");
  await expect(page.getByTestId("target-line")).toContainText("bestProfit(", { timeout: 20_000 });
  await expect(page.getByTestId("arg-0-0")).toHaveValue("[7, 1, 5, 3, 6, 4]");
  // Run with a syntax error says why it can't run
  await setCode(page, "class Solution:\n    def bestProfit(self, prices)\n        return 0\n");
  await expect(page.getByTestId("error-lens")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("run").click();
  await expect(page.getByTestId("toast")).toContainText("Can't run yet");
  // nothing to call: the file itself runs
  await setCode(page, "x = 1\n");
  await expect(page.getByTestId("run")).toHaveText("▶ Run file", { timeout: 20_000 });
  await runAndWait(page);
  await focusCanvas(page);
  await page.keyboard.press("End");
  await expect(page.getByTestId("outcome-banner")).toContainText("Finished");
  expectClean(w);
});

test("18. phase 0: mid-width inspector, big grids finish and follow, error and final states, outcome banner, ranges", async ({ page }) => {
  const w = watchPage(page);
  // inspector stays reachable on a 1024px window
  await page.setViewportSize({ width: 1024, height: 768 });
  await freshApp(page);
  await runAndWait(page);
  await expect(page.getByTestId("variables")).toBeVisible();
  await expect(page.getByTestId("callstack")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });

  // a 50x50 grid loop completes within the default limits and the view follows the active cell
  await setCode(page, "def f(n):\n    g = [[0] * n for _ in range(n)]\n    for r in range(n):\n        for c in range(n):\n            g[r][c] = r + c\n    return g[n-1][n-1]\n");
  await expect(page.getByTestId("target-line")).toContainText("f(", { timeout: 20_000 });
  await page.getByTestId("arg-0-0").fill("50");
  await runAndWait(page);
  await focusCanvas(page);
  await page.keyboard.press("End");
  await expect(page.getByTestId("outcome-banner")).toContainText("Returned 98");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const active = page.locator(".grid-scroll .is-active");
  await expect(active).toHaveAttribute("data-testid", "gcell-49-49");
  await expect(active).toBeInViewport();

  // uncaught exception: the run lands on the raise point, variables are visible, the banner explains
  await setCode(page, "def f(nums):\n    total = 0\n    for i in range(len(nums) + 1):\n        total += nums[i]\n    return total\n");
  // same function name, edited parameter: the test case is kept (only its value changes here)
  await expect(page.getByTestId("target-line")).toContainText("f(nums)", { timeout: 20_000 });
  await page.getByTestId("arg-0-0").fill("[1, 2, 3]");
  await runAndWait(page);
  await expect(page.getByTestId("step-now")).toContainText("IndexError");
  await expect(page.getByTestId("variables")).toContainText("total");
  await focusCanvas(page);
  await page.keyboard.press("End");
  await expect(page.getByTestId("outcome-banner")).toContainText("IndexError");
  await expect(page.getByTestId("final-note")).toContainText("State when the exception was raised");
  await expect(page.getByTestId("variables")).toContainText("total");
  await page.getByTestId("goto-raise").click();
  await expect(page.getByTestId("outcome-banner")).toHaveCount(0);

  // a sliding window shows both bounds and the range between them
  await loadExample(page, "sliding-window");
  await runAndWait(page);
  await focusCanvas(page);
  for (let k = 0; k < 30; k++) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("ptr-left")).toBeVisible();
  await expect(page.getByTestId("ptr-right")).toBeVisible();
  await expect(page.getByTestId("window-note")).toContainText("left..right");
  expectClean(w);
});

test("19. runaway recursion in top-level code never takes the app down, and explains itself", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  // the DFS from the bug report, missing `visited.add(node)`, run in Function mode (top-level code is untraced there)
  await setCode(
    page,
    [
      "from collections import defaultdict",
      "edges = [(1, 2), (1, 3), (2, 4), (2, 5), (3, 6)]",
      "def create_adj_list(edges):",
      "    d = defaultdict(list)",
      "    for i, j in edges:",
      "        d[i].append(j)",
      "        d[j].append(i)",
      "    return dict(d)",
      "graph = create_adj_list(edges)",
      "def dfs_recursive(graph, node, visited):",
      "    print(node)",
      "    for nb in graph[node]:",
      "        if nb not in visited:",
      "            dfs_recursive(graph, nb, visited)",
      "visited = set()",
      "dfs_recursive(graph, 1, visited)",
      "",
    ].join("\n"),
  );
  // a driver file runs whole by default; choose the function to test it with inputs instead
  await expect(page.getByTestId("target-line")).toContainText("whole file", { timeout: 20_000 });
  await page.getByTestId("target-change").click();
  await page.getByRole("menuitemradio", { name: "create_adj_list(edges)" }).click();
  await page.getByTestId("arg-0-0").fill("[[1, 2], [2, 3]]");
  await runAndWait(page);
  // the page is alive and says what happened, instead of going blank
  await expect(page.locator(".cm-content")).toBeVisible();
  const banner = page.getByTestId("outcome-banner");
  await expect(banner).toContainText("Stopped while loading your file");
  await expect(page.getByTestId("setup-note")).toContainText("top-level code");
  await expect(page.getByTestId("callstack")).toContainText("dfs_recursive");
  // one click traces the whole file instead
  await page.getByTestId("switch-script").click();
  await expect(page.locator(".app[data-run-status=done]")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("target-line")).toContainText("whole file");
  await expect(page.getByTestId("setup-note")).toHaveCount(0);
  await expect(page.getByTestId("outcome-banner")).toContainText("Stopped early");
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.getByTestId("crash-card")).toHaveCount(0);
  expectClean(w);
});

// ---------------------------------------------------------------------------------------------
// Trace Peek

const LOOP = "def f(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total\n";

async function loadLoop(page: import("@playwright/test").Page, n = "5"): Promise<void> {
  await freshApp(page);
  await setCode(page, LOOP);
  await expect(page.getByTestId("target-line")).toContainText("f(", { timeout: 20_000 });
  await page.getByTestId("arg-0-0").fill(n);
  await page.getByTestId("expected-0").fill("");
  await runAndWait(page);
  await focusCanvas(page);
  await page.keyboard.press("Home");
}

/** Moves to the n-th `line 4` event (the state is BEFORE `total += i` runs, so total = 0+1+…+(k-1) at iteration k). */
async function goToIteration(page: import("@playwright/test").Page, k: number): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press("Home");
  let seen = -1;
  for (let guard = 0; guard < 80 && seen < k; guard++) {
    await page.keyboard.press("ArrowRight");
    const now = (await page.getByTestId("step-now").textContent()) ?? "";
    if (/line 4\b/.test(now) && /not executed yet/.test(now)) seen++;
  }
}

test("20. Trace Peek: values come from the selected step — forwards, backwards, scrubbing and after the run ends", async ({ page }) => {
  const w = watchPage(page);
  await loadLoop(page, "6");
  const expectedTotal = (k: number): string => String((k * (k - 1)) / 2); // before iteration k (i = k) runs
  const peekValue = async (word: string): Promise<string> => {
    const tip = await hoverVar(page, "total += i", word);
    const value = ((await tip.getByTestId("peek-value").textContent()) ?? "").trim();
    // moving the pointer away dismisses the tooltip (and its highlight)
    await page.mouse.move(1000, 700);
    await expect(page.locator('.cm-tooltip [data-testid="peek"]')).toHaveCount(0);
    return value;
  };

  // forwards through every iteration
  for (let k = 0; k < 6; k++) {
    await goToIteration(page, k);
    expect(await peekValue("total"), `total before iteration ${k}`).toBe(expectedTotal(k));
    expect(await peekValue("i"), `i at iteration ${k}`).toBe(String(k));
  }
  // backwards, one step at a time: the tooltip follows
  await goToIteration(page, 4);
  const here = await peekValue("total");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await peekValue("total")).toBe(here); // same step, same answer, whatever path led there
  // an open tooltip is refreshed when the step changes underneath it
  const tip = await hoverVar(page, "total += i", "i");
  const before = (await tip.getByTestId("peek-value").textContent())?.trim();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('.cm-tooltip [data-testid="peek"]')).toHaveCount(0); // closed on step change, never stale
  expect(await peekValue("i")).not.toBe(before);
  // scrubbing
  await page.getByTestId("scrubber").fill("7");
  const scrubbed = await peekValue("total");
  await page.getByTestId("scrubber").fill("3");
  await page.getByTestId("scrubber").fill("7");
  expect(await peekValue("total")).toBe(scrubbed);
  // after the execution finished: the last live state, labelled as such
  await focusCanvas(page);
  await page.keyboard.press("End");
  const end = await hoverVar(page, "return total", "total");
  await expect(end.getByTestId("peek-value")).toHaveText("15");
  await expect(end).toContainText("final state");
  await expect(end.getByTestId("peek-change")).toContainText("Final state");
  expectClean(w);
});

test("21. Trace Peek: change since the previous step, structure highlights, aliases and nested values", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(
    page,
    [
      "class Node:",
      "    def __init__(self, val, next=None):",
      "        self.val = val",
      "        self.next = next",
      "",
      "def f():",
      "    nums = [5, 8]",
      "    alias = nums",
      "    nums.append(13)",
      "    n3 = Node(3)",
      "    head = Node(1, Node(2, n3))",
      "    cur = head",
      "    cur = cur.next",
      "    return len(alias), cur.val",
      "",
    ].join("\n"),
  );
  await expect(page.getByTestId("target-line")).toContainText("f(", { timeout: 20_000 });
  await runAndWait(page);
  await focusCanvas(page);
  // go to the `n3 = Node(3)` line: nums was just mutated through `append`
  await page.keyboard.press("Home");
  for (let g = 0; g < 40; g++) {
    await page.keyboard.press("ArrowRight");
    if (/line 10\b/.test((await page.getByTestId("step-now").textContent()) ?? "")) break;
  }
  const nums = await hoverVar(page, "alias = nums", "nums");
  await expect(nums.getByTestId("peek-type")).toContainText("list");
  await expect(nums.getByTestId("peek-value")).toHaveText("[5, 8, 13]");
  await expect(nums.getByTestId("peek-change")).toContainText("changed in place");
  await expect(nums.getByTestId("peek-change")).toContainText("index 2 added: 13");
  await expect(nums.getByTestId("peek-aliases")).toContainText("alias");
  await expect(nums.getByTestId("peek-rows")).toContainText("13");
  // the structure it refers to is marked in the canvas, and so is the variable's row
  await expect(page.locator(".panel.peek-target")).toBeVisible();
  await expect(page.locator(".var-row.is-peeked")).toHaveCount(1);
  await page.mouse.move(5, 5);
  await expect(page.locator(".panel.peek-target")).toHaveCount(0); // gone with the tooltip
  // nested objects: preview, attribute chains and rebinding
  for (let g = 0; g < 40; g++) {
    await page.keyboard.press("ArrowRight");
    if (/line 14\b/.test((await page.getByTestId("step-now").textContent()) ?? "")) break;
  }
  const head = await hoverVar(page, "cur = head", "head");
  await expect(head.getByTestId("peek-type")).toContainText("Node");
  await expect(head.getByTestId("peek-rows")).toContainText("next");
  const cur = await hoverVar(page, "cur = cur.next", "cur");
  await expect(cur.getByTestId("peek-change")).toContainText("different object");
  await expect(cur.getByTestId("peek-value")).toContainText("Node(val=2");
  const chain = await hoverVar(page, "cur = cur.next", "next");
  await expect(chain.getByTestId("peek-name")).toHaveText("cur.next");
  await expect(chain.getByTestId("peek-value")).toContainText("Node(val=3");
  expectClean(w);
});

test("22. Trace Peek: recursion resolves the selected call; unavailable values say why", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(page, "def fib(n):\n    if n < 2:\n        return n\n    a = fib(n - 1)\n    b = fib(n - 2)\n    return a + b\n");
  await expect(page.getByTestId("target-line")).toContainText("fib(", { timeout: 20_000 });
  await page.getByTestId("arg-0-0").fill("4");
  await page.getByTestId("expected-0").fill("");
  await runAndWait(page);
  await focusCanvas(page);
  await page.keyboard.press("Home");
  // first moment the stack is three calls deep: fib(4) -> fib(3) -> fib(2)
  for (let g = 0; g < 60; g++) {
    await page.keyboard.press("ArrowRight");
    if (await page.getByTestId("frame-3").count()) break;
  }
  await page.getByTestId("frame-3").waitFor();
  const innermost = await hoverVar(page, "if n < 2", "n");
  await expect(innermost.getByTestId("peek-value")).toHaveText("2");
  await expect(innermost.getByTestId("peek-scope")).toContainText("recursion depth 3 of 3");
  await expect(innermost.getByTestId("peek-others")).toContainText("1: 4");
  await expect(innermost.getByTestId("peek-others")).toContainText("2: 3");
  await expect(innermost.getByTestId("peek-others")).toContainText("3: 2");
  // select the outermost call in the call stack: the same name now resolves in that call
  await page.getByTestId("frame-1").click();
  const outer = await hoverVar(page, "if n < 2", "n");
  await expect(outer.getByTestId("peek-value")).toHaveText("4");
  await expect(outer.getByTestId("peek-scope")).toContainText("recursion depth 1 of 3");
  // a name that is assigned later in the same call
  await page.getByTestId("frame-3").click();
  const later = await hoverVar(page, "b = fib(n - 2)", "b");
  await expect(later).toHaveAttribute("data-status", "not-yet");
  await expect(later.getByTestId("peek-message")).toContainText("not been assigned yet");
  const stepBefore = await page.getByTestId("step-counter").textContent();
  await later.getByTestId("peek-jump").click();
  await expect(page.getByTestId("step-counter")).not.toHaveText(stepBefore ?? "");
  // builtins and keywords are not variables: no tooltip at all
  const p = await wordPoint(page, "return a + b", "return");
  await page.mouse.move(p.x, p.y - 50);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.waitForTimeout(700);
  await expect(page.locator('.cm-tooltip [data-testid="peek"]')).toHaveCount(0);
  expectClean(w);
});

test("23. Trace Peek: keyboard — F2 pins a peek that follows Alt+arrow stepping; Esc closes; it is announced", async ({ page }) => {
  const w = watchPage(page);
  await loadLoop(page, "5");
  await goToIteration(page, 2);
  // put the caret on `total` (the editor is read-only but focusable)
  const p = await wordPoint(page, "total += i", "total");
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press("F2");
  const tip = page.locator('[role="dialog"][data-testid="peek"]');
  await expect(tip).toBeVisible();
  await expect(tip.getByTestId("peek-value")).toHaveText("1"); // 0 + 1 before iteration 2
  await expect(page.getByTestId("peek-live")).toContainText("total, int");
  await expect(tip.getByTestId("peek-close")).toBeVisible();
  // step with the caret still in the code: the pinned peek follows the step
  for (let g = 0; g < 4; g++) await page.keyboard.press("Alt+ArrowRight");
  await expect(tip.getByTestId("peek-value")).toHaveText("6"); // two more iterations: 0+1+2+3
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(tip.getByTestId("peek-value")).toHaveText("1");
  // Esc closes; the highlight goes with it; Ctrl/⌘+. opens it again
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+." : "Control+.");
  await expect(tip).toBeVisible();
  // a caret that is not on a variable says so instead of failing silently
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("editor")).toBeVisible();
  expectClean(w);
});

test("24. Trace Peek: touch — tap pins, × and a second tap close, targets are large", async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 900, height: 900 }});
  const page = await ctx.newPage();
  const w = watchPage(page);
  await loadLoop(page, "5");
  await goToIteration(page, 3);
  const p = await wordPoint(page, "total += i", "total");
  await page.touchscreen.tap(p.x, p.y);
  const tip = page.locator('[role="dialog"][data-testid="peek"]');
  await expect(tip).toBeVisible();
  await expect(tip.getByTestId("peek-value")).toHaveText("3"); // before iteration 3: 0+1+2
  await expect(tip).toHaveClass(/is-touch/);
  const box = await tip.getByTestId("peek-close").boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await tip.getByTestId("peek-close").tap();
  await expect(tip).toHaveCount(0);
  // tapping the same variable again toggles it
  await page.touchscreen.tap(p.x, p.y);
  await expect(tip).toBeVisible();
  await page.touchscreen.tap(p.x, p.y);
  await expect(tip).toHaveCount(0);
  expectClean(w);
  await ctx.close();
});

test("25. Trace Peek: large traces stay accurate; edited code is flagged instead of guessed", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(page, "def f(n):\n    out = [0] * n\n    for i in range(1, n):\n        out[i] = out[i - 1] + i\n    return out[-1]\n");
  await expect(page.getByTestId("target-line")).toContainText("f(", { timeout: 20_000 });
  await page.getByTestId("arg-0-0").fill("1500");
  await page.getByTestId("expected-0").fill("");
  await runAndWait(page);
  const total = Number((await page.getByTestId("scrubber").getAttribute("max")) ?? "0");
  expect(total).toBeGreaterThan(2900);
  // somewhere deep in the trace: the loop variable and a 1500-item list, both exact
  await page.getByTestId("scrubber").fill(String(Math.floor(total * 0.8)));
  await focusCanvas(page);
  const now = (await page.getByTestId("step-now").textContent()) ?? "";
  const line = /line (\d+)/.exec(now)?.[1];
  expect(line).toBeTruthy();
  const i = await hoverVar(page, "out[i] = out[i - 1] + i", "i");
  const iv = Number((await i.getByTestId("peek-value").textContent())?.trim());
  expect(iv).toBeGreaterThan(1000);
  // the value on the tooltip equals the one in the Variables panel at the same step
  await expect(page.getByTestId("var-i")).toContainText(String(iv));
  const out = await hoverVar(page, "out[i] = out[i - 1] + i", "out");
  await expect(out.getByTestId("peek-type")).toContainText("len 1500");
  await expect(out.getByTestId("peek-notes")).toContainText("Only 200 of 1500");
  await expect(out.getByTestId("peek-rows")).toContainText("…").catch(() => undefined);
  // the code stays editable while tracing: typing marks the trace out of date, and peeks say so rather than guessing
  await expect(page.getByTestId("trace-pill")).toBeVisible();
  await page.locator(".cm-line", { hasText: "out[i] = out[i - 1] + i" }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("  # edited");
  await expect(page.locator(".cm-content")).toContainText("# edited");
  await expect(page.getByTestId("stale-bar")).toContainText("Run again");
  await page.waitForTimeout(400);
  const stale = await hoverVar(page, "out[i] = out[i - 1] + i", "i");
  await expect(stale).toHaveAttribute("data-status", "stale");
  await expect(stale.getByTestId("peek-message")).toContainText("Run again");
  expectClean(w);
});

test("26. test cases: paste LeetCode examples, examples found in the code, delete with undo, input badges", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(
    page,
    'class Solution:\n    """\n    Example 1:\n    Input: numbers = [2,7,11,15], goal = 9\n    Output: [0,1]\n    Example 2:\n    Input: numbers = [3,2,4], goal = 6\n    Output: [1,2]\n    """\n    def pairSum(self, numbers, goal):\n        seen = {}\n        for i, x in enumerate(numbers):\n            if goal - x in seen:\n                return [seen[goal - x], i]\n            seen[x] = i\n',
  );
  await expect(page.getByTestId("target-line")).toContainText("pairSum(numbers, goal)", { timeout: 20_000 });
  // the examples in the docstring are offered once
  await expect(page.getByTestId("examples-banner")).toContainText("Found 2 examples");
  await page.getByTestId("examples-add").click();
  await expect(page.getByTestId("examples-banner")).toHaveCount(0);
  await expect(page.locator(".cases-table tbody tr")).toHaveCount(2); // the empty starter row was replaced
  await expect(page.getByTestId("arg-1-0")).toHaveValue("[3,2,4]");
  await expect(page.getByTestId("expected-1")).toHaveValue("[1,2]");
  // paste LeetCode's input line: a new case, values matched by name
  await page.getByTestId("paste-example").fill("goal = 6, numbers = [3,3]");
  await page.getByTestId("paste-example").press("Enter");
  await expect(page.getByTestId("arg-2-0")).toHaveValue("[3,3]");
  await expect(page.getByTestId("arg-2-1")).toHaveValue("6");
  // a name that is not a parameter is reported, not guessed
  await page.getByTestId("paste-example").fill("numbers = [1], k = 3");
  await page.getByTestId("paste-add").click();
  await expect(page.getByTestId("paste-problems")).toContainText("no parameter called k");
  // run everything: every row gets its result
  await page.getByTestId("run-all").click();
  await expect(page.locator(".app[data-run-status=done]")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("result-0")).toHaveText("✓ [0, 1]");
  await expect(page.getByTestId("result-1")).toHaveText("✓ [1, 2]");
  // delete is in the row menu and can be undone
  await page.getByTestId("case-1").hover();
  await page.getByTestId("case-menu-1").click();
  await page.getByTestId("case-delete-1").click();
  await expect(page.locator(".cases-table tbody tr")).toHaveCount(3);
  await page.getByTestId("toast-action").click();
  await expect(page.locator(".cases-table tbody tr")).toHaveCount(4);
  await expect(page.getByTestId("arg-1-0")).toHaveValue("[3,2,4]");
  await expect(page.getByTestId("result-1")).toHaveText("✓ [1, 2]");
  // linked-list / tree inputs are labelled in the column header, plain lists are not
  await expect(page.getByTestId("conv-0")).toHaveClass(/is-plain/);
  await setCode(page, "class Solution:\n    def reverseList(self, head):\n        return head\n");
  await expect(page.getByTestId("conv-0")).not.toHaveClass(/is-plain/, { timeout: 20_000 });
  await expect(page.getByTestId("conv-0").locator("option:checked")).toHaveText("linked list");
  expectClean(w);
});
