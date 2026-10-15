import { expect, type Page } from "@playwright/test";

export interface Watch {
  errors: string[];
  external: string[];
}

/** Records console errors, page errors and any request that leaves localhost. */
export function watchPage(page: Page): Watch {
  const w: Watch = { errors: [], external: [] };
  page.on("console", (m) => {
    if (m.type() === "error") w.errors.push(m.text());
  });
  page.on("pageerror", (e) => w.errors.push(`pageerror: ${e.message}`));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol === "data:" || u.protocol === "blob:") return;
    if (!["localhost", "127.0.0.1"].includes(u.hostname)) w.external.push(r.url());
  });
  return w;
}

export async function freshApp(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("run")).toBeVisible();
}

export async function loadExample(page: Page, id: string): Promise<void> {
  await page.getByTestId("open-examples").click();
  await page.getByTestId(`example-${id}`).click();
}

export async function setCode(page: Page, code: string): Promise<void> {
  await page.locator(".cm-content").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(code);
}

export async function runAndWait(page: Page): Promise<void> {
  await page.getByTestId("run").click();
  await expect(page.locator(".app[data-run-status=done]")).toBeVisible({ timeout: 90_000 });
}

export async function focusCanvas(page: Page): Promise<void> {
  // move focus off inputs so global shortcuts apply
  await page.locator(".col-center").click({ position: { x: 5, y: 5 } });
}

export async function stepCounter(page: Page): Promise<string> {
  return (await page.getByTestId("step-counter").textContent()) ?? "";
}

export function expectClean(w: Watch): void {
  expect(w.external, "no network requests may leave the machine").toEqual([]);
  expect(w.errors.filter((e) => !/Download the React DevTools/.test(e)), "no console errors").toEqual([]);
}

/** Centre of `word` on the first code line containing `lineText` (page coordinates), for hovering / tapping. */
export async function wordPoint(page: Page, lineText: string, word: string): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(
    ([lineText, word]) => {
      const line = [...document.querySelectorAll(".cm-line")].find((l) => (l.textContent ?? "").includes(lineText as string));
      if (!line) return null;
      const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const re = new RegExp(`(?<![\\w$])${(word as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const m = re.exec(n.textContent ?? "");
        if (m) {
          const r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + (word as string).length);
          const b = r.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }
      }
      return null;
    },
    [lineText, word],
  );
  if (!p) throw new Error(`"${word}" not found on a line containing "${lineText}"`);
  return p;
}

/** Hovers a variable in the editor and returns the Trace Peek tooltip. */
export async function hoverVar(page: Page, lineText: string, word: string): Promise<ReturnType<Page["locator"]>> {
  const p = await wordPoint(page, lineText, word);
  // move away first so that hovering the same word again re-opens the tooltip
  await page.mouse.move(p.x, p.y - 60);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  const tip = page.locator('.cm-tooltip [data-testid="peek"]').first();
  await expect(tip).toBeVisible({ timeout: 5000 });
  return tip;
}
