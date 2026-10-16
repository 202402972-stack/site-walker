// Wait + capture strategy — plan §7.3.
import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import sharp from "sharp";
import { config } from "../config.js";
import type { Section } from "./discover.js";

export interface CaptureResult {
  section: Section;
  file: string; // basename under shots/
  width: number;
  height: number;
  bytes: number;
  truncated: boolean;
  elementCapture?: string;
  elementError?: string;
  error?: string;
  code?: string;
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

export async function waitForReady(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("load", { timeout: config.NAV_WAIT_MS });
  } catch { /* continue — networkidle cap below is authoritative */ }
  try {
    await page.waitForLoadState("networkidle", { timeout: config.NAV_WAIT_MS });
  } catch { /* cap reached — proceed with what rendered */ }
  try {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
  } catch { /* fonts best-effort */ }
  // DOM quiet for 500ms
  try {
    await page.evaluate(() => new Promise<void>((resolve) => {
      let last = document.documentElement.innerHTML.length;
      let quiet = 0;
      const t = setInterval(() => {
        const cur = document.documentElement.innerHTML.length;
        if (cur === last) { quiet += 100; } else { quiet = 0; last = cur; }
        if (quiet >= 500) { clearInterval(t); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(t); resolve(); }, 4000);
    }));
  } catch { /* proceed */ }
}

export async function triggerLazy(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    const step = 600;
    for (let y = 0; y < h; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });
  // wait for images to complete
  try {
    await page.evaluate(() => Promise.all(
      [...document.images].map((img) => img.complete ? undefined : new Promise((r) => {
        img.addEventListener("load", () => r(undefined), { once: true });
        img.addEventListener("error", () => r(undefined), { once: true });
        setTimeout(() => r(undefined), 3000);
      }))
    ));
  } catch { /* proceed */ }
}

// Force-reveal pass for scroll-triggered content (A4).
// IntersectionObserver reveals often leave opacity:0 inline styles behind when
// the screenshot disables animations. This stylesheet only lifts elements that
// hide themselves via inline opacity, runs during capture, and is logged.
export async function forceReveal(page: Page): Promise<boolean> {
  try {
    await page.addStyleTag({
      content: '[style*="opacity: 0"],[style*="opacity:0"]{opacity:1 !important;transform:none !important;}',
    });
  } catch {
    return false;
  }
  // Second slow pass so observers fire with reveals unlocked, then settle.
  // Ends with a viewport-stop pass: each screen of the page gets ~350ms of
  // visible frames so JS count-ups/carousels run to their end state.
  try {
    await page.evaluate(async () => {
      const h = document.body.scrollHeight;
      for (let y = 0; y < h; y += 800) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 90));
      }
      const vh = window.innerHeight || 900;
      const stops = Math.min(Math.ceil(h / vh), 15);
      for (let i = 0; i < stops; i++) {
        window.scrollTo(0, i * vh);
        await new Promise((r) => setTimeout(r, 350));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2500); // let count-ups/carousels finish after reveal
  } catch { /* proceed */ }
  return true;
}

export async function settleNetwork(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: 3000 });
  } catch { /* streaming pages never idle — proceed */ }
}

export async function measureScrollHeight(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
  ));
}

async function validateImage(buf: Buffer): Promise<{ width: number; height: number; blank: boolean }> {
  const meta = await sharp(buf).metadata();
  const stats = await sharp(buf).stats();
  const channels = stats.channels ?? [];
  // blank if every channel is flat (min == max) — single-color capture
  const blank = channels.length > 0 && channels.every((c) => c.min === c.max);
  return { width: meta.width ?? 0, height: meta.height ?? 0, blank };
}

// CSS.escape is a browser API — the server runs in Node. Minimal escaper for #id selectors.
function cssEscapeId(id: string): string {
  return id.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "section";
}

