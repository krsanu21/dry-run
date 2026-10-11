// Dev utility: drive the running app with Playwright (system Chrome) and save screenshots.
// usage: node scripts/shot.mjs <url> <outdir> [width] [height] [actions-json]
import { chromium } from "@playwright/test";
const [url = "http://localhost:5173/", out = "shots", w = "1440", h = "900", actions = "[]"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const logs = [];
const external = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("request", (r) => { const u = new URL(r.url()); if (!["localhost", "127.0.0.1"].includes(u.hostname) && !u.protocol.startsWith("data") && !u.protocol.startsWith("blob")) external.push(r.url()); });
await page.goto(url);
let i = 0;
for (const a of JSON.parse(actions)) {
  if (a.dark) await page.emulateMedia({ colorScheme: "dark" });
  if (a.click) await page.click(a.click, { timeout: 20000 });
  if (a.press) for (let k = 0; k < (a.times ?? 1); k++) await page.keyboard.press(a.press);
  if (a.wait) await page.waitForSelector(a.wait, { timeout: 60000 });
  if (a.sleep) await page.waitForTimeout(a.sleep);
  if (a.fill) await page.fill(a.fill[0], a.fill[1]);
  if (a.eval) console.log("eval:", await page.evaluate(a.eval));
  if (a.shot) await page.screenshot({ path: `${out}/${a.shot}.png`, fullPage: false });
  i++;
}
console.log(logs.join("\n"));
console.log("external requests:", external.length ? external : "none");
await browser.close();
