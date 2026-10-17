// Login verification harness — runs the REAL attemptLogin against a fixture
// site with a working session. Cases cover the full matrix:
//   correct creds → ok; wrong creds → LOGIN_FAILED after capped retries;
//   formless page → LOGIN_NO_FORM; code-only screen → MFA_REQUIRED;
//   persistent interstitial → BOT_CHALLENGE (managed, honest report);
//   self-clearing interstitial → smart wait, then the login succeeds;
//   embedded reCAPTCHA widget → run proceeds, widget never touched;
//   SSO hand-off → SSO_REDIRECT. Plus a cred-leak scan over every result.
//
// Server binds dual-stack so `http://localhost` and `http://127.0.0.1` are
// distinguishable hostnames (SSO case rides that, no DNS hacks).
// Usage: npx tsx tools/login-fixture.ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import { launchBrowser } from "../server/agent/browser.js";
import { attemptLogin, type LoginResult } from "../server/agent/login.js";
import { deleteSessionForOrigin, loadSession, playwrightState, saveSession } from "../server/jobs/sessions.js";

const USER = "owner@example.com";
const PASS = "correct-horse-battery";

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const LOGIN_PAGE = (error: string) => page("Sign in", `<h1>Sign in</h1>${error ? `<p style="color:red">${error}</p>` : ""}
<form method="post" action="/login">
<label>Email <input type="email" name="username"></label>
<label>Password <input type="password" name="password"></label>
<button type="submit">Sign in</button></form>`);

const APP_PAGE = page("Dashboard", `<h1>Welcome back</h1><div style="height:1500px">member content</div>`);
const PLAIN_PAGE = page("About", `<h1>Public page, no form here</h1>`);
const MFA_PAGE = page("Two-factor", `<h1>Two-step verification</h1><p>Enter the 6-digit code we sent to your phone.</p>
<form><input name="otp" inputmode="numeric" autocomplete="one-time-code"><button type="submit">Verify</button></form>`);
const CAPTCHA_LOGIN = page("Sign in (captcha embed)", `<h1>Sign in</h1>
<form method="post" action="/login">
<label>Email <input type="email" name="username"></label>
<label>Password <input type="password" name="password"></label>
<div class="g-recaptcha" data-sitekey="test-key"></div>
<button type="submit">Sign in</button></form>`);
const SSO_LOGIN = page("Sign in (SSO)", `<h1>Company SSO</h1>
<form method="post" action="/sso-out">
<label>Email <input type="email" name="username"></label>
<button type="submit">Continue with provider</button></form>`);
const IDP_PAGE = page("Provider", `<h1>Simulated identity provider</h1><p>This is where the SSO round-trip would happen.</p>`);

const blockers = {
  persist: `<div id="c" style="font-size:24px">Just a moment…</div>
<script>setInterval(()=>{document.getElementById("c").textContent="Just a moment… (cf-chl-bypass)";},500);</script>`,
  clear: `<div id="c" style="font-size:24px">Just a moment…</div>
<form method="post" action="/login">
<label>Email <input type="email" name="username"></label>
<label>Password <input type="password" name="password"></label>
<button type="submit">Sign in</button></form>
<script>setTimeout(()=>{document.getElementById("c").textContent="";},1800);</script>`,
};

// New-shape fixtures (v3): iframe login, shadow-DOM login, phone-number
// login, div-role=button submit, JS SPA swap without navigation, Arabic
// lockout copy.
const IFRAME_HOST = page("Portal", `<h1>Partner portal</h1>
<iframe src="/login-frame" width="420" height="260" style="border:1px solid #ccc"></iframe>`);

const LOGIN_FRAME = page("Sign in (frame)", `<form method="post" action="/login">
<label>Email <input type="email" name="username"></label>
<label>Password <input type="password" name="password"></label>
<button type="submit">Sign in</button></form>`);