export async function captureSection(
  ctx: BrowserContext,
  section: Section,
  index: number,
  shotsDir: string,
  viewport: keyof typeof VIEWPORTS,
  format: "webp" | "png",
): Promise<CaptureResult> {
  const vp = VIEWPORTS[viewport];
  const page = await ctx.newPage();
  await page.setViewportSize(vp);
  const base = `${String(index).padStart(2, "0")}-${slug(section.name)}`;
  const file = `${base}.${format === "png" ? "png" : "webp"}`;
  try {
    const target = section.anchorId
      ? section.url.split("#")[0] + "#" + section.anchorId
      : section.url;
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: config.NAV_WAIT_MS });
    await waitForReady(page);
    await triggerLazy(page);
    await settleNetwork(page);
    const revealed = await forceReveal(page);
    const scrollH = await measureScrollHeight(page);
    const truncated = scrollH > config.MAX_PAGE_HEIGHT;

    let buf: Buffer;
    if (!truncated) {
      const raw = await page.screenshot({ fullPage: true, animations: "disabled", type: format === "png" ? "png" : "webp", quality: format === "png" ? undefined : 82 });
      buf = Buffer.from(raw);
    } else {
      // Tile + stitch for pages taller than MAX_PAGE_HEIGHT / texture limit.
      buf = await captureTiled(page, vp, config.MAX_PAGE_HEIGHT, format);
    }

    const { width, height, blank } = await validateImage(buf);
    if (buf.length === 0 || width === 0 || blank) {
      await page.close().catch(() => {});
      return { section, file, width, height, bytes: buf.length, truncated, error: "Blank capture — page rendered no pixel variance.", code: "SECTION_FAILED" };
    }

    await fs.writeFile(path.join(shotsDir, file), buf);

    // Element-level capture for anchors on one-pagers (§7.3.6).
    let elementCapture: string | undefined;
    let elementError: string | undefined;
    if (section.anchorId) {
      try {
        const el = page.locator(`#${cssEscapeId(section.anchorId)}`).first();
        if ((await el.count()) === 0) {
          elementError = `target #${section.anchorId} not found at capture time`;
        } else {
          const box = await el.boundingBox().catch(() => null);
          if (!box || box.height < 50) {
            elementError = `target #${section.anchorId} has no usable box (${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "null"})`;
          } else {
            const elFile = `${base}-element.${format === "png" ? "png" : "webp"}`;
            const raw = await el.screenshot({ animations: "disabled", type: format === "png" ? "png" : "webp", quality: format === "png" ? undefined : 82 });
            await fs.writeFile(path.join(shotsDir, elFile), raw);
            elementCapture = elFile;
          }
        }
      } catch (e) {
        elementError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
    }

    await page.close().catch(() => {});
    return { section, file, width, height, bytes: buf.length, truncated, elementCapture, elementError };
  } catch (e) {
    await page.close().catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    const code = /timeout/i.test(msg) ? "NAV_TIMEOUT" : "SECTION_FAILED";
    return { section, file, width: 0, height: 0, bytes: 0, truncated: false, error: msg.slice(0, 300), code };
  }
}

async function captureTiled(
  page: Page,
  vp: { width: number; height: number },
  maxH: number,
  format: "webp" | "png",
): Promise<Buffer> {
  const tiles: Buffer[] = [];
  let y = 0;
  while (y < maxH) {
    const h = Math.min(vp.height, maxH - y);
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(250);
    const raw = await page.screenshot({
      animations: "disabled",
      clip: { x: 0, y, width: vp.width, height: h },
      type: format === "png" ? "png" : "webp",
      quality: format === "png" ? undefined : 82,
    });
    tiles.push(Buffer.from(raw));
    y += h;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  // Stitch vertically with sharp.
  const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
  const totalH = metas.reduce((a, m) => a + (m.height ?? 0), 0);
  const width = metas[0]?.width ?? vp.width;
  const composites = [];
  let top = 0;
  for (const t of tiles) {
    composites.push({ input: t, top, left: 0 });
    const m = await sharp(t).metadata();
    top += m.height ?? 0;
  }
  const base = sharp({ create: { width, height: totalH, channels: 3, background: "#ffffff" } });
  const out = format === "png"
    ? await base.composite(composites).png().toBuffer()
    : await base.composite(composites).webp({ quality: 82 }).toBuffer();
  return out;
}
