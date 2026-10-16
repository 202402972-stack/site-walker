// A5 — SPA (client-routing) verification.
//
// Serves a pure client-routed fixture SPA (history.pushState; there is no
// per-route HTML on the server). It first proves IN-BROWSER that navigation is
// client-side (clicking About changes location.pathname while the server sees
// zero document requests for /about), then runs the REAL discovery + capture
// pipeline against the fixture and fails if late-rendered (800 ms) content or
// per-route content is missing from the captures.
//
// The fixture is on 127.0.0.1, so this harness deliberately does not install
// the SSRF route guard (which is a boundary for untrusted input, exercised
// separately by the API tests). Nothing here runs inside the product.
//
// Usage: npx tsx tools/spa-fixture.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { launchBrowser } from "../server/agent/browser.js";
import { discoverSections } from "../server/agent/discover.js";
import { captureSection } from "../server/agent/capture.js";

declare global {
  interface Window {
    __clientNavs?: number;
  }
}

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture SPA</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; color: #111; background: #fff; }
  header { height: 64px; background: #111; color: #fff; display: flex; align-items: center; padding: 0 24px; }
  nav a { color: #fff; margin-right: 18px; text-decoration: none; font-size: 15px; }
  main { padding: 24px; }
  .hero { height: 420px; background: #e8e8e8; display: flex; align-items: center; justify-content: center; font-size: 32px; }
  .late { height: 860px; background: linear-gradient(#f6f6f6, #d8e6f2); padding: 24px; font-size: 20px; }
  .lazy { height: 420px; background: #fdf3e7; padding: 24px; font-size: 20px;
          opacity: 0; transform: translateY(24px); transition: opacity .4s, transform .4s; }
  .lazy.on { opacity: 1; transform: none; }
</style></head>
<body>
<header><nav>
  <a href="/">Home</a><a href="/about">About</a><a href="/work">Work</a><a href="/contact">Contact</a>
</nav></header>
<main id="app"></main>
<script>
var titles = { "/": "Home", "/about": "About", "/work": "Work", "/contact": "Contact" };
function render() {
  var t = titles[location.pathname] || "Not found";
  document.title = "Fixture SPA — " + t;
  document.getElementById("app").innerHTML =
    '<div class="hero">' + t + ' hero</div>' +
    '<div class="lazy" data-lazy>' + t + ' lazy block</div>';
  setTimeout(function () {
    var d = document.createElement("div");
    d.className = "late";
    d.setAttribute("data-late", "1");
    d.textContent = t + " late-rendered content (800ms)";
    document.getElementById("app").appendChild(d);
    var l = document.querySelector("[data-lazy]");
    if (l) l.classList.add("on");
  }, 800);
}
document.addEventListener("click", function (e) {
  var a = e.target.closest("a[href^='/']");
  if (!a) return;
  e.preventDefault();
  history.pushState({}, "", a.getAttribute("href"));
  window.__clientNavs = (window.__clientNavs || 0) + 1;
  render();
});
window.addEventListener("popstate", render);
render();
</script></body></html>`;

const docs: Record<string, number> = {};
const server = http.createServer((req, res) => {
  const p = (req.url ?? "/").split("?")[0];
  docs[p] = (docs[p] ?? 0) + 1;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE); // SPA fallback: every path is the same document
});

const failures: string[] = [];
function check(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!pass) failures.push(name);
}

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
console.log(`fixture SPA serving on ${base}`);

const browser = await launchBrowser();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // 1) Prove client-side routing: click navigates without a document request.
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.click('a[href="/about"]');
  await page.waitForTimeout(1200);
  const pathname = await page.evaluate(() => location.pathname);
  const navs = await page.evaluate(() => window.__clientNavs ?? 0);
  const lateRendered = await page.evaluate(() => !!document.querySelector("[data-late]"));
  check("client-side navigation reaches /about", pathname === "/about", `location.pathname=${pathname}`);
  check("no full page load on route change", navs === 1 && (docs["/about"] ?? 0) === 0, `__clientNavs=${navs}, server document requests for /about=${docs["/about"] ?? 0}`);
  check("late-rendered route content present", lateRendered, `[data-late] in DOM=${lateRendered}`);

  // 2) Real discovery on a fresh entry load.
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const sections = await discoverSections(page, base + "/");
  console.log(`discovered: ${sections.map((s) => `${s.name}(${s.kind})`).join(", ")}`);
  check("discovers the client-routed pages", sections.length >= 3, `${sections.length} sections`);

  // 3) Real capture for every section; late 860px block must be in-frame.
  const shotsDir = path.join("data", "spa-fixture");
  fs.rmSync(shotsDir, { recursive: true, force: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  let ok = 0;
  for (let i = 0; i < sections.length; i++) {
    const r = await captureSection(ctx, sections[i], i, shotsDir, "desktop", "webp");
    const pass = !r.error && !!r.file && (r.height ?? 0) > 1500 && (r.bytes ?? 0) > 0;
    check(
      `capture ${sections[i].name}`,
      pass,
      r.error ? `${r.code} ${r.error}` : `${r.file} ${r.width}x${r.height} ${Math.round((r.bytes ?? 0) / 1024)}KB`,
    );
    if (pass) ok++;
  }
  check("all fixture captures complete", ok === sections.length, `${ok}/${sections.length}`);

  await ctx.close();
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length === 0 ? "SPA FIXTURE: ALL PASS" : `SPA FIXTURE FAILURES: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
