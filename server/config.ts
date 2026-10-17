// Single source of truth for all limits. Every other module imports from here.
// Values come from env with plan §7/§8/§11.2 defaults. Copy drift is a bug.
export const PRODUCT_NAME = "Site Walker";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  PRODUCT_NAME,
  PORT: num("PORT", 8080),
  DATA_DIR: process.env.DATA_DIR ?? "./data",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? "",
  SESSION_SECRET: process.env.SESSION_SECRET ?? "dev-only-change-me",
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? "http://localhost:8080",
  MAX_SECTIONS: num("MAX_SECTIONS", 12),
  MAX_JOB_SECONDS: num("MAX_JOB_SECONDS", 120),
  MAX_PAGE_HEIGHT: num("MAX_PAGE_HEIGHT", 16000),
  NAV_WAIT_MS: num("NAV_WAIT_MS", 15000),
  MEM_GUARD_MB: num("MEM_GUARD_MB", 450),
  RETENTION_HOURS: num("RETENTION_HOURS", 24),
  // Per-job disk cap (bytes). Plan §8.1: 60 MB.
  MAX_JOB_BYTES: num("MAX_JOB_BYTES", 60 * 1024 * 1024),
  // Saved login sessions (encrypted at rest; see server/jobs/sessions.ts).
  // Retention: sessions older than this are pruned at boot and on sweeps.
  SESSION_RETENTION_DAYS: num("SESSION_RETENTION_DAYS", 14),
  // Import cap for a session paste (bytes of JSON, before encryption).
  MAX_SESSION_BYTES: num("MAX_SESSION_BYTES", 256 * 1024),
  // Screenshot defaults
  DEFAULT_VIEWPORT: (process.env.DEFAULT_VIEWPORT ?? "desktop") as "desktop" | "mobile",
  DEFAULT_FORMAT: (process.env.DEFAULT_FORMAT ?? "webp") as "webp" | "png",
} as const;

export type AppConfig = typeof config;

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;
