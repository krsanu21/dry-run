// Dev utility: load an example, step N times, hover a word in the code, screenshot the Trace Peek tooltip.
// usage: node scripts/peek-shot.mjs <example-id> <steps> "<line text>" <word> <out-name> [dark|light] [width]
import { chromium } from "@playwright/test";
const [id, steps, lineText, word, name, theme = "dark", width = "1440"] = process.argv.slice(2);
const OUT = process.env.OUT ?? ".";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 } });
await page.emulateMedia({ colorScheme: theme });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200)));
await page.goto(process.env.APP_URL || "http://localhost:5173/");
await page.evaluate(() => localStorage.clear());
await page.goto(process.env.APP_URL || "http://localhost:5173/");
await page.getByTestId("open-examples").click();
await page.getByTestId(`example-${id}`).click();
await page.getByTestId("run").click();
await page.locator(".app[data-run-status=done]").waitFor({ timeout: 60000 });
await page.locator(".col-center").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Home");
for (let k = 0; k < Number(steps); k++) await page.keyboard.press("ArrowRight");
const box = await page.evaluate(([lineText, word]) => {
  const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes(lineText));
  if (!line) return null;
  const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const re = new RegExp(`(?<![\\w$])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const m = re.exec(n.textContent);
    if (m) { const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + word.length); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
  }
  return null;
}, [lineText, word]);
if (!box) { console.log("word not found"); process.exit(1); }
await page.mouse.move(box.x, box.y);
await page.waitForSelector(".peek", { timeout: 4000 }).catch(() => console.log("NO TOOLTIP"));
await page.waitForTimeout(250);
if (process.env.DEBUG_PEEK) console.log("dbg:", JSON.stringify(await page.evaluate(() => { const t = document.querySelector(".cm-tooltip"); const p = document.querySelector(".peek"); const cs = getComputedStyle(t); return { tipStyle: t.getAttribute("style"), tipH: t.getBoundingClientRect().height, peekH: p.getBoundingClientRect().height, peekScroll: p.scrollHeight, peekMax: getComputedStyle(p).maxHeight, tipMax: cs.maxHeight, tipOverflow: cs.overflow, tipDisplay: cs.display, peekAttr: p.getAttribute("style"), anc: (() => { const out = []; for (let e = p.parentElement; e && out.length < 3; e = e.parentElement) out.push(e.className.slice(0, 30) + " h=" + Math.round(e.getBoundingClientRect().height) + " mh=" + getComputedStyle(e).maxHeight + " oy=" + getComputedStyle(e).overflowY); return out; })(), vh: innerHeight, rules: [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } }).filter((r) => r.selectorText && p.matches(r.selectorText) && /max-height/.test(r.cssText)).map((r) => r.cssText.slice(0, 600)), parentClass: t.parentElement?.className, edTop: document.querySelector(".cm-editor").getBoundingClientRect().top, scrollTop: document.querySelector(".cm-scroller").getBoundingClientRect().top }; })));
console.log("tooltip:", (await page.locator(".peek").first().innerText().catch(() => "none")).replace(/\n+/g, " | "));
await page.screenshot({ path: `${OUT}/${name}.png` });
console.log("errors:", errs);
await browser.close();
