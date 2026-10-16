# AT audit — token-level evidence recorded 2026-10-16. Rendered-page recheck required in M6.

| ID | Check | Result |
| --- | --- | --- |
| AT-01 | Inter as brand/body/UI font? | **EXCEPTION + evidence:** measured reference uses Inter for all body/UI text (tokens: `p`/`button`/`input` = Inter 13–14px; `document.fonts` shows Inter + Inter Variable loaded). Bounded to product UI by owner's §1 instruction (match reference). Display font is NOT Inter (Waldenburg → Archivo substitute). |
| AT-02 | Purple/violet/indigo dominant or main CTA? | No purple measured so far (page #FDFCFC, black text, blue→green quote gradient). **PENDING** full component sampling in M4 + rendered recheck. Add none of our own. |
| AT-03 | Blue-purple-pink gradients, glows, neon, dark glowing default | Measured accent is a blue→green quote gradient (`--quote-gradient`), reproduced as-is. **PENDING** rendered recheck; add none of our own. |
| AT-04 | Stock hero package | **PASS** by design (hero is real console/log replay). Re-check rendered. |
| AT-05 | Identical icon cards / decorative bento | **PASS** by design (varied structures). Re-check rendered. |
| AT-06 | Decorative emoji/sparkles/orbs/glass/floating badges | None specified. **PENDING** rendered check: remove anything not measured. |
| AT-07 | Generic headline filler | Copy in §9.2 is specific. **PENDING** line-by-line rendered check. |

Evidence: design/tokens-*.json + design/ref/*.png + design/tokens.md.
Font substitution: tokens.md (Waldenburg → Archivo provisional, M6 side-by-side).
