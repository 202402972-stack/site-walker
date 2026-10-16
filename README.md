# Site Walker

Paste a URL → real Chromium walks the site → one full-page screenshot per section, live in the landing page. `PRODUCT_NAME` in `server/config.ts` controls the name everywhere.

## Where to start

- `server/config.ts` — limits (single source of truth)
- `server/agent/` — browser, discovery (§7.2), capture (§7.3)
- `server/ssrf.ts` — SSRF guard (§8.1), applied to entry URL + every Chromium request
- `tools/run-agent.ts` — M1 CLI: `npm run agent:run -- --url https://example.com`
- `tools/extract-design.ts` — Phase 0: `npm run extract-design -- <reference-url>`

## Commands

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm run agent:run -- --url https://abdelhamednada.vercel.app --viewport desktop --format webp
npm run extract-design -- https://join.elevenlabs.io/agents/architect
npm test
```

## Env (names only — values in Railway, never committed)

`ADMIN_TOKEN SESSION_SECRET DATA_DIR MAX_SECTIONS MAX_JOB_SECONDS MAX_PAGE_HEIGHT NAV_WAIT_MS MEM_GUARD_MB RETENTION_HOURS PUBLIC_BASE_URL`

## Known limits (honest)

- Railway Free: 0.5 GB RAM/container. One job at a time, lazy browser, memory guard. If A8 fails → recommend Hobby.
- DNS-rebinding residual risk: no egress rules on Railway — stated, not hidden.
- Login-walled / bot-protected sites cannot be captured.
- Fonts: if reference font is not openly licensed, substitute by metrics and record it.

## AT audit

`design/audit.md` — AT-01…AT-07 PASS/REPLACE/EXCEPTION + evidence on the rendered page.
