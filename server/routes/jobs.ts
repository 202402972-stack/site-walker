// Job HTTP handlers — plan §8. Thin handlers; heavy work in agent/*.
import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { z } from "zod";
import { config } from "../config.js";
import { verifySession } from "../auth.js";
import { validateEntryUrl, shouldBlockRequestUrl } from "../ssrf.js";
import { launchBrowser, getMemoryMB, isOverGuard } from "../agent/browser.js";
import { discoverSections } from "../agent/discover.js";
import { captureSection } from "../agent/capture.js";
import { writeJob, readJob, logEvent, jobDir, type Job } from "../jobs/store.js";
import { enqueue, isBusy, hourlyAllowed, recordEnqueue } from "../jobs/queue.js";

const CreateBody = z.object({
  url: z.string().min(1).max(2048),
  maxSections: z.number().int().min(1).max(12).optional(),
  viewport: z.enum(["desktop", "mobile"]).optional(),
  format: z.enum(["webp", "png"]).optional(),
});

function authed(req: FastifyRequest): boolean {
  const cookie = (req.cookies as Record<string, string> | undefined)?.["sw_session"];
  return verifySession(cookie);
}

async function runJob(id: string): Promise<void> {
  const job = await readJob(id);
  if (!job) return;
  job.status = "running";
  logEvent(job, "job.started", job.url);
  await writeJob(job);
  const deadline = Date.now() + config.MAX_JOB_SECONDS * 1000;
  const browser = await launchBrowser();
  logEvent(job, "browser.opened", "playwright chromium");
  await writeJob(job);
  let peak = 0;
  try {
    const ctx = await browser.newContext({
      viewport: job.settings.viewport === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await ctx.route("**/*", async (route) => {
      if (shouldBlockRequestUrl(route.request().url())) return route.abort("blockedbyclient");
      return route.continue();
    });
    const probe = await ctx.newPage();
    await probe.goto(job.url, { waitUntil: "domcontentloaded", timeout: config.NAV_WAIT_MS });
    try {
      await probe.waitForLoadState("load", { timeout: 15000 });
    } catch { /* heavy pages stream forever — proceed with what rendered */ }
    await probe.waitForTimeout(2500);
    const sections = (await discoverSections(probe, job.url)).slice(0, job.settings.maxSections);
    logEvent(job, "sections.discovered", `${sections.length}: ${sections.map((s) => s.name).join(" | ")}`);
    await probe.close().catch(() => {});
    await writeJob(job);

    const shotsDir = path.join(jobDir(id), "shots");
    await fs.mkdir(shotsDir, { recursive: true });
    let ok = 0;
    let diskBytes = 0;
    for (let i = 0; i < sections.length; i++) {
      if (Date.now() > deadline) { logEvent(job, "job.timeout", `MAX_JOB_SECONDS=${config.MAX_JOB_SECONDS}`); break; }
      const s = sections[i];
      logEvent(job, "section.started", `${i + 1}/${sections.length} ${s.name}`);
      const mb = await getMemoryMB();
      if (mb > peak) { peak = mb; job.peakMemoryMB = mb; }
      if (isOverGuard(mb)) {
        logEvent(job, "section.failed", `${s.name} OOM_GUARD at ${mb}MB`);
        job.sections.push({ name: s.name, url: s.url, kind: s.kind, error: `Memory guard at ${mb}MB`, code: "OOM_GUARD" });
        continue;
      }
      const r = await captureSection(ctx, s, i, shotsDir, job.settings.viewport, job.settings.format);
      diskBytes += r.bytes;
      if (diskBytes > config.MAX_JOB_BYTES) {
        logEvent(job, "section.failed", `${s.name} JOB_DISK_CAP`);
        job.sections.push({ name: s.name, url: s.url, kind: s.kind, error: "Per-job disk cap reached", code: "SECTION_FAILED" });
        break;
      }
      if (r.error) logEvent(job, "section.failed", `${s.name}: ${r.code} ${r.error}`);
      else {
        if (r.elementError) logEvent(job, "section.element-skipped", `${s.name}: ${r.elementError}`);
        logEvent(job, "section.captured", `${s.name} ${r.file} ${r.width}x${r.height}${r.elementCapture ? " +element" : ""}`);
        ok++;
      }
      job.sections.push({ name: s.name, url: s.url, kind: s.kind, file: r.file, width: r.width, height: r.height, bytes: r.bytes, truncated: r.truncated, elementCapture: r.elementCapture, error: r.elementError ? `element capture skipped: ${r.elementError}` : r.error, code: r.code });
      await writeJob(job);
    }
    await ctx.close().catch(() => {});
    job.status = ok === 0 ? "failed" : ok < sections.length ? "partial" : "done";
    logEvent(job, "job.done", `${ok}/${sections.length} captured, peak ${peak}MB`);
    await writeJob(job);
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/jobs", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Login required." } });
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "URL_INVALID", message: parsed.error.issues[0]?.message ?? "Invalid body." } });
    const session = (req.cookies as Record<string, string>)["sw_session"] ?? "anon";
    if (!hourlyAllowed(session)) return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "10 jobs/hour per session." } });
    if (isBusy()) return reply.code(429).send({ error: { code: "BUSY", message: "One job at a time. Try again shortly." } });
    const check = await validateEntryUrl(parsed.data.url);
    if (!check.ok) return reply.code(check.code === "URL_INVALID" ? 400 : 403).send({ error: { code: check.code, message: check.message } });
    const id = crypto.randomUUID();
    const job: Job = {
      id,
      url: check.url.toString(),
      settings: {
        maxSections: Math.min(parsed.data.maxSections ?? config.MAX_SECTIONS, config.MAX_SECTIONS),
        viewport: parsed.data.viewport ?? config.DEFAULT_VIEWPORT,
        format: parsed.data.format ?? config.DEFAULT_FORMAT,
      },
      status: "queued",
      steps: [],
      sections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    logEvent(job, "job.queued", job.url);
    await writeJob(job);
    recordEnqueue(session);
    void enqueue(id, () => runJob(id));
    return reply.code(202).send({ id });
  });

  app.get("/api/jobs/:id", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Login required." } });
    const job = await readJob((req.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: { code: "URL_INVALID", message: "Job not found or expired." } });
    return job;
  });

  app.get("/api/jobs/:id/events", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Login required." } });
    const id = (req.params as { id: string }).id;
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    let last = -1;
    const timer = setInterval(async () => {
      const job = await readJob(id);
      if (!job) { reply.raw.write(`event: gone\ndata: {}\n\n`); clearInterval(timer); reply.raw.end(); return; }
      if (job.steps.length !== last) {
        last = job.steps.length;
        reply.raw.write(`data: ${JSON.stringify({ status: job.status, steps: job.steps, sections: job.sections })}\n\n`);
      }
      if (["done", "partial", "failed"].includes(job.status)) { clearInterval(timer); reply.raw.end(); }
    }, 1000);
    req.raw.on("close", () => clearInterval(timer));
  });

  app.get("/api/jobs/:id/shots/:file", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Login required." } });
    const { id, file } = req.params as { id: string; file: string };
    if (file.includes("..") || file.includes("/") || file.includes("\\")) return reply.code(400).send({ error: { code: "URL_INVALID", message: "Bad filename." } });
    try {
      const buf = await fs.readFile(path.join(jobDir(id), "shots", file));
      const type = file.endsWith(".png") ? "image/png" : "image/webp";
      return reply.header("Content-Type", type).header("Cache-Control", "private, max-age=3600").send(buf);
    } catch {
      return reply.code(404).send({ error: { code: "URL_INVALID", message: "Image not found." } });
    }
  });

  app.get("/api/jobs/:id/download.zip", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Login required." } });
    const id = (req.params as { id: string }).id;
    const job = await readJob(id);
    if (!job) return reply.code(404).send({ error: { code: "URL_INVALID", message: "Job not found." } });
    reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="site-walker-${id}.zip"`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (e) => reply.raw.destroy(e));
    archive.pipe(reply.raw);
    archive.directory(path.join(jobDir(id), "shots"), "shots");
    archive.append(JSON.stringify(job, null, 2), { name: "job.json" });
    await archive.finalize();
  });

  app.delete("/api/jobs/:id", async (req, reply) => {
    if (!authed(req)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Login required." } });
    const id = (req.params as { id: string }).id;
    await fs.rm(jobDir(id), { recursive: true, force: true });
    return { ok: true };
  });
}
