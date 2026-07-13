// ── Status-driven pin ICONS (NEW_FIELD_MAP) ──────────────────────────────────
// PURE + framework-free (like shared/knock.ts and lib/mapPins.ts). One place
// maps every PinDisplayState → a legible glyph on a status-tinted disc, drawn
// with a white ring so it reads at ~20px in sunlight. Consumed by MapView's
// registerStatusIcons() (builds the sprite bitmaps) and the `lead-status-icons`
// symbol layer's `icon-image` match. Colors come from @shared/knock — never a
// new hardcoded hex — so icons, circle pins, cards and legend stay one palette.
//
// This module is deliberately dependency-free: spriteImages() draws into an
// offscreen <canvas> (browser only), everything else is data + a Mapbox
// expression builder, all unit-testable without a map.

import { STATE_COLORS, type PinDisplayState } from "@shared/knock";

// Every display state gets an icon, plus a "neutral" fallback used when a status
// is unknown OR its bitmap failed to register (icon-load failure → neutral).
export type StatusIconKey = PinDisplayState | "neutral";

// Legible-at-20px shapes. Kept as a closed union so drawGlyph() is exhaustive
// and adding a status without a glyph is a compile error.
export type GlyphShape =
  | "home" | "door" | "star" | "clock" | "phone" | "check" | "x" | "dot";

export interface StatusIcon {
  /** Mapbox image id registered via map.addImage(), e.g. "hf-icon-sold". */
  key: string;
  /** Shape stroked/filled in white on top of the tinted disc. */
  glyph: GlyphShape;
  /** Which STATE_COLORS hue tints the disc — always a real palette key. */
  tint: PinDisplayState;
}

// Stable id prefix — the `icon-image` match and map.addImage() must agree.
export const ICON_PREFIX = "hf-icon-";

// Icon meanings (spec): unworked→home, not_home→door, interested→star,
// follow_up→clock, callback→phone, sold→check, not_interested→x,
// contacted→dot. neutral is the slate fallback disc.
export const STATUS_ICON: Record<StatusIconKey, StatusIcon> = {
  unworked:       { key: `${ICON_PREFIX}unworked`,       glyph: "home",  tint: "unworked" },
  not_home:       { key: `${ICON_PREFIX}not_home`,       glyph: "door",  tint: "not_home" },
  contacted:      { key: `${ICON_PREFIX}contacted`,      glyph: "dot",   tint: "contacted" },
  interested:     { key: `${ICON_PREFIX}interested`,     glyph: "star",  tint: "interested" },
  follow_up:      { key: `${ICON_PREFIX}follow_up`,      glyph: "clock", tint: "follow_up" },
  callback:       { key: `${ICON_PREFIX}callback`,       glyph: "phone", tint: "callback" },
  sold:           { key: `${ICON_PREFIX}sold`,           glyph: "check", tint: "sold" },
  not_interested: { key: `${ICON_PREFIX}not_interested`, glyph: "x",     tint: "not_interested" },
  // Fallback disc — slate (the design's "unknown/neutral" hue). tint is a real
  // STATE_COLORS key so no new hex is introduced.
  neutral:        { key: `${ICON_PREFIX}neutral`,        glyph: "dot",   tint: "contacted" },
};

// The ordered PinDisplayState keys, sourced from STATE_COLORS so the icon set
// can never omit a state the palette defines.
export const DISPLAY_STATES = Object.keys(STATE_COLORS) as PinDisplayState[];

// ── Mapbox `icon-image` match expression ─────────────────────────────────────
// A minimal recursive expression type so this stays `any`-free while still being
// assignable to a Mapbox layout property.
export type MapExpr = string | number | boolean | MapExpr[];

// Builds ["match", ["get","ds"], "unworked","hf-icon-unworked", … , "hf-icon-neutral"].
// IMPORTANT: this match contains NO `zoom` expression — a zoom expression may
// only appear at the TOP LEVEL of a paint/layout property, never nested inside a
// match. Icon SIZE (top-level interpolate on zoom) is where zoom-scaling lives.
export function iconImageMatchExpression(): MapExpr[] {
  const pairs: MapExpr[] = DISPLAY_STATES.flatMap(
    (state): MapExpr[] => [state, STATUS_ICON[state].key],
  );
  return ["match", ["get", "ds"], ...pairs, STATUS_ICON.neutral.key];
}

// ── Sprite bitmaps (browser only) ────────────────────────────────────────────
// Base logical size in CSS px; the bitmap is drawn at BASE_PX * dpr device px and
// registered with { pixelRatio: dpr } so Mapbox renders it at BASE_PX logical.
export const BASE_PX = 26;

export interface StatusSprite {
  key: string;                // "hf-icon-<status>"
  canvas: HTMLCanvasElement;  // passed to map.addImage()
  pixelRatio: number;         // = dpr, passed as { pixelRatio }
}

