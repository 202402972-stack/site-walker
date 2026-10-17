// Saved login sessions (Playwright storageState) — the human-in-the-loop
// answer to CAPTCHA-protected sites.
//
// The model: the OWNER signs in once in their own browser — solving any
// challenge as a human — exports the session (cookies), imports it here, and
// every later capture for that origin rides that session. Nothing is solved
// by the service; the human did the human part once, and the service replays
// the resulting legitimate session. Sessions saved after a successful
// password login refresh themselves the same way.
//
// At rest: AES-256-GCM with a scrypt-derived key from SESSION_SECRET and a
// per-file salt. Files under DATA_DIR/sessions hold metadata + ciphertext
// only: cookie values never sit in plaintext on disk, never appear in
// listings, logs, job files, or the API. Rotating SESSION_SECRET makes old
// session files undecryptable by design (re-import or re-login).
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface StorageState {
  cookies: StoredCookie[];
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
}

export interface SessionMeta {
  id: string;
  origin: string;
  savedAt: string;
  cookieCount: number;
  label?: string;
}

interface SessionFile {
  meta: SessionMeta;
  enc: { v: 1; salt: string; iv: string; tag: string; data: string };
}

const ENC_VERSION = 1;

export function sessionsDir(): string {
  return path.join(config.DATA_DIR, "sessions");
}

export function sessionIdFor(origin: string): string {
  return crypto.createHash("sha256").update(origin).digest("hex").slice(0, 24);
}

function deriveKey(salt: Buffer): Buffer {
  return crypto.scryptSync(config.SESSION_SECRET, salt, 32);
}

function encryptState(state: StorageState): SessionFile["enc"] {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return {
    v: ENC_VERSION,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptState(enc: SessionFile["enc"]): StorageState | null {
  try {
    if (enc.v !== ENC_VERSION) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveKey(Buffer.from(enc.salt, "base64")),
      Buffer.from(enc.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
    const out = Buffer.concat([decipher.update(Buffer.from(enc.data, "base64")), decipher.final()]);
    const parsed = JSON.parse(out.toString("utf8")) as StorageState;
    if (!parsed || !Array.isArray(parsed.cookies)) return null;
    return parsed;
  } catch {
    // Wrong secret (rotated), tampered file, or corrupted data.
    return null;
  }
}

async function readSessionFile(id: string): Promise<SessionFile | null> {
  try {
    const raw = await fs.readFile(path.join(sessionsDir(), `${id}.json`), "utf8");
    const parsed = JSON.parse(raw) as SessionFile;
    if (!parsed?.meta?.origin || !parsed?.enc?.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSession(
  origin: string,
  state: StorageState,
  label?: string,
): Promise<SessionMeta> {
  const id = sessionIdFor(origin);
  const meta: SessionMeta = {
    id,
    origin,
    savedAt: new Date().toISOString(),
    cookieCount: state.cookies.length,
    ...(label ? { label: label.slice(0, 120) } : {}),
  };
  const file: SessionFile = { meta, enc: encryptState(state) };
  await fs.mkdir(sessionsDir(), { recursive: true });
  await fs.writeFile(path.join(sessionsDir(), `${id}.json`), JSON.stringify(file));
  return meta;
}

/** Returns the decrypted state, or null when missing/undecryptable. */
export async function loadSession(origin: string): Promise<StorageState | null> {
  const file = await readSessionFile(sessionIdFor(origin));
  if (!file) return null;
  return decryptState(file.enc);
}

/** Metadata only — never cookie values. */
export async function listSessions(): Promise<SessionMeta[]> {
  try {
    const files = await fs.readdir(sessionsDir());
    const metas: SessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const file = await readSessionFile(f.replace(/\.json$/, ""));
      if (file) metas.push(file.meta);
    }
    return metas.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return [];
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(sessionsDir(), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function deleteSessionForOrigin(origin: string): Promise<boolean> {
  return deleteSession(sessionIdFor(origin));
}

/** Remove sessions older than the retention window (boot + periodic sweep). */
export async function pruneSessions(retentionDays = config.SESSION_RETENTION_DAYS): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const meta of await listSessions()) {
    const t = Date.parse(meta.savedAt);
    if (Number.isFinite(t) && t < cutoff) {
      if (await deleteSession(meta.id)) removed++;
    }
  }
  return removed;
}

/**
 * Convert a stored state into the strict shape Playwright's `storageState`
 * context option expects (its cookie type requires concrete expires/httpOnly/
 * secure/sameSite). Missing fields get benign defaults.
 */
export function playwrightState(state: StorageState): {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
} {
  return {
    cookies: state.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: typeof c.expires === "number" ? c.expires : -1,
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      sameSite: c.sameSite ?? "Lax",
    })),
    origins: (state.origins ?? []).map((o) => ({
      origin: o.origin,
      localStorage: (o.localStorage ?? []).map((kv) => ({ name: kv.name, value: kv.value })),
    })),
  };
}

/**
 * Normalize an imported session body into a StorageState restricted to the
 * given URL's own host. Accepts either a Playwright storageState object
 * ({cookies:[...]}) or a raw array of cookie objects (what cookie-editor style
 * browser extensions export). Cookies whose domain does not belong to the
 * target host are dropped — an import can never plant cookies for other sites.
 */
export function normalizeImport(
  url: string,
  body: unknown,
): { ok: true; state: StorageState; dropped: number } | { ok: false; reason: string } {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, reason: "A valid http(s) site URL is required." };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { ok: false, reason: "A valid http(s) site URL is required." };
  }
  const host = parsedUrl.hostname.toLowerCase();
  const rawCookies = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { cookies?: unknown[] }).cookies)
      ? (body as { cookies: unknown[] }).cookies
      : null;
  if (!rawCookies) {
    return { ok: false, reason: "Expected a storageState object with a cookies array (or a raw cookies array)." };
  }
  const belongs = (domain: string): boolean => {
    const d = domain.replace(/^\./, "").toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  };
  const cookies: StoredCookie[] = [];
  let dropped = 0;
  for (const c of rawCookies) {
    const o = c as Partial<StoredCookie>;
    if (!o || typeof o.name !== "string" || typeof o.value !== "string" || typeof o.domain !== "string") {
      dropped++;
      continue;
    }
    if (!belongs(o.domain)) {
      dropped++;
      continue;
    }
    cookies.push({
      name: o.name.slice(0, 512),
      value: o.value.slice(0, 8192),
      domain: o.domain,
      path: typeof o.path === "string" && o.path.startsWith("/") ? o.path : "/",
      ...(typeof o.expires === "number" && o.expires > 0 ? { expires: o.expires } : {}),
      ...(o.httpOnly === true ? { httpOnly: true } : {}),
      ...(o.secure === true ? { secure: true } : {}),
      ...(o.sameSite === "Strict" || o.sameSite === "Lax" || o.sameSite === "None" ? { sameSite: o.sameSite } : {}),
    });
  }
  if (cookies.length === 0) {
    return { ok: false, reason: "No cookies for this site were found in the import." };
  }
  const origins = body && typeof body === "object" && Array.isArray((body as { origins?: unknown[] }).origins)
    ? ((body as { origins: StorageState["origins"] }).origins ?? []).filter(
        (o) => o && typeof o.origin === "string" && o.origin.toLowerCase().includes(host),
      )
    : undefined;
  return { ok: true, state: { cookies, ...(origins && origins.length ? { origins } : {}) }, dropped };
}
