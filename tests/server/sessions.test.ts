// Saved-session vault: encryption at rest, host-filtered imports, integrity,
// listing, deletion, and pruning.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  deleteSession,
  deleteSessionForOrigin,
  listSessions,
  loadSession,
  normalizeImport,
  pruneSessions,
  saveSession,
  sessionIdFor,
  sessionsDir,
} from "../../server/jobs/sessions.js";

const A = "https://session-test-a.example";
const B = "https://session-test-b.example";

const stateA = {
  cookies: [
    { name: "cf_clearance", value: "SECRET-VALUE-AAA", domain: ".session-test-a.example", path: "/", httpOnly: true, secure: true as const },
    { name: "sid", value: "SECRET-VALUE-BBB", domain: "session-test-a.example", path: "/" },
  ],
};

beforeAll(async () => {
  await deleteSessionForOrigin(A);
  await deleteSessionForOrigin(B);
});
afterAll(async () => {
  await deleteSessionForOrigin(A);
  await deleteSessionForOrigin(B);
});

describe("session vault round-trip", () => {
  it("saves and loads a storage state", async () => {
    const meta = await saveSession(A, stateA, "fixture");
    expect(meta.origin).toBe(A);
    expect(meta.cookieCount).toBe(2);
    const loaded = await loadSession(A);
    expect(loaded?.cookies.map((c) => c.name)).toEqual(["cf_clearance", "sid"]);
    expect(loaded?.cookies[0].value).toBe("SECRET-VALUE-AAA");
  });

  it("cookie values never sit in plaintext on disk", async () => {
    await saveSession(A, stateA);
    const raw = await fs.readFile(path.join(sessionsDir(), `${sessionIdFor(A)}.json`), "utf8");
    expect(raw).not.toContain("SECRET-VALUE-AAA");
    expect(raw).not.toContain("SECRET-VALUE-BBB");
    expect(raw).toContain(A); // metadata (origin) is non-secret by design
  });

  it("tampered ciphertext fails closed (null, not garbage)", async () => {
    await saveSession(A, stateA);
    const file = path.join(sessionsDir(), `${sessionIdFor(A)}.json`);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { enc: { data: string } };
    // Flip a base64 character in the payload.
    const d = parsed.enc.data;
    parsed.enc.data = (d[0] === "A" ? "B" : "A") + d.slice(1);
    await fs.writeFile(file, JSON.stringify(parsed));
    expect(await loadSession(A)).toBeNull();
    await deleteSessionForOrigin(A); // the tampered file would break later tests
  });

  it("missing sessions load as null", async () => {
    expect(await loadSession("https://never-saved.example")).toBeNull();
  });
});

describe("session listing and deletion", () => {
  it("lists metadata without values, then deletes", async () => {
    await saveSession(A, stateA);
    await saveSession(B, { cookies: [{ name: "k", value: "v", domain: "session-test-b.example", path: "/" }] });
    const met = await listSessions();
    const origins = met.map((m) => m.origin);
    expect(origins).toContain(A);
    expect(origins).toContain(B);
    expect(JSON.stringify(met)).not.toContain("SECRET-VALUE-AAA");

    expect(await deleteSession(sessionIdFor(B))).toBe(true);
    expect(await loadSession(B)).toBeNull();
    expect(await deleteSession("000000000000000000000000")).toBe(false);
  });
});

describe("pruning by retention window", () => {
  it("removes sessions older than the cutoff", async () => {
    await saveSession(A, stateA);
    const file = path.join(sessionsDir(), `${sessionIdFor(A)}.json`);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { meta: { savedAt: string } };
    parsed.meta.savedAt = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    await fs.writeFile(file, JSON.stringify(parsed));
    const removed = await pruneSessions(14);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await loadSession(A)).toBeNull();
  });
});

describe("import normalization (host-filtered)", () => {
  it("keeps only cookies that belong to the target host", () => {
    const r = normalizeImport("https://shop.example.com/account", {
      cookies: [
        { name: "a", value: "1", domain: ".example.com", path: "/" },
        { name: "b", value: "2", domain: "shop.example.com", path: "/" },
        { name: "evil", value: "3", domain: "other.net", path: "/" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.cookies.map((c) => c.name)).toEqual(["a", "b"]);
      expect(r.dropped).toBe(1);
    }
  });

  it("accepts a raw cookies array (extension export style)", () => {
    const r = normalizeImport("https://example.com", [
      { name: "cf_clearance", value: "x", domain: ".example.com", path: "/", httpOnly: true },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.cookies[0].name).toBe("cf_clearance");
  });

  it("rejects imports with no cookies for the site, bad URLs, and junk bodies", () => {
    expect(normalizeImport("https://example.com", { cookies: [{ name: "a", value: "1", domain: "other.net" }] }).ok).toBe(false);
    expect(normalizeImport("javascript:alert(1)", { cookies: [] }).ok).toBe(false);
    expect(normalizeImport("https://example.com", "not json").ok).toBe(false);
    expect(normalizeImport("https://example.com", { nope: true }).ok).toBe(false);
  });

  it("does not accept a parent domain it merely shares a suffix with", () => {
    // host evil-example.com must not accept cookies for example.com
    const r = normalizeImport("https://evil-example.com", {
      cookies: [{ name: "a", value: "1", domain: "example.com", path: "/" }],
    });
    expect(r.ok).toBe(false);
  });
});
