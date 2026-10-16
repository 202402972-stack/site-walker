// A13 — visual QA: landing + console gate at 1440/834/390, overflow check,
// stressed state (mobile + 200-char URL prefilled via query? console idle).
// Usage: BASE=http://localhost:8099 npx tsx tools/visual-qa.ts
import { chromium } from "playwright";
import fs from "node:fs";

const base = process.env.BASE ?? "http://localhost:8099";
const out = "design/qa";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const defects: string[] = [];

for (const [page_, w, h] of [
  ["/", 1440, 900],
  ["/", 834, 1112],
  ["/", 390, 844],
  ["/app", 1440, 900],
  ["/app", 390, 844],
] as const) {
  const tag = `${page_ === "/" ? "landing" : "console"}-${w}`;
  const pg = await browser.newPage({ viewport: { width: w, height: h } });
  await pg.goto(base + page_, { waitUntil: "domcontentloaded", timeout: 30000 });
  await pg.waitForTimeout(2000);
  // Scroll pass so reveal-on-scroll sections reach their visible state before capture.
  // Instant behavior: the page uses smooth scrolling for anchor links, which would
  // make a timed scroll pass stall before reaching the lower sections.
  await pg.evaluate(async () => {
    document.documentElement.style.scrollBehavior = "auto";
    const h = document.body.scrollHeight;
    const step = 600;
    for (let y = 0; y < h; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 500));
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) defects.push(`${tag}: horizontal overflow ${overflow}px`);
  await pg.screenshot({ path: `${out}/${tag}.png`, fullPage: true, animations: "disabled" });
  console.log(`${tag}: overflow=${overflow}px`);
  await pg.close();
}
await browser.close();
console.log(defects.length === 0 ? "QA CLEAN — no overflow" : `DEFECTS:\n${defects.join("\n")}`);
