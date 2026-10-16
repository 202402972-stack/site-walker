# Design tokens — measured from https://join.elevenlabs.io/agents/architect (2026-10-16)
Source: `tools/extract-design.ts` → `design/tokens-{desktop,tablet,mobile}.json` + `design/ref/*.png`.
Every UI value in `web/src/tokens.css` must come from this file. No eyeballed numbers.

## Type roles (family | size/line | weight)

| Role | Desktop 1440 | Tablet 834 | Mobile 390 |
| --- | --- | --- | --- |
| Display H1 (Waldenburg Buch → substitute) | 44px / 52.8px, w375 | 40px / 48px, w375 | 26px / 31.2px, w375 |
| Section H2 (Waldenburg Normal → substitute) | 28px / 37.8px, w400 | 22px / 29.7px, w400 | 16px / 21.6px, w400 |
| Body (Inter 400) | 14px / 21px | 14px / 21px | 14px / 21px |
| Button / input (Inter 400) | 13px / 16.9px | 13px / 16.9px | 12px / 15.6px |

Letter-spacing: normal everywhere measured. Text color: `rgb(0,0,0)` on light, `rgb(255,255,255)` on dark.

## Color roles

| Role | Value (measured) |
| --- | --- |
| Page background | `rgb(253,252,252)` (≈ #FDFCFC, warm near-white) |
| Surface cards | light warm gray (sampled from captures; re-measure per component) |
| Text primary | `rgb(0,0,0)` |
| Text on dark | `rgb(255,255,255)` |
| Border (inputs) | `1px solid rgb(223,222,222)` |
| Quote accent gradient | `linear-gradient(90deg, #489FD3 30%, #5F8E65 65%)` (only `--*` var on `:root`) |

## Spacing / layout

Container/padding per breakpoint and section rhythm to be read off `design/ref/*.png` during M4 build and recorded here before use. Do not guess.

## Radii / borders / shadows

- Pill CTAs/links: `border-radius: 9999px`, padding `0 14px`, gap `8px`
- Inputs: `border-radius: 8px` (split phone field `8px 0 0 8px`), border `1px #DFDEDE`
- Buttons: `border-radius: 8px`, transitions below
- Shadows: none measured on sampled elements (`box-shadow: none`)

## Motion (measured vars + keyframes)

`--anim-duration-fast: 400ms`, `--anim-duration-base: 600ms`, `--anim-duration-slow: 800ms`,
`--anim-delay-stagger: 80ms`, `--anim-ease-out: cubic-bezier(0.22,1,0.36,1)`,
`--anim-ease-in-out: cubic-bezier(0.45,0,0.55,1)`, `--anim-translate-sm: 12px`, `--anim-translate-md: 24px`.
Keyframes: `lrBarIn` (scaleY reveal), `lrLetterIn` (fade). Breakpoints: 767 / 991 / 1199px.
`prefers-reduced-motion` and `hover:hover/none` rules present → M4 must keep equivalents.
Note: desktop run did not surface the `--anim-*` vars (cross-origin stylesheet wall); tablet/mobile did. Values identical on both.

## Fonts — decision (recorded, verification pending)

- **Inter (body/UI): KEEP.** OFL-licensed, self-host via Fontsource with `font-display: swap`. Reference uses it for all UI — AT-01 EXCEPTION evidence.
- **KMR Waldenburg Buch/Normal (display/headings): SUBSTITUTE.** Commercial family (KMR), no open license → cannot embed.
  Provisional substitute: **Archivo** (OFL, grotesque skeleton, variable 100–900 covers measured 375/400/700).
  Verification required in M6: rendered side-by-side vs `design/ref/` (x-height, width, weight match); owner sign-off per A14. If metrics mismatch, fall back to measured comparison of alternatives.
- `@font-face` source URLs / license files not yet extracted (cross-origin CSS wall) — fetch CSS by URL before M4 font wiring.

## Known intentional differences (not hidden)

Own name/logo/copy; substituted display font (above); sample-run imagery is our own captures.
