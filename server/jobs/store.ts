// File-based job store — plan §5/§7. Survives restarts via DATA_DIR volume.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export type JobStatus = "queued" | "running" | "done" | "partial" | "failed";

export interface JobEvent {
  t: string;
  event: string;
  detail?: string;
}

export interface JobSectionResult {
  name: string;
  url: string;
  kind: string;
  file?: string;
  width?: number;
  height?: number;
  bytes?: number;
  truncated?: boolean;
  elementCapture?: string;
  error?: string;
  code?: string;
}

export interface Job {
  id: string;
  url: string;
  settings: {
    maxSections: number;
    viewport: "desktop" | "mobile";
    format: "webp" | "png";
    /** Optional login. Username + login page survive to disk; the PASSWORD
        lives only in server/jobs/secrets.ts (memory) and is deleted on use. */
    auth?: { username: string; loginUrl?: string };
  };
  status: JobStatus;
  steps: JobEvent[];
  sections: JobSectionResult[];
  createdAt: string;
  updatedAt: string;
  peakMemoryMB?: number;
}

export function jobsDir(): string {
  return path.join(config.DATA_DIR, "jobs");
}

export function jobDir(id: string): string {
  return path.join(jobsDir(), id);
}

export async function writeJob(job: Job): Promise<void> {
  const dir = jobDir(job.id);
  await fs.mkdir(path.join(dir, "shots"), { recursive: true });
  job.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, "job.json"), JSON.stringify(job, null, 2));
}

export async function readJob(id: string): Promise<Job | null> {
  try {
    const raw = await fs.readFile(path.join(jobDir(id), "job.json"), "utf8");
    return JSON.parse(raw) as Job;
  } catch {
    return null;
  }
}

export function logEvent(job: Job, event: string, detail?: string): void {
  job.steps.push({ t: new Date().toISOString(), event, detail });
}

// Mark queued/running jobs as failed at boot — the process that owned them is gone
// (plan §9.3: a job must never appear stuck "running" forever after a restart).
export async function recoverStaleJobs(): Promise<string[]> {
  const recovered: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(jobsDir());
  } catch {
    return recovered;
  }
  for (const id of entries) {
    const job = await readJob(id);
    if (!job || (job.status !== "queued" && job.status !== "running")) continue;
    job.status = "failed";
    logEvent(job, "job.interrupted", "server restarted while this job was not finished");
    await writeJob(job);
    recovered.push(id);
  }
  return recovered;
}

// Delete jobs older than RETENTION_HOURS. Returns deleted ids.
export async function retentionSweep(): Promise<string[]> {
  const deleted: string[] = [];
  const root = jobsDir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return deleted;
  }
  const cutoff = Date.now() - config.RETENTION_HOURS * 3600 * 1000;
  for (const id of entries) {
    const p = path.join(root, id, "job.json");
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs < cutoff) {
        await fs.rm(path.join(root, id), { recursive: true, force: true });
        deleted.push(id);
      }
    } catch { /* ignore */ }
  }
  return deleted;
}
