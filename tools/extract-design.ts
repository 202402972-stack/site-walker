// Phase 0 extractor — plan §10.2. Run BEFORE any UI work:
//   npm run extract-design -- https://join.elevenlabs.io/agents/architect
// Outputs design/tokens-{desktop,tablet,mobile}.json + screenshots to design/ref/.
// Human consolidates into design/tokens.md → web/src/tokens.css. Every UI value must come from a token.
import { chromium } from "playwright";
import fs from "node:fs/promises";

const url = process.argv[2];
if (!url) {
  console.error("Usage: npm run extract-design -- <url>");
  process.exit(1);
}
const sizes = [
  { n: "desktop", w: 1440, h: 900 },
  { n: "tablet", w: 834, h: 1112 },
  { n: "mobile", w: 390, h: 844 },
];
const sels = ["body", "h1", "h2", "h3", "h4", "p", "a", "button", "nav", "header", "footer", "section", "input"];
const props = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "backgroundColor", "backgroundImage", "borderRadius", "border", "boxShadow", "padding", "margin", "maxWidth", "gap", "textTransform", "transition"];

const browser = await chromium.launch();
await fs.mkdir("design/ref", { recursive: true });
for (const s of sizes) {
  const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  try {
    await page.waitForLoadState("load", { timeout: 15000 });
  } catch { /* heavy pages stream forever — proceed with what rendered */ }
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: `design/ref/${s.n}.png`, fullPage: true, animations: "disabled" });
  // NOTE: page.evaluate serializes functions into the browser. The TS bundler
  // injects __name() helpers into compiled closures, which do not exist in
  // the page context. So the extraction body is plain JS passed as a string.
  const extractorSrc = `
    const sels = ${JSON.stringify(sels)};
    const props = ${JSON.stringify(props)};
    const pick = (el) => {
      const cs = getComputedStyle(el);
      const o = {};
      for (const p of props) o[p] = cs[p];
      const r = el.getBoundingClientRect();
      return { text: (el.textContent || "").trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), style: o };
    };
    const out = { elements: {}, fonts: [], vars: {}, media: [], keyframes: [] };
    for (const q of sels) {
      out.elements[q] = [...document.querySelectorAll(q)].slice(0, 6).map(pick);
    }
    out.fonts = [...document.fonts].map((f) => ({ family: f.family, weight: f.weight, style: f.style, status: f.status }));
    for (const sh of [...document.styleSheets]) {
      try {
        for (const r of [...sh.cssRules]) {
          if (r.type === 1 && /^(:root|html)$/.test(r.selectorText || "")) {
            for (const n of [...r.style]) if (n.startsWith("--")) out.vars[n] = r.style.getPropertyValue(n).trim();
          }
          if (r.type === 4) out.media.push(r.conditionText);
          if (r.type === 7) out.keyframes.push(r.cssText);
        }
      } catch (e) { /* cross-origin stylesheet — fetch CSS by URL and parse offline */ }
    }
    return out;
  `;
  const data = await page.evaluate(`(() => { ${extractorSrc} })()`);
  await fs.writeFile(`design/tokens-${s.n}.json`, JSON.stringify(data, null, 2));
  console.log(`wrote design/tokens-${s.n}.json + design/ref/${s.n}.png`);
  await page.close();
}
await browser.close();
console.log("Next: consolidate into design/tokens.md (color/type/spacing/radii/shadows/motion/layout), record font license decision, then generate web/src/tokens.css.");
