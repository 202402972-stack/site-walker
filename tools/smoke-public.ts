// M7 post-deploy smoke test — run this against the public Railway URL.
//
// Usage (PowerShell):
//   $env:BASE = "https://<your-domain>.up.railway.app"
//   $env:SW_TOKEN = "<ADMIN_TOKEN you set in Railway>"
//   npx tsx tools/smoke-public.ts
//
// Closes what can be closed from outside: A1 (outbound HTTPS from the deployed
// container — the job must reach example.com), A6/A7 on the public URL,
// product pages, job lifecycle, ZIP. A8: prints the job's peak container memory
// when the platform reports it (Linux cgroup); otherwise check Railway metrics.
import fs from "node:fs";

const base = (process.env.BASE ?? "").replace(/\/$/, "");
const token = process.env.SW_TOKEN ?? "";
if (!base || !token) {
  console.error("BASE and SW_TOKEN are required. See header comment.");
  process.exit(2);
}

interface Res {
  status: number;
  body: Record<string, unknown> | null;
  cookie: string;
  text: string;
}
const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  results.push({ name, pass, detail });
}
async function call(pathname: string, init: RequestInit = {}, cookie?: string): Promise<Res> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  const r = await fetch(base + pathname, { ...init, headers });
  const text = await r.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* html */
  }
  const cookieHeader = r.headers.getSetCookie().find((c) => c.startsWith("sw_session="))?.split(";")[0] ?? "";
  return { status: r.status, body, cookie: cookieHeader, text };
}
const code = (r: Res): string => ((r.body?.error as { code?: string } | undefined)?.code ?? "") as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`smoke target: ${base}\n`);

const health = await call("/healthz");
check("healthz", health.status === 200 && health.body?.ok === true, JSON.stringify(health.body));

const landing = await call("/");
check("landing serves with prerendered content", landing.status === 200 && landing.text.includes("<h1") && landing.text.includes("Site Walker"), `HTTP ${landing.status} ${Math.round(landing.text.length / 1024)}KB`);

const appPage = await call("/app");
check("console entry serves", appPage.status === 200, `HTTP ${appPage.status}`);

const robots = await call("/robots.txt");
check("robots.txt + sitemap", robots.status === 200 && robots.text.includes("Sitemap:"), robots.text.split("\n")[0]);

const cfg = await call("/api/config");
check("public config", cfg.status === 200 && cfg.body?.product === "Site Walker", `product=${String(cfg.body?.product)} maxSections=${String(cfg.body?.maxSections)}`);

const unauth = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com" }) });
check("A7: unauthenticated job POST → 401", unauth.status === 401, `HTTP ${unauth.status}`);

const login = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
check("login with ADMIN_TOKEN", login.status === 200 && login.cookie.startsWith("sw_session="), `HTTP ${login.status}`);
const cookie = login.cookie;
if (!cookie) {
  console.log("\nCannot continue without a session. If login failed: check SW_TOKEN matches ADMIN_TOKEN.");
  process.exit(1);
}

for (const [label, url] of [
  ["loopback", "http://127.0.0.1/"],
  ["metadata", "http://169.254.169.254/"],
  ["internal", "http://x.railway.internal/"],
] as const) {
  const r = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }, cookie);
  check(`A6: ${label} blocked on the public URL → 403`, r.status === 403 && code(r) === "URL_BLOCKED", `HTTP ${r.status} ${code(r)}`);
}

const create = await call("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", maxSections: 1, format: "webp" }) }, cookie);
check("start real job", create.status === 202, `HTTP ${create.status}`);
const id = String(create.body?.id ?? "");
if (!id) process.exit(1);

const t0 = Date.now();
let job: Record<string, unknown> | null = null;
while (Date.now() - t0 < 180_000) {
  await sleep(3000);
  const r = await call(`/api/jobs/${id}`, {}, cookie);
  if (["done", "partial", "failed"].includes(String(r.body?.status))) {
    job = r.body;
    break;
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const sections = (job?.sections as { file?: string; bytes?: number; width?: number; height?: number }[] | undefined) ?? [];
// A1: the container reached example.com over HTTPS and rendered it — outbound egress works.
check("A1: deployed container reached example.com (outbound HTTPS)", job?.status === "done" && sections.length === 1, `status=${String(job?.status)} in ${secs}s, ${sections.length} section(s) ${sections[0]?.width}x${sections[0]?.height}`);
const peak = Number(job?.peakMemoryMB ?? 0);
check("A8: peak container memory reported", peak > 0, peak > 0 ? `${peak} MB (guard ${String(cfg.body?.memGuardMb)} MB)` : "not reported on this platform — read it from Railway metrics (expect < 460 MB)");

if (sections[0]?.file) {
  const shot = await fetch(`${base}/api/jobs/${id}/shots/${sections[0].file}`, { headers: { cookie } });
  check("shot downloads on the public URL", shot.status === 200, `HTTP ${shot.status}`);
}
const zip = await fetch(`${base}/api/jobs/${id}/download.zip`, { headers: { cookie } });
check("ZIP downloads on the public URL", zip.status === 200 && Number(zip.headers.get("content-length") ?? 0) > 0, `HTTP ${zip.status} ${zip.headers.get("content-length")}B`);
await call(`/api/jobs/${id}`, { method: "DELETE" }, cookie);

const failed = results.filter((r) => !r.pass);
fs.mkdirSync("design/qa", { recursive: true });
fs.writeFileSync("design/qa/smoke-public.json", JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
console.log(failed.length === 0 ? `SMOKE: ALL ${results.length} PASS` : `SMOKE FAILURES (${failed.length}/${results.length}): ${failed.map((f) => f.name).join(" | ")}`);
process.exit(failed.length === 0 ? 0 : 1);
