# AT audit — token-level evidence 2026-10-16, rendered-page check 2026-10-17 (design/qa/*.png).

| ID | Check | Result |
| --- | --- | --- |
| AT-01 | Inter as brand/body/UI font? | **EXCEPTION + evidence:** measured reference uses Inter for all body/UI text (tokens: `p`/`button`/`input` = Inter 13–14px; `document.fonts` shows Inter loaded). Bounded to product UI by owner's §1 instruction. Display = Archivo substitute, not Inter. Rendered check confirms. |
| AT-02 | Purple/violet/indigo dominant or main CTA? | **PASS.** Rendered page: black/white/warm neutrals only; no purple anywhere. |
| AT-03 | Blue-purple-pink gradients, glows, neon, dark glowing default | **PASS.** No gradients/glows added; only measured blue→green quote gradient exists inside gallery *content* (real capture pixels, not styling). |
| AT-04 | Stock hero package | **PASS.** Hero is the real console/log replay with labeled run target + date. |
| AT-05 | Identical icon cards / decorative bento | **PASS.** Varied structures: log timeline, numbered steps, gallery, table, definition list, FAQ dl. |
| AT-06 | Decorative emoji/sparkles/orbs/glass/floating badges | **PASS.** None present on rendered page. |
| AT-07 | Generic headline filler | **PASS.** Every headline names audience/outcome/mechanism (verified line by line on rendered page). |

Evidence: design/tokens-*.json + design/ref/*.png + design/tokens.md.
Font substitution: tokens.md (Waldenburg → Archivo provisional, M6 side-by-side).

## Frontend upgrade recheck (2026-10-16, this session)

New components (badges, progress, cards, stats, sticky nav, lightbox, FAQ accordions,
reveal-on-scroll) reuse token values only — no new palette, no gradients, no Inter
beyond the AT-01 exception, no emoji/decoration. Rendered check: axe 0 violations
(`/` 45 checks, `/app` 30), visual QA 0px overflow at 1440/834/390, full landing
+ console gate + live console journey (14/14: gate → idle → live → detach →
history → reopen → lightbox → ZIP → delete) reviewed as screenshots.
Reveal is progressive enhancement (visible by default, `html.js`-gated) so prerender,
no-JS, and full-page captures never show blank sections. All AT-01…AT-07 remain PASS
(AT-01 EXCEPTION as before).

## Login feature (2026-10-16, owner chose full scope with documented risks)

Rendered check: new `#login` section + console login fieldset reuse token styles only —
no new palette, no gradients, no decoration. Axe still 0 violations both routes, QA
0px overflow all viewports. Verified: unit 6/6, fixture 6/6 live, API 8/8 live
(same-site guard message exact, password absent from job.json). AT-01…AT-07 PASS.

## Login agent v2 — hardening pass (2026-10-17)

Rewritten as a bounded multi-step loop with a blocker/embedded challenge split
(no policy change in what is automated vs. reported — the widget line holds):

- `server/agent/login.ts` = orchestrator (≤ 3 submits, 90 s budget when wired to a
  job, cred-free `trail` on every result); `server/agent/login/forms.ts` = layered
  field discovery + human-like typing + 4 submit strategies + MFA/lockout/SSO
  detectors; `server/agent/login/challenges.ts` + `markers.ts` = blocker
  classification (managed/hard/interactive) with a self-clear wait.
- New outcome codes: `MFA_REQUIRED`, `SSO_REDIRECT`, `LOGIN_BLOCKED` (joined
  `LOGIN_NO_FORM` / `LOGIN_FAILED` / `BOT_CHALLENGE`). SSO detection ignores
  www./m./same-base-domain variants, so ordinary subdomain redirects cannot read
  as provider hand-offs.
- Verified: unit 15/15 (incl. embed-vs-blocker table, SSO false-positive cases),
  fixture 12/12 live real-browser (all outcome codes exercised in-fixture, incl.
  a self-clearing interstitial completing a real login), API 8/8 live against the
  rebuilt server. Frontend unchanged this pass — axe/QA evidence from 2026-10-16
  stands. AT-01…AT-07 PASS.

## Login agent v3 + saved sessions (2026-10-17)

- v3: frame-aware discovery (`server/agent/login/frames.ts` — iframe-hosted forms,
  capped at 8 frames), shadow-DOM piercing (Playwright locators + a deep-text
  walker for challenge/signal detection), adaptive post-submit settle (URL change /
  password-field-count change ends the wait; quiet exit otherwise), human-ish
  interaction (hover + mouse path + jitter before clicks, key-by-key typing),
  phone (`type=tel`) logins, `<div role=button>` submits, multilingual markers
  (ar/fr/de/es), IDP list extended.
- Saved sessions (`server/jobs/sessions.ts` + `/api/sessions*`): the human-in-the-
  loop answer to CAPTCHA — owner signs in once in their own browser and imports
  the cookies; runs for that origin start with the session. AES-256-GCM at rest
  (scrypt key from SESSION_SECRET), host-filtered imports, size cap, 14-day
  retention with boot+hourly pruning, console UI (list/import/delete, paste
  cleared after import), jobs save/refresh the session after a successful login.
- Verified this pass: unit 36/36 (5 files), fixture 19/19 live real-browser
  (incl. saved-session replay into a real context and in-frame fill @f1), API
  13/13 live (incl. host-filtered import, ciphertext-at-rest scan, delete),
  axe 0 violations both routes, QA 0px overflow all viewports (console includes
  the new Saved-sessions section). AT-01…AT-07 PASS.

## CAPTCHA policy — the line, restated (2026-10-17)

Maximum honest effort, no false promises:
- Never clicked, solved, ticked, or bypassed: widgets are left untouched even when
  embedded in the site's own form; full-page interstitials only get a bounded
  self-clear wait. No solver integrations, no fingerprint-spoofing suites, no
  fake-human attestations.
- What IS done: realistic interaction (mouse paths, typing rhythm, adaptive
  settle), managed-challenge self-clear waits with pointer activity, challenge
  widgets inside the site's form never blocking the run, and saved-session replay
  so a human's single solve stays solved for automated runs.
- Everything else reports a labeled code and is verified in the console log
  first — never faked into a "successful" capture.