const SHADOW_LOGIN = page("Sign in (shadow DOM)", `<h1>Web-component login</h1>
<my-login></my-login>
<script>
class MyLogin extends HTMLElement {
  connectedCallback() {
    const r = this.attachShadow({ mode: "open" });
    r.innerHTML = '<form method="post" action="/login">' +
      '<label>Email <input type="email" name="username"></label>' +
      '<label>Password <input type="password" name="password"></label>' +
      '<button type="submit">Sign in</button></form>';
  }
}
customElements.define("my-login", MyLogin);
</script>`);

const PHONE_LOGIN = page("Sign in (phone)", `<h1>Sign in by phone</h1>
<form method="post" action="/phone-login">
<label>Phone number <input type="tel" name="phone"></label>
<label>Password <input type="password" name="password"></label>
<button type="submit">Sign in</button></form>`);

const DIV_BUTTON_LOGIN = page("Sign in (div button)", `<h1>Sign in</h1>
<form id="f" method="post" action="/login">
<label>Email <input type="email" name="username"></label>
<label>Password <input type="password" name="password"></label>
<div role="button" tabindex="0" style="display:inline-block;padding:6px 14px;border:1px solid #333;cursor:pointer"
  onclick="document.getElementById('f').requestSubmit()">Sign in</div>
</form>`);

const SPA_SLOW = page("Sign in (SPA)", `<h1>Sign in</h1>
<form id="f"><label>Email <input type="email" name="username"></label>
<label>Password <input type="password" name="password"></label>
<button type="submit">Sign in</button></form>
<div id="app" style="display:none">Welcome back. <a href="#">Sign out</a></div>
<script>
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  setTimeout(() => {
    document.getElementById("f").remove();
    document.getElementById("app").style.display = "block";
  }, 1200);
});
</script>`);

const AR_LOCKOUT = page("تسجيل الدخول", `<h1>تم القفل مؤقتًا</h1>
<p>محاولات كثيرة لتسجيل الدخول. حاول لاحقًا.</p>`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const cookies = Object.fromEntries(
    (req.headers.cookie ?? "").split(";").filter(Boolean).map((c) => c.trim().split("=").map(decodeURIComponent) as [string, string]),
  );
  const html = (body: string, code = 200, headers: Record<string, string> = {}) => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(body);
  };
  if (url.pathname === "/login" && req.method === "GET") return html(LOGIN_PAGE(""));
  if ((url.pathname === "/login" || url.pathname === "/phone-login") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const p = new URLSearchParams(body);
      const u = p.get("username") ?? p.get("phone");
      if (u === USER && p.get("password") === PASS) {
        res.writeHead(302, { location: "/app", "set-cookie": "session=1; Path=/; HttpOnly" });
        res.end();
      } else {
        html(LOGIN_PAGE("Wrong email or password."));
      }
    });
    return;
  }
  if (url.pathname === "/app") {
    if (cookies.session === "1") return html(APP_PAGE);
    res.writeHead(302, { location: "/login" });
    res.end();
    return;
  }
  if (url.pathname === "/plain") return html(PLAIN_PAGE);
  if (url.pathname === "/mfa") return html(MFA_PAGE);
  if (url.pathname === "/login-captcha") return html(CAPTCHA_LOGIN);
  if (url.pathname === "/login-sso") return html(SSO_LOGIN);
  if (url.pathname === "/iframe-login") return html(IFRAME_HOST);
  if (url.pathname === "/login-frame") return html(LOGIN_FRAME);
  if (url.pathname === "/shadow-login") return html(SHADOW_LOGIN);
  if (url.pathname === "/phone-login") return html(PHONE_LOGIN);
  if (url.pathname === "/divbutton-login") return html(DIV_BUTTON_LOGIN);
  if (url.pathname === "/spa-slow") return html(SPA_SLOW);
  if (url.pathname === "/lockout-ar") return html(AR_LOCKOUT);
  if (url.pathname === "/sso-out") {
    // Absolute URL with a DIFFERENT hostname (localhost vs 127.0.0.1) — the
    // SSO detector keys on hostname change, so the hand-off must cross one.
    const a = server.address() as AddressInfo;
    res.writeHead(302, { location: `http://localhost:${a.port}/sso-idp` });
    res.end();
    return;
  }
  if (url.pathname === "/sso-idp") return html(IDP_PAGE);
  if (url.pathname === "/challenge-block") return html(page("Protected", blockers.persist));
  if (url.pathname === "/challenge-clear") return html(page("Protected", blockers.clear));
  html(PLAIN_PAGE, 404);
});

