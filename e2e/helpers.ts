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
  const edit = page.getByTestId("edit-code");
  if (await edit.isVisible().catch(() => false)) await edit.click();
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
