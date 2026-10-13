// Dev utility: paste code, fill args, run, step, and screenshot (system Chrome).
// usage: node drive.mjs <name> <width> <dark|light> <code-file> <args-json> <steps> [extra-keys]
import { chromium } from "@playwright/test";
import fs from "node:fs";
const [name, w, theme, codeFile, argsJson, steps, keys = ""] = process.argv.slice(2);
const OUT = "/private/tmp/claude-501/-Users-kumar-Projects-leetcode-dry-run/4c9640b4-033d-4abf-b3f0-6760adb401b2/scratchpad";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: Number(w), height: 900 } });
await page.emulateMedia({ colorScheme: theme });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", async (m) => { if (m.type() === "error") errs.push(m.text() + " :: " + (await Promise.all(m.args().slice(1, 3).map((a) => a.jsonValue().catch(() => "?")))).join(" | ").slice(0, 400)); });
await page.goto("http://localhost:5173/");
await page.evaluate(() => localStorage.clear());
await page.goto("http://localhost:5173/");
await page.locator(".cm-content").click();
await page.keyboard.press("Meta+A");
await page.keyboard.press("Delete");
await page.keyboard.insertText(fs.readFileSync(codeFile, "utf8"));
await page.waitForTimeout(800);
const args = JSON.parse(argsJson);
for (let i = 0; i < args.length; i++) await page.getByTestId(`arg-${i}`).fill(args[i]);
await page.getByTestId("expected").fill("");
const t0 = Date.now();
await page.getByTestId("run").click();
await page.locator(".app[data-run-status=done]").waitFor({ timeout: 90000 });
console.log("run ms", Date.now() - t0, "counter", await page.getByTestId("step-counter").textContent());
await page.locator(".col-center").click({ position: { x: 5, y: 5 } });
const n = Number(steps);
if (n < 0) await page.keyboard.press("End");
else { await page.keyboard.press("Home"); for (let k = 0; k < n; k++) await page.keyboard.press("ArrowRight"); }
for (const k of keys.split(",").filter(Boolean)) await page.keyboard.press(k);
await page.waitForTimeout(Number(process.env.SETTLE ?? 700));
if (process.env.PROBE) console.log("probe", await page.evaluate(process.env.PROBE));
console.log("at", await page.getByTestId("step-counter").textContent());
await page.screenshot({ path: `${OUT}/${name}.png` });
console.log("errors", errs.length, [...new Set(errs)].slice(0, 3));
await browser.close();
