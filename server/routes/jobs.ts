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
import { stashPassword, takePassword, dropPassword } from "../jobs/secrets.js";
import { attemptLogin } from "../agent/login.js";
import { loadSession, playwrightState, saveSession, type StorageState } from "../jobs/sessions.js";
import { enqueue, isBusy, hourlyAllowed, recordEnqueue } from "../jobs/queue.js";

const CreateBody = z.object({
  url: z.string().min(1).max(2048),
  maxSections: z.number().int().min(1).max(12).optional(),
  viewport: z.enum(["desktop", "mobile"]).optional(),
  format: z.enum(["webp", "png"]).optional(),
  // Optional per-run credentials. Password is held in memory only
  // (server/jobs/secrets.ts), never written to the job file or logs.
  auth: z.object({
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(1024),
    loginUrl: z.string().min(1).max(2048).optional(),
  }).optional(),
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
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  // Every failure path must end with a terminal status in the job file —
  // otherwise clients poll (and SSE waits) forever (plan §9.3).
  const failJob = async (msg: string): Promise<void> => {
    if (["done", "partial", "failed"].includes(job.status)) return;
    job.status = "failed";
    logEvent(job, "job.failed", msg);
    await writeJob(job);
  };
  try {
    browser = await launchBrowser();
    logEvent(job, "browser.opened", "playwright chromium");
    await writeJob(job);
    // Saved-session replay: if the owner imported (or a previous run saved) a
    // login session for this origin, the context starts with it — CAPTCHA/
    // login walls that the human already passed are simply not hit again.
    const origin = new URL(job.url).origin;
    let savedUsed = false;
    let savedSession: StorageState | null = null;
    try {
      savedSession = await loadSession(origin);
    } catch {
      savedSession = null;
    }
    const ctx = await browser.newContext({
      viewport: job.settings.viewport === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(savedSession ? { storageState: playwrightState(savedSession) } : {}),
    });
    if (savedSession) {
      savedUsed = true;
      logEvent(job, "session.used", `${savedSession.cookies.length} saved cookies applied for ${origin}`);
      await writeJob(job);
    }
    let loginOk = false;
    await ctx.route("**/*", async (route) => {
      if (shouldBlockRequestUrl(route.request().url())) return route.abort("blockedbyclient");
      return route.continue();
    });
    // Optional per-run login. The password is single-use from the memory
    // vault; only the username and outcome codes are ever logged.
    if (job.settings.auth) {
      const pw = takePassword(id);
      if (!pw) {
        logEvent(job, "login.skipped", "credentials unavailable in memory (server restarted?) — continuing without login");
      } else {
        const loginPage = await ctx.newPage();
        try {
          await loginPage.goto(job.settings.auth.loginUrl ?? job.url, { waitUntil: "domcontentloaded", timeout: config.NAV_WAIT_MS });
          const lr = await attemptLogin(loginPage, { username: job.settings.auth.username, password: pw }, {
            // SSO-hop detection is relative to the TARGET site, and the
            // budget stays inside MAX_JOB_SECONDS.
            entryHostname: new URL(job.url).hostname,
            budgetMs: 90_000,
          });
          // Trail is credential-free by construction (tests enforce it).
          const meta = lr.ok ? `as ${job.settings.auth.username}` : `${lr.code} ${lr.detail}`;
          logEvent(job, lr.ok ? "login.ok" : "login.failed", `${meta} [${lr.trail.join(" | ")}]`.slice(0, 400));
          loginOk = lr.ok;
        } catch (e) {
          logEvent(job, "login.failed", `LOGIN_FAILED ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        } finally {
          await loginPage.close().catch(() => {});
        }
      }
      dropPassword(id);
      await writeJob(job);
    }
    // Persist/refresh the session for this origin — after a successful login,
    // or when a saved session was used (NASA-style long sessions rotate
    // cookies server-side; re-saving keeps the session alive). Encrypted at
    // rest; only counts are ever logged.
    if (loginOk || savedUsed) {
      try {
        const st = await ctx.storageState();
        if (st.cookies.length > 0) {
          await saveSession(origin, st);
          logEvent(job, "session.saved", `${st.cookies.length} cookies stored (encrypted at rest) for ${origin}`);
          await writeJob(job);
        }
      } catch {
        /* session persistence is best-effort — never fail the run for it */
      }
    }
    const probe = await ctx.newPage();
    const sections = await (async () => {
      try {
        await probe.goto(job.url, { waitUntil: "domcontentloaded", timeout: config.NAV_WAIT_MS });
        try {
          await probe.waitForLoadState("load", { timeout: 15000 });
        } catch { /* heavy pages stream forever — proceed with what rendered */ }
        await probe.waitForTimeout(2500);
        return (await discoverSections(probe, job.url)).slice(0, job.settings.maxSections);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logEvent(job, "sections.failed", msg.slice(0, 300));
        job.status = "failed";
        logEvent(job, "job.failed", `discovery failed: ${msg.slice(0, 200)}`);
        await writeJob(job);
        await probe.close().catch(() => {});
        await ctx.close().catch(() => {});
        return null;
      }
    })();
    if (!sections) return;
    logEvent(job, "sections.discovered", `${sections.length}: ${sections.map((s) => s.name).join(" | ")}`);
    await probe.close().catch(() => {});
    await writeJob(job);

    const shotsDir = path.join(jobDir(id), "shots");
    await fs.mkdir(shotsDir, { recursive: true });
    let peak = 0;
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
  } catch (e) {
    // Abort path (watchdog abort, OOM kill of the browser, unexpected throw): the
    // capture loop may have already set a terminal status — keep it; otherwise fail.
    await failJob(
      e instanceof Error
        ? `run aborted: ${e.message.slice(0, 200)}`
        : "run aborted",
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
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
    // Credential guard: a custom login page must share the entry's origin,
    // otherwise the password could be posted to an unrelated host.
    let loginUrl: string | undefined;
    if (parsed.data.auth?.loginUrl) {
      const loginCheck = await validateEntryUrl(parsed.data.auth.loginUrl);
      if (!loginCheck.ok) return reply.code(loginCheck.code === "URL_INVALID" ? 400 : 403).send({ error: { code: loginCheck.code, message: "Login page: " + loginCheck.message } });
      if (loginCheck.url.origin !== check.url.origin) {
        return reply.code(400).send({ error: { code: "URL_INVALID", message: "Login page must be on the same site as the entry URL." } });
      }
      loginUrl = loginCheck.url.toString();
    }
    const id = crypto.randomUUID();
    const job: Job = {
      id,
      url: check.url.toString(),
      settings: {
        maxSections: Math.min(parsed.data.maxSections ?? config.MAX_SECTIONS, config.MAX_SECTIONS),
        viewport: parsed.data.viewport ?? config.DEFAULT_VIEWPORT,
        format: parsed.data.format ?? config.DEFAULT_FORMAT,
        ...(parsed.data.auth ? { auth: { username: parsed.data.auth.username, ...(loginUrl ? { loginUrl } : {}) } } : {}),
      },
      status: "queued",
      steps: [],
      sections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (parsed.data.auth) stashPassword(id, parsed.data.auth.password);
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
