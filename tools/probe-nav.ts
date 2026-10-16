import { chromium } from "playwright";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("https://join.elevenlabs.io/agents/architect", { waitUntil: "domcontentloaded", timeout: 30000 });
try {
  await p.waitForLoadState("load", { timeout: 15000 });
} catch { /* proceed */ }
await p.waitForTimeout(2500);
const d = await p.evaluate(() => ({
  navCount: document.querySelectorAll("nav, header, [role=navigation]").length,
  headerLinks: document.querySelectorAll("header a[href]").length,
  navLinks: document.querySelectorAll("nav a[href]").length,
  allLinks: document.querySelectorAll("a[href]").length,
  sampleHrefs: [...document.querySelectorAll("a[href]")].slice(0, 12).map((a) => (a as HTMLAnchorElement).href),
  anchorLinks: document.querySelectorAll('a[href^="#"]').length,
  idSections: document.querySelectorAll("main > section[id], section[id]").length,
  h1: (document.querySelector("h1")?.textContent ?? "").slice(0, 80),
  title: document.title.slice(0, 80),
}));
console.log(JSON.stringify(d, null, 2));
try {
  const r = await fetch("https://join.elevenlabs.io/sitemap.xml");
  const t = await r.text();
  console.log("SITEMAP_HEAD:" + t.slice(0, 600));
} catch (e) {
  console.log("SITEMAP_ERR " + (e as Error).message);
}
await b.close();
