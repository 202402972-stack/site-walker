// M1 CLI — discovery + capture without UI. Usage:
//   npm run agent:run -- --url https://example.com --viewport desktop --format webp
// Writes DATA_DIR/jobs/<id>/{job.json, shots/*}. Survives restarts (A9).
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config, PRODUCT_NAME } from "../server/config.js";
import { validateEntryUrl, shouldBlockRequestUrl } from "../server/ssrf.js";
import { launchBrowser, getMemoryMB, isOverGuard } from "../server/agent/browser.js";
import { discoverSections } from "../server/agent/discover.js";
import { captureSection } from "../server/agent/capture.js";
import { writeJob, logEvent, type Job } from "../server/jobs/store.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function main(): Promise<void> {
  const rawUrl = arg("url");
  if (!rawUrl) {
    console.error(`[${PRODUCT_NAME}] --url is required`);
    process.exit(1);
  }
  const viewport = (arg("viewport", config.DEFAULT_VIEWPORT) as "desktop" | "mobile");
  const format = (arg("format", config.DEFAULT_FORMAT) as "webp" | "png");
  const maxSections = Number(arg("maxSections", String(config.MAX_SECTIONS)));

  console.log(`[${PRODUCT_NAME}] validating ${rawUrl}`);
  const check = await validateEntryUrl(rawUrl);
  if (!check.ok) {
    console.error(`[${check.code}] ${check.message}`);
    process.exit(2);
  }
  const entryUrl = check.url.toString();

  const id = crypto.randomUUID();
  const job: Job = {
    id,
    url: entryUrl,
    settings: { maxSections, viewport, format },
    status: "queued",
    steps: [],
    sections: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  logEvent(job, "job.queued", entryUrl);
  await writeJob(job);

  const deadline = Date.now() + config.MAX_JOB_SECONDS * 1000;
  const browser = await launchBrowser();
  logEvent(job, "browser.opened", `playwright chromium`);
  job.status = "running";
  await writeJob(job);

  let peak = 0;
  const trackMem = async () => {
    const mb = await getMemoryMB();
    if (mb > peak) { peak = mb; job.peakMemoryMB = mb; }
    return mb;
  };

  try {
    const ctx = await browser.newContext({
      viewport: viewport === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    // SSRF guard on every Chromium request + redirect hop.
    await ctx.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      if (shouldBlockRequestUrl(reqUrl)) return route.abort("blockedbyclient");
      return route.continue();
    });

    const probe = await ctx.newPage();
    logEvent(job, "job.started", entryUrl);
    await probe.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: config.NAV_WAIT_MS });
    try {
      await probe.waitForLoadState("load", { timeout: 15000 });
    } catch { /* heavy pages stream forever — proceed with what rendered */ }
    await probe.waitForTimeout(2500);
    const { discoverSections: discover } = await import("../server/agent/discover.js");
    const sections = (await discover(probe, entryUrl)).slice(0, maxSections);
    logEvent(job, "sections.discovered", `${sections.length}: ${sections.map((s) => s.name).join(" | ")}`);
    await probe.close().catch(() => {});
    await writeJob(job);

    const shotsDir = path.join(config.DATA_DIR, "jobs", id, "shots");
    await fs.mkdir(shotsDir, { recursive: true });

    let ok = 0;
    for (let i = 0; i < sections.length; i++) {
      if (Date.now() > deadline) {
        logEvent(job, "job.timeout", `MAX_JOB_SECONDS=${config.MAX_JOB_SECONDS} reached`);
        break;
      }
      const s = sections[i];
      logEvent(job, "section.started", `${i + 1}/${sections.length} ${s.name} ${s.url}`);
      console.log(`[${i + 1}/${sections.length}] ${s.name} → ${s.url}${s.anchorId ? "#" + s.anchorId : ""}`);

      const mb = await trackMem();
      if (isOverGuard(mb)) {
        logEvent(job, "section.failed", `${s.name} OOM_GUARD at ${mb}MB — fresh context`);
        job.sections.push({ name: s.name, url: s.url, kind: s.kind, error: `Memory guard tripped at ${mb}MB`, code: "OOM_GUARD" });
        await ctx.close().catch(() => {});
        continue;
      }

      const r = await captureSection(ctx, s, i, shotsDir, viewport, format);
      if (r.error) {
        logEvent(job, "section.failed", `${s.name}: ${r.code} ${r.error}`);
        console.warn(`  ✗ ${r.code}: ${r.error}`);
      } else {
        if (r.elementError) logEvent(job, "section.element-skipped", `${s.name}: ${r.elementError}`);
        logEvent(job, "section.captured", `${s.name} ${r.file} ${r.width}x${r.height} ${Math.round(r.bytes / 1024)}KB${r.truncated ? " TRUNCATED" : ""}${r.elementCapture ? " +element" : ""}`);
        console.log(`  ✓ ${r.file} ${r.width}x${r.height} ${Math.round(r.bytes / 1024)}KB${r.truncated ? " (truncated)" : ""}${r.elementCapture ? " + " + r.elementCapture : ""}${r.elementError ? " (element skipped: " + r.elementError + ")" : ""}`);
        ok++;
      }
      job.sections.push({ name: s.name, url: s.url, kind: s.kind, file: r.file, width: r.width, height: r.height, bytes: r.bytes, truncated: r.truncated, elementCapture: r.elementCapture, error: r.elementError ? `element capture skipped: ${r.elementError}` : r.error, code: r.code });
      await writeJob(job);
      await trackMem();
    }

    await ctx.close().catch(() => {});
    job.status = ok === 0 ? "failed" : ok < sections.length ? "partial" : "done";
    logEvent(job, "job.done", `${ok}/${sections.length} captured, peak ${peak}MB`);
    await writeJob(job);
    console.log(`\n[${PRODUCT_NAME}] ${job.status}: ${ok}/${sections.length} sections → ${path.join(config.DATA_DIR, "jobs", id)}`);
    console.log(`job.json + shots/ written. Peak container memory: ${peak < 0 ? "n/a (non-Linux)" : peak + "MB"}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
