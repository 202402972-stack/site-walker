// Frontend journey check: console gate → login → idle (config-driven form) →
// live run on example.com → progress + gallery + ZIP link → delete → history.
import { chromium } from "playwright";

const base = process.env.BASE ?? "http://localhost:8099";
const token = process.env.SW_TOKEN ?? "m0-test-token";
const failures: string[] = [];
function check(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!pass) failures.push(name);
}

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${base}/app`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(1200);

check("gate renders", await pg.locator("h1").first().textContent().then((t) => t?.includes("sign-in") ?? false), "sign-in heading");
await pg.fill("#token", token);
await pg.click('button[type="submit"]');
await pg.waitForTimeout(1500);

const idleH = await pg.locator("h1").first().textContent();
check("login → idle", idleH?.includes("New run") ?? false, String(idleH));
check("max-sections input present", (await pg.locator("#maxsec").count()) === 1, "maxsec field");
check("max-sections clamped to live config", await pg.locator("#maxsec").getAttribute("max").then((m) => m === "12"), "max=12");

await pg.fill("#url", "https://example.com");
await pg.fill("#maxsec", "1");
await pg.click('button[type="submit"]:has-text("Walk the site")');
await pg.waitForSelector(".progress", { timeout: 15000 });
check("live progress bar appears", true, "progress visible");
await pg.click('button:has-text("Watch later")');
await pg.waitForTimeout(800);
check("watch-later → idle (run continues server-side)", await pg.locator("h1").first().textContent().then((t) => t?.includes("New run") ?? false), "idle again");
check("history lists the running job", (await pg.locator("text=Recent runs on this device").count()) === 1, "history present");
await pg.screenshot({ path: "design/qa/console-idle.png", fullPage: true });
await pg.click('button:has-text("Reopen")');
await pg.waitForSelector('a:has-text("Download ZIP")', { timeout: 120000 });
// Transient network failures reach a proper terminal "failed" state (by design).
// Retry once so the journey test measures the UI, not the network.
let badge0 = await pg.locator(".badge").first().textContent();
if (!(badge0?.includes("Done") ?? false)) {
  console.log(`first attempt ended "${badge0?.trim()}" — retrying once`);
  await pg.click("text=← New run");
  await pg.waitForTimeout(800);
  await pg.fill("#url", "https://example.com");
  await pg.fill("#maxsec", "1");
  await pg.click('button[type="submit"]:has-text("Walk the site")');
  await pg.waitForSelector('a:has-text("Download ZIP")', { timeout: 120000 });
}
check("run finishes with ZIP action", true, "done state");

const shots = await pg.locator(".shot").count();
check("gallery shows the section", shots === 1, `${shots} shot(s)`);
const badge = await pg.locator(".badge").first().textContent();
check("status badge done", badge?.includes("Done") ?? false, String(badge?.trim()));

await pg.locator(".shot-open").first().click();
await pg.waitForTimeout(600);
check("lightbox opens", (await pg.locator(".lightbox").count()) === 1, "dialog visible");
await pg.screenshot({ path: "design/qa/console-live.png" });
await pg.keyboard.press("Escape");
await pg.waitForTimeout(300);
check("lightbox closes on Esc", (await pg.locator(".lightbox").count()) === 0, "closed");

check("ZIP link points at API", await pg.locator('a:has-text("Download ZIP")').getAttribute("href").then((h) => (h?.includes("/download.zip") ?? false) && (h?.startsWith("/api/jobs/") ?? false)), "zip href");
await pg.click('button:has-text("Delete this run")');
await pg.waitForTimeout(800);
check("delete → back to idle", await pg.locator("h1").first().textContent().then((t) => t?.includes("New run") ?? false), "idle again");
await ctx.close();
await b.close();
console.log(failures.length === 0 ? "CONSOLE JOURNEY: ALL PASS" : `FAILURES: ${failflows(failures)}`);
function failflows(f: string[]): string { return f.join(", "); }
process.exit(failures.length === 0 ? 0 : 1);