// Draw a status glyph into an offscreen canvas: a filled disc in the status hue,
// a white ring, and the glyph in white on top. Returns one StatusSprite per
// StatusIconKey (including "neutral"). Callers register each via map.addImage()
// and skip any that throw so the match falls back to the neutral image.
export function spriteImages(dpr = 1): Record<StatusIconKey, StatusSprite> {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const out = {} as Record<StatusIconKey, StatusSprite>;
  for (const k of Object.keys(STATUS_ICON) as StatusIconKey[]) {
    const spec = STATUS_ICON[k];
    out[k] = {
      key: spec.key,
      canvas: drawSprite(spec.glyph, STATE_COLORS[spec.tint], ratio),
      pixelRatio: ratio,
    };
  }
  return out;
}

function drawSprite(glyph: GlyphShape, color: string, ratio: number): HTMLCanvasElement {
  const size = Math.max(1, Math.round(BASE_PX * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");

  const c = size / 2;              // center
  const ring = Math.max(1, size * 0.08);
  const r = c - ring;             // disc radius inside the ring

  // Soft drop shadow so pins separate from imagery.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = size * 0.08;
  ctx.shadowOffsetY = size * 0.03;

  // Tinted disc.
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  // White ring.
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.lineWidth = ring;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  // Glyph in white.
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(1, size * 0.07);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawGlyph(ctx, glyph, size);

  return canvas;
}

// Glyph coordinates live in a centered unit box (0..1 → inner 50% of the sprite),
// so shapes stay clear of the white ring.
function drawGlyph(ctx: CanvasRenderingContext2D, glyph: GlyphShape, size: number): void {
  const g = size * 0.5;
  const o = size * 0.25;
  const px = (u: number): number => o + u * g;
  const py = (v: number): number => o + v * g;

  switch (glyph) {
    case "home": {
      ctx.beginPath();
      ctx.moveTo(px(0.5), py(0.02));   // roof peak
      ctx.lineTo(px(0.98), py(0.5));   // right eave
      ctx.lineTo(px(0.8), py(0.5));
      ctx.lineTo(px(0.8), py(0.98));   // right wall
      ctx.lineTo(px(0.2), py(0.98));   // base
      ctx.lineTo(px(0.2), py(0.5));    // left wall
      ctx.lineTo(px(0.02), py(0.5));   // left eave
      ctx.closePath();
      ctx.fill();
      return;
    }
    case "door": {
      roundRect(ctx, px(0.28), py(0.08), g * 0.44, g * 0.9, size * 0.03);
      ctx.fill();
      // Knob punched in the tint by clearing back to the disc color is complex;
      // a small dark knob reads fine on the white door.
      ctx.beginPath();
      ctx.arc(px(0.66), py(0.55), Math.max(1, size * 0.035), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      return;
    }
    case "star": {
      const cx = px(0.5);
      const cy = py(0.52);
      const outer = g * 0.5;
      const inner = outer * 0.42;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? outer : inner;
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = cx + Math.cos(ang) * rad;
        const y = cy + Math.sin(ang) * rad;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      return;
    }
    case "clock": {
      const cx = px(0.5);
      const cy = py(0.5);
      const rad = g * 0.44;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - rad * 0.55);  // minute hand up
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + rad * 0.45, cy);  // hour hand right
      ctx.stroke();
      return;
    }
    case "phone": {
      // A smartphone silhouette reads as "phone" instantly at small size.
      roundRect(ctx, px(0.3), py(0.06), g * 0.4, g * 0.88, size * 0.05);
      ctx.fill();
      // Speaker slot + home dot punched darker.
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = Math.max(1, size * 0.05);
      ctx.beginPath();
      ctx.moveTo(px(0.44), py(0.16));
      ctx.lineTo(px(0.56), py(0.16));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px(0.5), py(0.84), Math.max(1, size * 0.03), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fill();
      // restore white for any later strokes
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#ffffff";
      return;
    }
    case "check": {
      ctx.beginPath();
      ctx.moveTo(px(0.14), py(0.55));
      ctx.lineTo(px(0.42), py(0.82));
      ctx.lineTo(px(0.88), py(0.2));
      ctx.stroke();
      return;
    }
    case "x": {
      ctx.beginPath();
      ctx.moveTo(px(0.2), py(0.2));
      ctx.lineTo(px(0.8), py(0.8));
      ctx.moveTo(px(0.8), py(0.2));
      ctx.lineTo(px(0.2), py(0.8));
      ctx.stroke();
      return;
    }
    case "dot": {
      ctx.beginPath();
      ctx.arc(px(0.5), py(0.5), g * 0.28, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, radius: number,
): void {
  const rad = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
