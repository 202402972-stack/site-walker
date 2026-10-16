// File store (plan §5): restart recovery + retention sweep.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Job } from "../../server/jobs/store.js";

const tmp = path.join(os.tmpdir(), `sw-store-test-${Date.now()}`);
process.env.DATA_DIR = tmp;

let store: typeof import("../../server/jobs/store.js");

beforeAll(async () => {
  store = await import("../../server/jobs/store.js");
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function mkJob(id: string, status: Job["status"]): Job {
  const now = new Date().toISOString();
  return {
    id,
    url: "https://example.com/",
    settings: { maxSections: 1, viewport: "desktop", format: "webp" },
    status,
    steps: [],
    sections: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("store (plan §5)", () => {
  it("recoverStaleJobs fails queued/running jobs at boot and touches nothing else", async () => {
    await store.writeJob(mkJob("run1", "running"));
    await store.writeJob(mkJob("queued1", "queued"));
    await store.writeJob(mkJob("done1", "done"));

    const recovered = await store.recoverStaleJobs();
    expect(recovered.sort()).toEqual(["queued1", "run1"]);

    const running = await store.readJob("run1");
    expect(running?.status).toBe("failed");
    expect(running?.steps.some((s) => s.event === "job.interrupted")).toBe(true);

    const done = await store.readJob("done1");
    expect(done?.status).toBe("done");
    expect(done?.steps.length).toBe(0);
  });

  it("retentionSweep deletes only jobs older than RETENTION_HOURS", async () => {
    await store.writeJob(mkJob("old1", "done"));
    await store.writeJob(mkJob("fresh1", "done"));

    const p = path.join(tmp, "jobs", "old1", "job.json");
    const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    await fs.utimes(p, past, past);

    const deleted = await store.retentionSweep();
    expect(deleted).toContain("old1");
    expect(deleted).not.toContain("fresh1");
    expect(await store.readJob("old1")).toBeNull();
    expect((await store.readJob("fresh1"))?.status).toBe("done");
  });
});
