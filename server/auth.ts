// Auth — plan §8.1. Token-gated console: ADMIN_TOKEN constant-time compare,
// login rate limit 5/15min per IP, HMAC-signed session cookie.
import crypto from "node:crypto";
import { config } from "./config.js";

const attempts = new Map<string, number[]>();

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, arr);
  return arr.length >= 5;
}

export function recordAttempt(ip: string): void {
  const arr = attempts.get(ip) ?? [];
  arr.push(Date.now());
  attempts.set(ip, arr);
}

export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

export function tokenMatches(provided: string): boolean {
  const expected = config.ADMIN_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // constant-time-ish: still hash both to avoid length leak timing
    const ha = crypto.createHash("sha256").update(a).digest();
    const hb = crypto.createHash("sha256").update(b).digest();
    return crypto.timingSafeEqual(ha, hb) && false;
  }
  return crypto.timingSafeEqual(a, b);
}

function hmac(data: string): string {
  return crypto.createHmac("sha256", config.SESSION_SECRET).update(data).digest("hex");
}

export function issueSession(): string {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const payload = `sitewalker.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

export function verifySession(cookie: string | undefined): boolean {
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const sig = parts[2];
  const expected = hmac(payload);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  } catch {
    return false;
  }
  const exp = Number(parts[1]);
  return Number.isFinite(exp) && Date.now() < exp;
}
