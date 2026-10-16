// Console state coverage (plan §9.3) against a live server, real Chromium job included.
// States exercised: gate (401), invalid (400), blocked (403 SSRF), busy (429),
// running (streamed steps), done (shots + ZIP), gone (404 after delete),
// rate-limited (429 after the hourly cap, with --rate-limit).
//
// Usage: SW_TOKEN=<admin token> npx tsx tools/api-state-test.ts [base] [--rate-limit]
import fs from "node:fs";

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? process.env.BASE ?? "http://localhost:8099").replace(/\/$/, "");
const rateLimitRun = args.includes("--rate-limit");
const token = process.env.SW_TOKEN;
if (!token) {
  console.error("SW_TOKEN is required (the server's ADMIN_TOKEN).");
  process.exit(2);
}

interface Res {
  status: number;
  body: Record<string, unknown> | null;
  cookie: string;
}
const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  results.push({ name, pass });
}

async function call(pathname: string, init: RequestInit = {}, cookie?: string): Promise<Res> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const r = await fetch(base + pathname, { ...init, headers });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await r.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  const set = r.headers.getSetCookie();
  const cookieHeader = set.find((c) => c.startsWith("sw_session="))?.split(";")[0] ?? "";
  return { status: r.status, body, cookie: cookieHeader };
}
const code = (r: Res): string =>
  ((r.body?.error as { code?: string } | undefined)?.code ?? "") as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1) health + gate + blocked + invalid
const health = await call("/healthz");
check("healthz", health.status === 200 && health.body?.ok === true, JSON.stringify(health.body));

const unauth = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }) });
check("gate: unauthenticated POST /api/jobs → 401", unauth.status === 401 && code(unauth) === "UNAUTHORIZED", `HTTP ${unauth.status} ${code(unauth)}`);

const badLogin = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "definitely-wrong" }) });
check("gate: wrong token → 401", badLogin.status === 401, `HTTP ${badLogin.status}`);

const login = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
check("gate: token login → 200 + cookie", login.status === 200 && login.cookie.startsWith("sw_session="), `HTTP ${login.status}`);
const cookie = login.cookie;

const invalid = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "not a url" }) }, cookie);
check("invalid: bad URL → 400 URL_INVALID", invalid.status === 400 && code(invalid) === "URL_INVALID", `HTTP ${invalid.status} ${code(invalid)}`);

for (const [label, url] of [
  ["loopback", "http://127.0.0.1/"],
  ["metadata", "http://169.254.169.254/"],
  ["decimal ip", "http://2130706433/"],
  ["ipv6 loopback", "http://[::1]/"],
  ["internal host", "http://x.railway.internal/"],
  ["file scheme", "file:///etc/passwd"],
] as const) {
  const r = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }, cookie);
  check(`blocked: ${label} → 403`, r.status === 403 && code(r) === "URL_BLOCKED", `HTTP ${r.status} ${code(r)}`);
}

// 2) busy: second job while one runs
const a = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", maxSections: 1, format: "webp" }) }, cookie);
check("start: real job → 202", a.status === 202 && typeof a.body?.id === "string", `HTTP ${a.status} id=${String(a.body?.id).slice(0, 8)}`);
const jobId = String(a.body?.id);

const busy = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", maxSections: 1 }) }, cookie);
check("busy: second job while running → 429 BUSY", busy.status === 429 && code(busy) === "BUSY", `HTTP ${busy.status} ${code(busy)}`);

// 3) running: stream events until a terminal status
const started = Date.now();
let steps = 0;
let final: Record<string, unknown> | null = null;
{
  const r = await fetch(`${base}/api/jobs/${jobId}/events`, { headers: { cookie } });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 150_000;
  outer: while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const line = f.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6)) as { status: string; steps: unknown[]; sections: Record<string, unknown>[] };
      steps = payload.steps.length;
      if (["done", "partial", "failed"].includes(payload.status)) {
        final = payload as unknown as Record<string, unknown>;
        break outer;
      }
    }
  }
  reader.cancel().catch(() => {});
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
check("running: streamed live steps then terminal status", !!final && steps >= 4, `${steps} step events in ${elapsed}s, status=${final?.status}`);
check("done: job completed with a section", final?.status === "done" && Array.isArray(final?.sections) && (final.sections as unknown[]).length === 1, `status=${final?.status} sections=${(final?.sections as unknown[] | undefined)?.length}`);

const sec = (final?.sections as { file?: string; bytes?: number }[] | undefined)?.[0];
const job = await call(`/api/jobs/${jobId}`, {}, cookie);
check("done: job readable after completion", job.status === 200, `HTTP ${job.status}`);

