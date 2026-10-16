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
