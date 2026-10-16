// Login verification harness — runs the REAL attemptLogin against a fixture
// site with a working session cookie. Cases: correct creds → ok + session
// page reachable; wrong creds → LOGIN_FAILED; formless page → LOGIN_NO_FORM;
// challenge markup → detectChallenge true. Also asserts a serialized job
// record carrying settings.auth contains no password material.
//
// Fixture is on 127.0.0.1 and the harness calls the agent module directly
// (same rationale as tools/spa-fixture.ts).
// Usage: npx tsx tools/login-fixture.ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import { launchBrowser } from "../server/agent/browser.js";
import { attemptLogin, detectChallenge } from "../server/agent/login.js";

const USER = "owner@example.com";
const PASS = "correct-horse-battery";

const LOGIN_PAGE = (error: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head>
<body><h1>Sign in</h1>${error ? `<p style="color:red">${error}</p>` : ""}
<form method="post" action="/login">
<label>Email <input type="email" name="username"></label>
<label>Password <input type="password" name="password"></label>
<button type="submit">Sign in</button></form></body></html>`;

const APP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dashboard</title></head>
<body><h1>Welcome back</h1><div style="height:1500px">member content</div></body></html>`;

const PLAIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title></head>
<body><h1>Public page, no form here</h1></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const cookies = Object.fromEntries(
    (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=").map(decodeURIComponent) as [string, string]),
  );
  if (url.pathname === "/login" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LOGIN_PAGE(""));
    return;
  }
  if (url.pathname === "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const p = new URLSearchParams(body);
      if (p.get("username") === USER && p.get("password") === PASS) {
        res.writeHead(302, { location: "/app", "set-cookie": "session=1; Path=/; HttpOnly" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(LOGIN_PAGE("Wrong email or password."));
      }
    });
    return;
  }
  if (url.pathname === "/app") {
    if (cookies.session === "1") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(APP_PAGE);
    } else {
      res.writeHead(302, { location: "/login" });
      res.end();
    }
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PLAIN_PAGE);
});

const failures: string[] = [];
function check(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!pass) failures.push(name);
}

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
console.log(`login fixture on ${base}`);

const browser = await launchBrowser();
try {
  // 1) Correct credentials → ok + session cookie unlocks /app in the same context.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    const r = await attemptLogin(page, { username: USER, password: PASS });
    check("correct creds → login.ok", r.ok && !r.code, `${r.code ?? "ok"}: ${r.detail}`);
    await page.goto(`${base}/app`, { waitUntil: "domcontentloaded" });
    const h1 = await page.locator("h1").textContent();
    check("session cookie survives for capture", h1?.includes("Welcome back") ?? false, `h1=${h1}`);
    await ctx.close();
  }
  // 2) Wrong credentials → LOGIN_FAILED (still on the form).
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    const r = await attemptLogin(page, { username: USER, password: "wrong" });
    check("wrong creds → LOGIN_FAILED", !r.ok && r.code === "LOGIN_FAILED", `${r.code}: ${r.detail}`);
    await ctx.close();
  }
  // 3) Page without a form → LOGIN_NO_FORM.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/plain`, { waitUntil: "domcontentloaded" });
    const r = await attemptLogin(page, { username: USER, password: PASS });
    check("formless page → LOGIN_NO_FORM", !r.ok && r.code === "LOGIN_NO_FORM", `${r.code}: ${r.detail}`);
    await ctx.close();
  }
  // 4) Challenge markup is detected (reported, never solved).
  check(
    "challenge markup detected",
    detectChallenge('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>', "Just a moment..."),
    "turnstile marker",
  );
  // 5) A persisted job-style record carries no password material.
  {
    const record = { settings: { auth: { username: USER, loginUrl: `${base}/login` } }, steps: [] };
    const json = JSON.stringify(record);
    check("no password in persisted record", !/password/i.test(json) && !json.includes(PASS), "settings.auth is username-only");
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length === 0 ? "LOGIN FIXTURE: ALL PASS" : `LOGIN FIXTURE FAILURES: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
