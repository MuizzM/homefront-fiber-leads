/**
 * Design tokens the RUNTIME needs — the JS half of the design system.
 *
 * Scope, deliberately narrow: values that a Tailwind class cannot express
 * because JS builds the element. Mapbox popups, markers and canvas/SVG pins are
 * constructed outside React, so they cannot wear `bg-card` or `text-2xs`; until
 * now they re-typed the literal instead, which is how a palette drifts.
 *
 * THE RULE: every constant here has exactly one authority, named in its comment
 * — client/src/index.css for CSS custom properties, tailwind.config.ts for
 * theme scale entries, shared/statusConfig.ts for field-status colour. This
 * module MIRRORS those authorities; it never becomes a second one.
 * tests/unit/design-tokens.test.ts parses the real files and fails if a mirror
 * and its authority disagree, so "the same token with two different values"
 * cannot survive a test run.
 *
 * Anything expressible as a Tailwind class belongs in a class, not here.
 */

/** Browser default root font size. Nothing in the app overrides `html`'s
 *  font-size, so rem→px is a plain multiply — but going through this constant
 *  keeps the assumption visible instead of hiding a bare `* 16`. */
export const ROOT_FONT_SIZE_PX = 16;

export const remToPx = (rem: number): number => rem * ROOT_FONT_SIZE_PX;

// ── Type scale ───────────────────────────────────────────────────────────────
// Authority: --text-* in client/src/index.css, mirrored by the `fontSize`
// extension in tailwind.config.ts (`text-2xs`, `text-sm-minus`).

/** Smallest sanctioned text size (11px). Nothing may render text below this —
 *  reps read the app one-handed, outdoors, in sunlight. */
export const TEXT_2XS_REM = 0.6875;
/** Dense secondary body text (13px) — the step Tailwind's scale is missing
 *  between `text-xs` (12px) and `text-sm` (14px). */
export const TEXT_SM_MINUS_REM = 0.8125;

/** The legibility floor in px, for SVG/canvas text that has no rem context. */
export const TEXT_MIN_PX = remToPx(TEXT_2XS_REM); // 11

// ── Hit areas ────────────────────────────────────────────────────────────────

/** One-handed tap-target minimum (WCAG 2.5.5 AAA, iOS HIG). Authority:
 *  --tap-target-min in index.css; `min-h-tap`/`h-tap` in the Tailwind theme;
 *  `h-11` is the same metric spelled on the default scale. Exported for hit
 *  testing that happens in JS — e.g. Mapbox's click tolerance, which cannot be
 *  a class at all. */
export const TAP_TARGET_MIN_PX = 44;

// ── Map chrome ───────────────────────────────────────────────────────────────
// Authority: --map-chrome-* in index.css. These are the DARK-theme surface,
// foreground and border, pinned so they never follow `.light` — the basemap
// tiles do not lighten, so map-anchored chrome must not either.

export const MAP_CHROME = {
  surface: "hsl(216 20% 9%)",
  foreground: "hsl(210 16% 96%)",
  border: "hsl(216 15% 16%)",
} as const;

// ── Glass ────────────────────────────────────────────────────────────────────
// Authority: --glass-* in index.css. The blur radii are a phone-GPU budget, not
// a taste choice: capsules 10px, panels 14px, sheet 18px, and no more than ~5
// blurred surfaces on screen at once. Anything past that budget uses
// `.glass-opaque` (zero blur) instead of inventing a smaller radius.

export const GLASS = {
  blurCapsulePx: 10,
  blurPanelPx: 14,
  blurSheetPx: 18,
  saturatePct: 150,
  saturateSheetPct: 140,
  /** Panel corner radius. Capsules are 9999px — a pill is not a scale step. */
  radiusPanelPx: 20,
} as const;

/** Max simultaneously-blurred glass surfaces before switching to
 *  `.glass-opaque`. Documented in index.css; enforceable only from JS, which is
 *  what decides how many panels are mounted. */
export const GLASS_BLUR_BUDGET = 5;

// ── Navigation puck ──────────────────────────────────────────────────────────
// Authority: --nav-puck* in index.css. The puck is a Mapbox Marker, so a
// JS-drawn variant (a trail, a heading cone) must read the blue from here
// rather than re-typing #2f7bff a fourth time.

export const NAV_PUCK = {
  live: "#2f7bff",
  stale: "#94a3b8",
  ring: "#ffffff",
} as const;

// ── Radius ───────────────────────────────────────────────────────────────────

/** Base corner radius (12px). Authority: --radius in index.css. */
export const RADIUS_REM = 0.75;