const shot = await fetch(`${base}/api/jobs/${jobId}/shots/${sec?.file}`, { headers: { cookie } });
const shotLen = (await shot.arrayBuffer()).byteLength;
check("done: shot downloads and matches recorded bytes", shot.status === 200 && shotLen === sec?.bytes, `HTTP ${shot.status} ${shotLen}B recorded=${sec?.bytes}B`);

const zip = await fetch(`${base}/api/jobs/${jobId}/download.zip`, { headers: { cookie } });
const zipBuf = Buffer.from(await zip.arrayBuffer());
const isZip = zipBuf[0] === 0x50 && zipBuf[1] === 0x4b; // "PK"
const hasShot = zipBuf.includes(Buffer.from(sec?.file ?? "\u0000"));
const hasJob = zipBuf.includes(Buffer.from("job.json"));
check(
  "done: ZIP downloads and contains shot + job.json",
  zip.status === 200 && isZip && hasShot && hasJob,
  `HTTP ${zip.status} ${Math.round(zipBuf.length / 1024)}KB shot=${hasShot} job.json=${hasJob}`,
);

const del = await call(`/api/jobs/${jobId}`, { method: "DELETE" }, cookie);
check("expired: delete → 200", del.status === 200 && del.body?.ok === true, `HTTP ${del.status}`);
const gone = await call(`/api/jobs/${jobId}`, {}, cookie);
check("expired: deleted job → 404", gone.status === 404, `HTTP ${gone.status}`);

// 4) failure path: an RFC 5737 TEST-NET-1 blackhole (public range, never answers)
//    makes page.goto throw mid-run — the job must reach a terminal status
//    (never stuck "running") with job.failed logged. True guard behavior for
//    dead DOMAINS is a straight 400 at validation (checked below).
if (rateLimitRun) {
  const noGuard = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://example.invalid/", maxSections: 1 }) }, cookie);
  check("failure guard: dead domain rejected at validation → 400", noGuard.status === 400 && code(noGuard) === "URL_INVALID", `HTTP ${noGuard.status} ${code(noGuard)}`);

  const dead = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://192.0.2.1/", maxSections: 1 }) }, cookie);
  check("failure: blackhole job accepted → 202", dead.status === 202, `HTTP ${dead.status}`);
  const deadId = String(dead.body?.id ?? "");
  if (deadId) {
    const t0 = Date.now();
    let dj: Record<string, unknown> | null = null;
    while (Date.now() - t0 < 90_000) {
      await sleep(3000);
      const r = await call(`/api/jobs/${deadId}`, {}, cookie);
      if (["done", "partial", "failed"].includes(String(r.body?.status))) { dj = r.body; break; }
    }
    const dsteps = (dj?.steps as { event: string }[] | undefined) ?? [];
    check(
      "failure: blackhole job ends terminal with job.failed (not stuck running)",
      dj?.status === "failed" && dsteps.some((s) => s.event === "job.failed" || s.event === "sections.failed"),
      `status=${String(dj?.status)} steps=${dsteps.map((s) => s.event).join(",")}`,
    );
    await call(`/api/jobs/${deadId}`, { method: "DELETE" }, cookie);
  }
}

// 5) rate limit: keep enqueueing until the 11th is refused (plan: 10/hour/session)
if (rateLimitRun) {
  let enqueued = 1; // job 'a' above counts toward the hour
  let limited = false;
  let limitedCode = "";
  const cap = Date.now() + 600_000;
  while (Date.now() < cap) {
    const r = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", maxSections: 1 }) }, cookie);
    if (r.status === 429 && code(r) === "RATE_LIMITED") {
      limited = true;
      limitedCode = code(r);
      break;
    }
    if (r.status === 429 && code(r) === "BUSY") {
      await sleep(1500);
      continue;
    }
    if (r.status !== 202) {
      limitedCode = `unexpected HTTP ${r.status} ${code(r)}`;
      break;
    }
    enqueued++;
    // wait for this job to finish before the next enqueue
    const id = String(r.body?.id);
    while (Date.now() < cap) {
      const j = await call(`/api/jobs/${id}`, {}, cookie);
      const st = (j.body?.status as string) ?? "";
      if (["done", "partial", "failed"].includes(st)) break;
      await sleep(1500);
    }
  }
  check(
    "rate-limited: hourly cap trips with 429 RATE_LIMITED",
    limited,
    `limited=${limited} (${limitedCode}) after ${enqueued} loop enqueues (quota also consumed by earlier suite jobs)`,
  );
}

const failed = results.filter((r) => !r.pass);
fs.mkdirSync("design/qa", { recursive: true });
fs.writeFileSync("design/qa/api-states.json", JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
console.log(failed.length === 0 ? `API STATES: ALL ${results.length} PASS` : `API STATES FAILURES: ${failed.map((f) => f.name).join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
