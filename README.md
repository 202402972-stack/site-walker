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

## Env (names only — values in Railway, never committed)

`ADMIN_TOKEN SESSION_SECRET DATA_DIR MAX_SECTIONS MAX_JOB_SECONDS MAX_PAGE_HEIGHT NAV_WAIT_MS MEM_GUARD_MB RETENTION_HOURS PUBLIC_BASE_URL`

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
- Blocked on owner: Railway project + volume + env vars + domain (M0 container checks A1/A8, M7 deploy), fidelity side-by-side sign-off (A14). Portfolio/GitHub footer links not supplied.
- Next: deploy per §11.3, run public-URL smoke test, get A14 sign-off.
