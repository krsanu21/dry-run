import { expect, test } from "@playwright/test";
import { EXAMPLES } from "../src/examples";
import { expectClean, focusCanvas, freshApp, loadExample, runAndWait, setCode, stepCounter, watchPage } from "./helpers";



test("1. paste a complete Python solution, enter arguments, run and inspect", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(
    page,
    "class Solution:\n    def maxProfit(self, prices):\n        best = 0\n        lo = prices[0]\n        for i in range(1, len(prices)):\n            lo = min(lo, prices[i])\n            best = max(best, prices[i] - lo)\n        return best\n",
  );
  await expect(page.getByTestId("entry-select")).toHaveValue("Solution.maxProfit");
  await page.getByTestId("arg-0").fill("[7, 1, 5, 3, 6, 4]");
  await page.getByTestId("expected").fill("5");
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

test("3. fragment mode traces selected lines with an explicit initial state", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(page, "# unrelated\nfor i in range(2, len(nums) + 1):\n    dp[i] = max(dp[i - 1], dp[i - 2] + nums[i - 1])\n");
  await page.getByTestId("mode-fragment").click();
  await page.getByLabel("First line").fill("2");
  await page.getByLabel("Last line").fill("3");
  await page.getByTestId("frag-init").fill('{"nums": [2, 7, 9], "dp": [0, 2, 0, 0]}');
  await runAndWait(page);
  await focusCanvas(page);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("panel-dp")).toContainText("11");
  await expect(page.locator(".frame.is-active")).toContainText("<fragment>");
  expectClean(w);
});

test("4. runtime exception: inspect the state that led to it", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await setCode(page, "def solve(nums):\n    total = 0\n    for i in range(len(nums) + 1):\n        total += nums[i]\n    return total\n");
  await page.getByTestId("arg-0").fill("[1, 2, 3]");
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

test("8. multiple saved test cases: switch, re-run, compare", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "two-sum");
  await page.getByRole("button", { name: "Run all" }).click();
  await expect(page.locator(".app[data-run-status=done]")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("dock-compare").click();
  await expect(page.locator(".cmp-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".cmp-table")).toContainText("[1, 2]");
  await page.getByTestId("dock-input").click();
  await page.getByRole("button", { name: /Example 2/ }).click();
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("result-value")).toHaveText("[1, 2]");
  // add a case, edit it, run it
  await page.getByTestId("dock-input").click();
  await page.getByTestId("add-test").click();
  await page.getByTestId("arg-0").fill("[1, 5, 9]");
  await page.getByTestId("arg-1").fill("14");
  await page.getByTestId("expected").fill("[1, 2]");
  await runAndWait(page);
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("match")).toContainText("match");
  // persisted locally across reloads
  await page.reload();
  await page.getByTestId("dock-input").click();
  await expect(page.locator(".test-chip")).toHaveCount(4);
  expectClean(w);
});

test("9. share and reopen a URL-encoded test case (never auto-runs)", async ({ page, context }) => {
  const w = watchPage(page);
  await freshApp(page);
  await loadExample(page, "house-robber");
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
  await expect(page2.getByTestId("arg-0")).toHaveValue("[1, 2, 3, 1]");
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
    await page.getByTestId("dock-input").click();
  }
  expectClean(w);
});

test("12. infinite loops and long native calls hit limits without freezing the UI", async ({ page }) => {
  const w = watchPage(page);
  await freshApp(page);
  // event budget
  await setCode(page, "i = 0\nwhile True:\n    i += 1\n");
  await page.getByTestId("mode-script").click();
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
  await page.getByTestId("mode-script").click();
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
  await page.getByTestId("side-watch").click();
  await page.getByLabel("Watch expression").fill("target - nums[i]");
  await page.getByLabel("Watch expression").press("Enter");
  await page.getByLabel("Watch expression").fill("missing_name");
  await page.getByLabel("Watch expression").press("Enter");
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
  await page.getByTestId("arg-0").fill("edges = [\n (1, 2),\n (1, 3),\n (2, 4),\n (2, 5),\n (3, 6)\n]");
  await page.getByTestId("expected").fill("{\n 1: [2, 3],\n 2: [1, 4, 5],\n 3: [1, 6],\n 4: [2],\n 5: [2],\n 6: [3]\n}");
  await runAndWait(page);
  await page.getByTestId("dock-output").click();
  await expect(page.getByTestId("match")).toContainText("match");
  await expect(page.getByTestId("match")).not.toContainText("differs");
  expectClean(w);
});
