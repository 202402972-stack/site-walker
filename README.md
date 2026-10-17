# Site Walker

Paste a URL → real Chromium walks the site → one full-page screenshot per section, live in the landing page. `PRODUCT_NAME` in `server/config.ts` controls the name everywhere.

## Where to start

- `server/config.ts` — limits (single source of truth)
- `server/agent/` — browser, discovery (§7.2), capture (§7.3: wait, reveal pass, tiling, validation)
- `server/ssrf.ts` — SSRF guard (§8.1), applied to entry URL + every Chromium request
- `server/routes/` — auth (token login), jobs (CRUD + SSE + ZIP), config (public limits)
- `web/src/` — landing (`landing.tsx`, prerendered) + console (`console.tsx`), styles in `tokens.css` (all values from `design/tokens.md`)
- `tools/run-agent.ts` — M1 CLI: `npm run agent:run -- --url https://example.com`
- `tools/extract-design.ts` — Phase 0: `npm run extract-design -- <reference-url>`
- `tools/measure-bands.ts`, `tools/axe-check.ts`, `tools/visual-qa.ts` — A4/A11/A13 evidence
- `tools/spa-fixture.ts` — A5: real-browser SPA client-routing verification (fixture + capture pipeline)
- `tools/login-fixture.ts` — login loop verification (19 live checks: correct/wrong creds, no-form, MFA screen, persistent + self-clearing interstitials, embedded captcha widget, SSO hand-off, iframe, shadow-DOM, phone, div-button, SPA swap, Arabic lockout, saved-session replay, cred-leak scan)
- `tools/login-api-check.ts` — login + saved-session API checks (`SW_TOKEN=... npx tsx tools/login-api-check.ts [base]`)
- `tools/extract-fonts.ts` → `design/fonts.md` — reference @font-face evidence
- `tools/make-og.ts`, `tools/side-by-side.ts` — OG card generator + A14 side-by-side sheets (`design/qa/side-by-side-*.png`)
- `tools/api-state-test.ts` — §9.3 console states against a live server (`SW_TOKEN=... npx tsx tools/api-state-test.ts [base] [--rate-limit]`)
- `tools/smoke-public.ts` — post-deploy smoke on the Railway URL (A1/A6/A7/A8 evidence)

## Commands

```sh
npm ci
npx playwright install chromium
npm run typecheck && npm run typecheck:web
npm test
npm run build:all            # server + web + prerender (canonical build; Dockerfile uses this)
npm run dev:server           # needs ADMIN_TOKEN, SESSION_SECRET env
npm run agent:run -- --url https://example.com --viewport desktop --format webp
```

## Deploy (Railway — owner steps, ~15 min)

1. Railway → **New Project → Deploy from GitHub repo** → `202402972-stack/site-walker` (private is fine; grant Railway repo access). Builder is Dockerfile (`railway.json`), healthcheck `/healthz`.
2. Add a **Volume** mounted at `/data` (job store survives restarts + deploys).
3. Set service **Variables**: `ADMIN_TOKEN` (long random), `SESSION_SECRET` (long random), `DATA_DIR=/data`. Optional overrides: `MAX_SECTIONS`, `MAX_JOB_SECONDS`, `MAX_PAGE_HEIGHT`, `NAV_WAIT_MS`, `MEM_GUARD_MB`, `RETENTION_HOURS`, `PUBLIC_BASE_URL`.
4. **Networking → Generate Domain**, then set `PUBLIC_BASE_URL=https://<domain>` (canonical/OG/sitemap self-correct at boot either way) and redeploy.
5. Smoke-test the public URL from the repo:

```powershell
$env:BASE = "https://<domain>"; $env:SW_TOKEN = "<ADMIN_TOKEN>"
npx tsx tools/smoke-public.ts   # A1/A6/A7 on the public URL + prints A8 peak memory when reported
```

6. A8: Railway → service → Metrics, run a 12-section job, confirm peak memory < 460 MB (guard is 500 MB-class; Hobby if it exceeds).

## Login capture (owner decision 2026-10-16: full scope, risks documented here)

The console accepts optional per-run credentials for sites with a plain email +
password form. The agent fills and submits the form in the same real browser, then
captures with the resulting session. A failed login never blocks the run — it is
logged (`login.failed` + code) and capture continues with whatever is public.

Guarantees (tested in `tests/server/login.test.ts` + `tools/login-fixture.ts`):
- Passwords live in server memory only (`server/jobs/secrets.ts`), single-use, deleted
  on use. Never in `job.json`, logs, SSE, ZIP, or the API. `settings.auth` on disk holds
  username + login page only. The diagnostic trail records selector kinds, submit
  strategies, and signal names — never field values.
- A custom login page must share the entry URL's origin (enforced server-side, 400
  otherwise) — credentials can never be posted to an unrelated host.
- The login agent is a bounded multi-step loop (90 s budget, ≤ 3 form submits): it
  fills whatever screen appears — username-only first steps, user+password, phone
  logins, iframe-hosted forms (fields are discovered across every frame), shadow-DOM
  components, `<div role="button">` submits, and JS-only form swaps (the post-submit
  wait is adaptive: URL change / form appearing or vanishing ends it early) — with
  layered field discovery (accessible names → CSS → fallbacks), human-like typing and
  mouse paths, and five submit strategies. Wrong credentials fail honestly
  (`LOGIN_FAILED`).
