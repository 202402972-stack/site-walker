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
