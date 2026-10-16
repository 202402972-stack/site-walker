// A11 — axe-core accessibility scan on landing + console gate.
// Usage: BASE=http://localhost:8099 npx tsx tools/axe-check.ts
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const base = process.env.BASE ?? "http://localhost:8099";
const browser = await chromium.launch();
let total = 0;
for (const path of ["/", "/app"]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const results = await new AxeBuilder({ page }).analyze();
  console.log(`${path}: violations=${results.violations.length} passes=${results.passes.length}`);
  for (const v of results.violations) {
    total++;
    console.log(`  [${v.impact}] ${v.id}: ${v.description} nodes=${v.nodes.length}`);
  }
  await ctx.close();
}
await browser.close();
console.log(total === 0 ? "AXE CLEAN" : `AXE VIOLATIONS: ${total}`);
process.exit(total === 0 ? 0 : 1);
