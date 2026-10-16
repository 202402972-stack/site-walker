// Live API check for the login feature: cross-origin login page rejected (400),
// auth job runs the login step, and the password never lands in job.json.
// Usage: SW_TOKEN=<admin token> npx tsx tools/login-api-check.ts [base]
import fs from "node:fs";

const base = (process.argv[2] ?? process.env.BASE ?? "http://localhost:8099").replace(/\/$/, "");
const token = process.env.SW_TOKEN ?? "";
if (!token) {
  console.error("SW_TOKEN is required.");
  process.exit(2);
}

const failures: string[] = [];
function check(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!pass) failures.push(name);
}

async function call(path: string, init: RequestInit = {}, cookie?: string): Promise<{ status: number; body: unknown; cookie: string }> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const r = await fetch(base + path, { ...init, headers });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* ignore */
  }
  const set = r.headers.getSetCookie().find((c) => c.startsWith("sw_session="))?.split(";")[0] ?? "";
  return { status: r.status, body, cookie: set };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const login = await call("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token }),
});
check("login", login.status === 200 && login.cookie.startsWith("sw_session="), `HTTP ${login.status}`);
const cookie = login.cookie;
if (!cookie) process.exit(1);

const evil = await call("/api/jobs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "https://example.com",
    maxSections: 1,
    auth: { username: "u", password: "pw", loginUrl: "https://evil.example.net/login" },
  }),
}, cookie);
check(
  "cross-origin login page rejected",
  evil.status === 400,
  `HTTP ${evil.status} ${JSON.stringify(evil.body).slice(0, 120)}`,
);

// Same-origin guard with two hosts that both resolve: rejected specifically
// for the origin mismatch (not DNS), so the guard itself is exercised.
const mismatch = await call("/api/jobs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "https://example.com",
    maxSections: 1,
    auth: { username: "u", password: "pw", loginUrl: "https://www.iana.org/login" },
  }),
}, cookie);
check(
  "origin mismatch rejected by the same-site guard",
  mismatch.status === 400 && JSON.stringify(mismatch.body).includes("same site"),
  `HTTP ${mismatch.status} ${JSON.stringify(mismatch.body).slice(0, 140)}`,
);

const marker = `S3CR3T-PW-${Date.now()}`;
const created = await call("/api/jobs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: "https://example.com",
    maxSections: 1,
    auth: { username: "owner@example.com", password: marker },
  }),
}, cookie);
check("auth job accepted", created.status === 202, `HTTP ${created.status}`);
const id = (created.body as { id?: string } | null)?.id ?? "";
if (!id) process.exit(1);

let job: { status?: string; steps?: { event: string; detail?: string }[]; settings?: { auth?: unknown } } | null = null;
const t0 = Date.now();
while (Date.now() - t0 < 150_000) {
  await sleep(4000);
  const r = await call(`/api/jobs/${id}`, {}, cookie);
  if (r.status === 200 && typeof r.body === "object" && r.body !== null) {
    const st = (r.body as { status?: string }).status;
    if (st === "done" || st === "partial" || st === "failed") {
      job = r.body as typeof job;
      break;
    }
  }
}
const events = (job?.steps ?? []).map((s) => s.event).join(",");
check("auth job reached terminal status", !!job, `status=${job?.status} events=${events}`);
check(
  "login step attempted without a form",
  (job?.steps ?? []).some((s) => s.event === "login.failed" && (s.detail ?? "").includes("LOGIN_NO_FORM")),
  events,
);

const raw = fs.readFileSync(`data/jobs/${id}/job.json`, "utf8");
check("password absent from job.json", !raw.includes(marker), `${Math.round(raw.length / 1024)}KB scanned`);
check(
  "settings.auth is username-only",
  !/password/i.test(JSON.stringify((job as { settings?: unknown } | null)?.settings ?? {})),
  JSON.stringify(job?.settings?.auth),
);
await call(`/api/jobs/${id}`, { method: "DELETE" }, cookie);

console.log(failures.length === 0 ? "LOGIN API: ALL PASS" : `LOGIN API FAILURES: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