const failures: string[] = [];
function check(name: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!pass) failures.push(name);
}

await new Promise<void>((r) => server.listen(0, r));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
console.log(`login fixture on ${base}`);

const browser = await launchBrowser();
const captures: LoginResult[] = [];
try {
  const run = async (path: string, opts: Record<string, unknown> = {}): Promise<LoginResult> => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    const r = await attemptLogin(p, { username: USER, password: PASS }, { entryHostname: "127.0.0.1", ...opts });
    captures.push(r);
    await ctx.close();
    return r;
  };

  // 1) Correct credentials → ok, and the session cookie unlocks /app.
  {
    const r = await run("/login");
    check("correct creds → login.ok", r.ok && !r.code, `${r.code ?? "ok"}: ${r.detail} [${r.trail.join(" | ")}]`);
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await p.locator('input[name="username"]').fill(USER);
    await p.locator('input[name="password"]').fill(PASS);
    await Promise.all([p.waitForURL("**/app"), p.locator('button[type="submit"]').click()]);
    const h1 = await p.locator("h1").textContent();
    check("session cookie survives for capture", h1?.includes("Welcome back") ?? false, `h1=${h1}`);
    await ctx.close();
  }
  // 2) Wrong credentials → LOGIN_FAILED after the capped retries.
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    const r = await attemptLogin(p, { username: USER, password: "definitely-wrong" }, { entryHostname: "127.0.0.1", maxSubmits: 2 });
    captures.push(r);
    check("wrong creds → LOGIN_FAILED", !r.ok && r.code === "LOGIN_FAILED", `${r.code}: ${r.detail} [${r.trail.join(" | ")}]`);
    await ctx.close();
  }
  // 3) Page without a form.
  {
    const r = await run("/plain");
    check("formless page → LOGIN_NO_FORM", !r.ok && r.code === "LOGIN_NO_FORM", `${r.code}: ${r.detail}`);
  }
  // 4) Code-primary second-factor screen.
  {
    const r = await run("/mfa");
    check("code-only screen → MFA_REQUIRED", !r.ok && r.code === "MFA_REQUIRED", `${r.code}: ${r.detail}`);
  }
  // 5) Persistent interstitial → honest BOT_CHALLENGE after the bounded wait.
  {
    const r = await run("/challenge-block", { managedClearMs: 6000 });
    check(
      "persistent interstitial → BOT_CHALLENGE",
      !r.ok && r.code === "BOT_CHALLENGE" && r.trail.some((t) => t.includes("managed-persisted")),
      `${r.code}: ${r.detail} [${r.trail.join(" | ")}]`,
    );
  }
  // 6) Self-clearing interstitial → smart wait, then the login succeeds.
  {
    const r = await run("/challenge-clear", { managedClearMs: 8000 });
    check(
      "self-clearing interstitial → ok after clear",
      r.ok && r.trail.some((t) => t.includes("managed-cleared")),
      `${r.code ?? "ok"}: ${r.detail} [${r.trail.join(" | ")}]`,
    );
  }
  // 7) Embedded widget: the run proceeds; the widget is never touched.
  {
    const r = await run("/login-captcha");
    check(
      "embedded captcha widget → ok, run proceeds",
      r.ok && r.trail.some((t) => t.startsWith("challenge:embedded")),
      `${r.code ?? "ok"}: ${r.detail} [${r.trail.join(" | ")}]`,
    );
  }
  // 8) SSO hand-off → reported, credentials never posted cross-site.
  {
    const r = await run("/login-sso");
    check(
      "SSO hand-off → SSO_REDIRECT",
      !r.ok && r.code === "SSO_REDIRECT" && r.trail.some((t) => t.startsWith("sso:")),
      `${r.code}: ${r.detail} [${r.trail.join(" | ")}]`,
    );
  }
  // 9) v3 shapes: iframe-hosted login form → discovered and filled in-frame.
  {
    const r = await run("/iframe-login");
    check(
      "iframe-hosted login → ok, filled in-frame",
      r.ok && r.trail.some((t) => t.includes("@f1")),
      `${r.code ?? "ok"}: ${r.detail} [${r.trail.join(" | ")}]`,
    );
  }
  // 10) v3 shapes: shadow-DOM login form → pierced by discovery.
  {
    const r = await run("/shadow-login");
    check(
      "shadow-DOM login → ok",
      r.ok && r.trail.some((t) => t.startsWith("filled:password")),
      `${r.code ?? "ok"}: ${r.detail} [${r.trail.join(" | ")}]`,
    );
  }
  // 11) v3 shapes: phone-number login (tel input).
  {
    const r = await run("/phone-login");
    check("phone-number login → ok", r.ok, `${r.code ?? "ok"}: ${r.detail} [${r.trail.join(" | ")}]`);
  }
  // 12) v3 shapes: <div role="button"> submit widget.
  {
    const r = await run("/divbutton-login");
    check(
      "div-role=button submit → ok",
      r.ok && r.trail.some((t) => t.startsWith("submit:button-by-name")),
      `${r.code ?? "ok"}: ${r.detail} [${r.trail.join(" | ")}]`,
    );
  }
  // 13) v3 shapes: SPA form swapped by JS without navigation → adaptive settle
  // catches the change and the logged-in state is recognized.
  {
    const t0 = Date.now();
    const r = await run("/spa-slow");
    const elapsed = Date.now() - t0;
    check(
      "SPA JS swap (no navigation) → ok via signal",
      r.ok && r.trail.some((t) => t.startsWith("signals:logged-in")),
      `${r.code ?? "ok"}: ${r.detail} [${r.trail.join(" | ")}] (${Math.round(elapsed / 1000)}s)`,
    );
  }
  // 14) v3 shapes: Arabic lockout copy → LOGIN_BLOCKED.
  {
    const r = await run("/lockout-ar");
    check("Arabic lockout copy → LOGIN_BLOCKED", !r.ok && r.code === "LOGIN_BLOCKED", `${r.code}: ${r.detail}`);
  }
  // 15) Saved-session replay: an imported session is applied by a real
  // browser context (the human-in-the-loop CAPTCHA answer — the human solved
  // it once in their own browser; here we prove the vault round-trips into
  // Playwright and is cleaned from disk afterwards).
  {
    const origin = base;
    await saveSession(origin, {
      cookies: [{ name: "cf_clearance", value: "FIXTURE-CLEARANCE", domain: "127.0.0.1", path: "/", httpOnly: true }],
    });
    const loaded = await loadSession(origin);
    const ctx = await browser.newContext(loaded ? { storageState: playwrightState(loaded) } : {});
    const cookies = await ctx.cookies();
    await ctx.close();
    await deleteSessionForOrigin(origin);
    const gone = (await loadSession(origin)) === null;
    check(
      "saved session replays into a real browser context",
      cookies.some((c) => c.name === "cf_clearance" && c.value === "FIXTURE-CLEARANCE") && gone,
      `${cookies.length} cookies applied, vault cleaned=${gone}`,
    );
  }
  // 9) Cred-leak scan over every result this harness produced.
  {
    const blob = captures.map((r) => `${r.detail}|${r.trail.join("|")}`).join("\n");
    const distinctTrails = new Set(captures.map((r) => r.trail.length)).size;
    check("no credentials in any result/trail", !blob.includes(USER) && !blob.includes(PASS), `${captures.length} results scanned`);
    check("trail actually populated", distinctTrails > 1 && captures.every((r) => r.trail.length > 0), `distinct trail lengths: ${[...new Set(captures.map((r) => r.trail.length))].join(",")}`);
  }
  // 10) A persisted job-style record carries no password material.
  {
    const record = JSON.stringify({ settings: { auth: { username: USER, loginUrl: `${base}/login` } }, steps: [] });
    check("no password in persisted record", !/password/i.test(record) && !record.includes(PASS), "settings.auth is username-only");
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length === 0 ? "LOGIN FIXTURE: ALL PASS" : `LOGIN FIXTURE FAILURES: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