- CAPTCHAs are split honestly: a challenge WIDGET inside the site's own form (reCAPTCHA
  box, Turnstile) never blocks the run — the site's fields are filled and the site's
  button pressed, and the provider decides (nothing is ticked or solved). A full-page
  interstitial ("Just a moment…", unusual-traffic walls) gets a bounded self-clear
  wait with gentle pointer activity, then reports `BOT_CHALLENGE` if it persists.
  Never bypassed, never faked.
- Second factors (`MFA_REQUIRED`), SSO hand-offs to external providers (`SSO_REDIRECT`,
  guarded against www/subdomain false positives), and lockout walls (`LOGIN_BLOCKED`,
  attempts stop instead of deepening the lockout) each report their own code —
  including non-English copy (Arabic/French/German/Spanish markers).

## Saved sessions — the human-in-the-loop answer to CAPTCHA

The strongest honest move for CAPTCHA-protected sites is to not fight the CAPTCHA:
the OWNER signs in once in their own browser (solving any challenge as a human),
exports the site's cookies (cookie-editor extension or a Playwright storageState
JSON), and imports them in the console. Every later run on that origin starts with
that session — the human step never repeats, and nothing is solved by the service.

- Storage: `DATA_DIR/sessions/<id>.json` — AES-256-GCM with a scrypt-derived key
  from `SESSION_SECRET`; metadata only in the clear. Listings, logs, jobs and the
  API never carry cookie values. Delete anytime in the console; sessions older than
  `SESSION_RETENTION_DAYS` (default 14) are pruned at boot and hourly.
- Imports are host-filtered: cookies whose domain does not belong to the site's own
  host are dropped (400 when none remain), and the payload is size-capped
  (`MAX_SESSION_BYTES`, default 256 KB).
- Sessions are saved/refreshed automatically after a successful password login, and
  when a saved session was used in a run (cookie rotation keeps them alive).
- Tests: `tests/server/sessions.test.ts` (encryption at rest, tamper fails closed,
  host filtering, pruning), fixture replay into a real browser context, and live
  API checks (`tools/login-api-check.ts`).

Accepted risks (owner's explicit call — do not silently widen this):
- Google and other big providers often flag server-IP sign-ins as suspicious; this can
  challenge or temporarily lock the account. Use a dedicated account, never a main one.
  The mechanism is generic form-fill — no per-provider solver exists or is promised.
- Credentials cross the network to the Railway container (TLS) and sit in its memory
  for seconds. Only run this against sites/accounts you own or may use.
- Saved sessions are live credentials: anyone with the token + server access can use
  them. They are encrypted with `SESSION_SECRET` (rotating it invalidates them) and
  pruned on a schedule — still, only import sessions you are willing to store.
- Unsupported shapes fail loudly with their reason — verify failures in the console
  log instead of assuming a capture is "logged in".

## Env (names only — values in Railway, never committed)

`ADMIN_TOKEN SESSION_SECRET DATA_DIR MAX_SECTIONS MAX_JOB_SECONDS MAX_PAGE_HEIGHT NAV_WAIT_MS MEM_GUARD_MB RETENTION_HOURS PUBLIC_BASE_URL SESSION_RETENTION_DAYS MAX_SESSION_BYTES`

Rotate `ADMIN_TOKEN`: set the new value in Railway variables and redeploy; sessions are HMAC-signed, old cookies die with `SESSION_SECRET` rotation. Roll back: Railway → Deployments → redeploy the last good deployment. Results are disposable (24 h retention).

## Known limits (honest)

- Railway Free: 0.5 GB RAM/container. One job at a time, lazy browser, memory guard. If A8 fails → recommend Hobby.
- DNS-rebinding residual risk: no egress rules on Railway — stated, not hidden.
- Login-walled / bot-protected sites cannot be captured; blank renders are reported, never delivered.
- Fonts: Waldenburg (commercial) substituted with Archivo (OFL); Inter kept (OFL). See `design/tokens.md`.
- `railway.json` uses Config-as-Code, deprecated by Railway but working until 2026-12-01; migrate to IaC later.

## AT audit

`design/audit.md` — AT-01 EXCEPTION (measured Inter) + evidence; AT-02…AT-07 PASS on the rendered page.

## HANDOFF (2026-10-17)

- State: M1 agent verified (reveal pass 39.6%→8.3% blank, count-ups render, element captures work), M2 API verified end-to-end (auth, SSRF 403s, SSE, shots, ZIP, DELETE, restart survival, retention sweep, login rate limit), M3 tokens extracted, M4 landing+console built from tokens with prerender, M5 real sample assets, M6 axe clean / QA clean / Lighthouse desktop 1.0.
- A5: SPA client-routing verified with a real-browser fixture (`tools/spa-fixture.ts` — pushState proven, late 800 ms content captured in-frame on all 4 routes; server-logged document requests for /about = 0). Static multi-page (sitemap descent) and one-pager (anchors + element close-ups) verified earlier against join.elevenlabs.io.
- §9.3 states: exercised live via `tools/api-state-test.ts` (gate 401, invalid 400, blocked 403, busy 429, streamed running → done, shots + ZIP, gone 404, rate-limited 429 after 10/hour). Orphaned jobs from a killed process are now marked failed at boot (`recoverStaleJobs`, unit-tested).
- A15: clean checkout verified from the GitHub repo into an empty directory — `npm ci` → typechecks → tests 8/8 → `build:all` → complete `web/dist`.
- Blocked on owner: Railway project + volume + env vars + domain (M0 container checks A1/A8, M7 deploy), fidelity side-by-side sign-off (A14). Portfolio/GitHub footer links not supplied.
- Next: deploy per §11.3, run `tools/smoke-public.ts` against the public URL, get A14 sign-off.
