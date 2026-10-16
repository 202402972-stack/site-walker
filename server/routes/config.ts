// Public product limits — plan §9.2.4. The landing "Controls and limits" table
// reads from here so copy and behavior cannot drift. No secrets, no auth.
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

export async function registerConfigRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/config", async () => ({
    product: config.PRODUCT_NAME,
    maxSections: config.MAX_SECTIONS,
    maxJobSeconds: config.MAX_JOB_SECONDS,
    maxPageHeight: config.MAX_PAGE_HEIGHT,
    navWaitMs: config.NAV_WAIT_MS,
    memGuardMb: config.MEM_GUARD_MB,
    retentionHours: config.RETENTION_HOURS,
    maxJobMb: Math.round(config.MAX_JOB_BYTES / 1024 / 1024),
    concurrency: 1,
    queueDepth: 3,
    jobsPerHour: 10,
  }));
}
