// Browser lifecycle + memory guard — plan §7.5.
import fs from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { config } from "../config.js";

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", // Known tradeoff on Railway (container-root). Compensating controls in README + ssrf.ts.
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
}

// cgroup v2 first, v1 fallback. Returns MB. Returns -1 when unreadable (local non-Linux).
export async function getMemoryMB(): Promise<number> {
  try {
    const raw = await fs.readFile("/sys/fs/cgroup/memory.current", "utf8");
    return Math.round(Number(raw.trim()) / 1024 / 1024);
  } catch { /* fall through */ }
  try {
    const raw = await fs.readFile("/sys/fs/cgroup/memory/memory.usage_in_bytes", "utf8");
    return Math.round(Number(raw.trim()) / 1024 / 1024);
  } catch {
    return -1;
  }
}

export function isOverGuard(mb: number): boolean {
  if (mb < 0) return false;
  return mb >= config.MEM_GUARD_MB;
}
