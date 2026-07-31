import { STATE_COLORS, type PinDisplayState } from "@shared/knock";
import {
  LEAD_MAP_STATUSES,
  STATUS_CONFIG,
  toLeadMapStatus,
  type LeadMapStatus,
} from "@shared/statusConfig";

export const ICON_PREFIX = "pin-";
export const BASE_PX = 40;
/** Assets are authored on a 40-unit grid but rasterized at 2x (80px) and
 *  registered with `pixelRatio: 2`, so the painted pin is still 40 logical px
 *  while the white ring and badge digits stay crisp on retina screens. */
export const PIN_PIXEL_RATIO = 2;
export type StatusIconKey = PinDisplayState | LeadMapStatus | "neutral";
export type MapExpr = string | number | boolean | MapExpr[];

export const DISPLAY_STATES = Object.keys(STATE_COLORS) as PinDisplayState[];

export const STATUS_ICON: Record<PinDisplayState | "neutral", {
  key: string;
  glyph: string;
  tint: PinDisplayState;
}> = Object.freeze({
  unworked:       { key: "pin-prospect",       glyph: "arrow",  tint: "unworked" },
  not_home:       { key: "pin-not_home",       glyph: "door",   tint: "not_home" },
  contacted:      { key: "pin-prospect",       glyph: "arrow",  tint: "contacted" },
  interested:     { key: "pin-interested",     glyph: "star",   tint: "interested" },
  follow_up:      { key: "pin-follow_up",      glyph: "clock",  tint: "follow_up" },
  callback:       { key: "pin-follow_up",      glyph: "clock",  tint: "callback" },
  sold:           { key: "pin-sold",           glyph: "dollar", tint: "sold" },
  not_interested: { key: "pin-not_interested", glyph: "x",      tint: "not_interested" },
  already_customer: { key: "pin-already_customer", glyph: "user", tint: "already_customer" },
  neutral:        { key: "pin-prospect",       glyph: "arrow",  tint: "unworked" },
});

// ── Circle pin geometry (SalesRabbit-style flat disc) ─────────────────────────
// Every status is the SAME silhouette now — a flat filled circle in the status
// colour with a white inner glyph and a crisp white outer ring. Identity moved
// from shape (teardrop-vs-arrow) to glyph + hue, which is what the reference
// does; the glyph vocabulary itself is unchanged, so nothing a rep learned is
// thrown away. Center (20,20) matches the old teardrop bulb center, letting the
// entire glyph path set below carry over verbatim.
const CIRCLE = { cx: 20, cy: 20, r: 16 } as const;

// White badge disc anchored on the circle's top-right rim. It carries the
// "not yet knocked" micro-glyph on unworked doors (the reference's "?"), and —
// our touch — the knock COUNT once a door has been knocked more than once.
const BADGE = { cx: 32, cy: 8, r: 7 } as const;

// Worked/unworked stroke semantics — the same 2.5 / 1.5 numbers the circle
// fallback layer paints via ["case", visited, 2.5, 1.5] (see UNCLUSTERED_PAINT
// in mapPins.ts), so the two renderers can never disagree about what a bolder
// ring means. Prospect is the one un-knocked design; everything else is a
// disposition a rep produced by working the door.
const UNWORKED_STROKE = 1.5;
const WORKED_STROKE = 2.5;

const GLYPHS = {
  door: `<path d="M14 11.5h12v19H14z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><path d="M17 14.5h6v16h-6z" fill="#fff"/><circle cx="21.4" cy="22.5" r="1" fill="#334155"/>`,
  star: `<path d="m20 10.5 3.05 6.18 6.82 1-4.94 4.8 1.17 6.79L20 26.06l-6.1 3.21 1.17-6.79-4.94-4.8 6.82-1L20 10.5Z" fill="#fff"/>`,
  // Vector, NOT <text>. These SVGs are rasterized as data-URL images, where font
  // resolution is unreliable — Arial is absent on most Android devices, and a
  // glyph that silently fails to draw leaves a sold pin looking blank. Every
  // glyph here is a path; the $ was the one field reps said they couldn't see.
  dollar: `<path d="M20 9.5v21" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M25 15.1c0-2.2-2.2-3.7-5-3.7s-5 1.4-5 3.4c0 2.3 2 3.1 5 3.8s5.2 1.5 5.2 4c0 2.2-2.3 3.9-5.2 3.9s-5.2-1.7-5.2-4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  x: `<path d="m13 13 14 14m0-14L13 27" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>`,
  clock: `<circle cx="20" cy="20" r="9" fill="none" stroke="#fff" stroke-width="2.5"/><path d="M20 14v6l4.4 2.7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  // Head-and-shoulders, vector like every other glyph (no <text>, no font).
  user: `<circle cx="20" cy="15.5" r="4.2" fill="#fff"/><path d="M12 29.5c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`,
  // The prospect down-arrow, kept from the old arrow-shaped pin — now drawn
  // INSIDE the circle so the glyph identity survives the silhouette change.
  arrow: `<path d="M20 12.5v13m-5.5-5.5 5.5 5.5 5.5-5.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  none: "",
} as const;

// ── Knock-count badge ─────────────────────────────────────────────────────────
// Buckets 2..9 show the exact count; bucket 10 is the "9+" overflow. Digits are
// fixed-width single-stroke VECTOR paths (tabular by construction, dark on the
// white disc) — never <text>, for the same no-font-on-device reason as the $.
export const KNOCK_BADGE_MIN = 2;
export const KNOCK_BADGE_MAX = 10; // 10 = the "9+" overflow bucket
export const KNOCK_BADGE_BUCKETS: readonly number[] = Object.freeze(
  Array.from({ length: KNOCK_BADGE_MAX - KNOCK_BADGE_MIN + 1 }, (_, i) => KNOCK_BADGE_MIN + i),
);

/** Feature-prop / icon-id bucket for a door's knock count: 0 = no badge. */
export function knockBadgeBucket(knockCount: number | null | undefined): number {
  const n = typeof knockCount === "number" && Number.isFinite(knockCount) ? Math.trunc(knockCount) : 0;
  if (n < KNOCK_BADGE_MIN) return 0;
  return Math.min(n, KNOCK_BADGE_MAX);
}

// Digit strokes on a shared 4x6.4 box centered at (0,0) — same advance width for
// every digit, which is what "tabular" means once rasterized.
const BADGE_DIGITS: Record<number, string> = {
  2: "M-1.9 -3.2H1.9V0H-1.9V3.2H1.9",
  3: "M-1.9 -3.2H1.9V3.2H-1.9M1.9 0H-0.6",
  4: "M-1.9 -3.2V0H1.9M1.9 -3.2V3.2",
  5: "M1.9 -3.2H-1.9V0H1.9V3.2H-1.9",
  6: "M1.9 -3.2H-1.9V3.2H1.9V0H-1.9",
  7: "M-1.9 -3.2H1.9L0.4 3.2",
  8: "M-1.9 -3.2H1.9V3.2H-1.9ZM-1.9 0H1.9",
  9: "M1.9 0H-1.9V-3.2H1.9V3.2H-1.9",
};

function badgeDisc(inner: string): string {
  // Hairline dark rim so the white disc still reads over a light basemap.
  return `<circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="${BADGE.r}" fill="#fff" stroke="rgba(15,23,42,0.25)" stroke-width="0.75"/>${inner}`;
}

// Neutral "not yet knocked" micro-glyph — a dot, consistent with the vector-only
// glyph set (the reference's "?" is a text glyph, which our no-font rule bans).
const UNWORKED_BADGE = badgeDisc(`<circle cx="${BADGE.cx}" cy="${BADGE.cy}" r="2.2" fill="#334155"/>`);

function countBadge(bucket: number): string {
  const stroke = `fill="none" stroke="#0f172a" stroke-linecap="round" stroke-linejoin="round"`;
  if (bucket >= KNOCK_BADGE_MAX) {
    // "9+" — the nine shifted left to make room for a compact plus.
    return badgeDisc(
      `<g ${stroke} stroke-width="1.3">` +
      `<path d="${BADGE_DIGITS[9]}" transform="translate(30.2 8) scale(0.9)"/>` +
      `<path d="M33.8 8H36.6M35.2 6.6V9.4"/>` +
      `</g>`,
    );
  }
  return badgeDisc(
    `<path d="${BADGE_DIGITS[bucket]}" transform="translate(${BADGE.cx} ${BADGE.cy})" ${stroke} stroke-width="1.5"/>`,
  );
}

function circlePin(status: LeadMapStatus, badge: string, ariaLabel: string): string {
  const cfg = STATUS_CONFIG[status];
  const stroke = status === "prospect" ? UNWORKED_STROKE : WORKED_STROKE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BASE_PX * PIN_PIXEL_RATIO}" height="${BASE_PX * PIN_PIXEL_RATIO}" viewBox="0 0 40 40" role="img" aria-label="${ariaLabel}">
    <circle cx="${CIRCLE.cx}" cy="${CIRCLE.cy}" r="${CIRCLE.r}" fill="${cfg.color}" stroke="#fff" stroke-width="${stroke}"/>
    ${GLYPHS[cfg.glyph]}
    ${badge}
  </svg>`;
}

const toDataUrl = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Seven inline SVG assets — flat circles, all sharing the (20,20) center.
 *  Prospect (the un-knocked door) carries the white top-right badge with the
 *  neutral dot; worked statuses carry no badge until the knock count earns one. */
export const PIN_SVGS: Readonly<Record<LeadMapStatus, string>> = Object.freeze(
  Object.fromEntries(LEAD_MAP_STATUSES.map((status) => [
    status,
    circlePin(status, status === "prospect" ? UNWORKED_BADGE : "", STATUS_CONFIG[status].label),
  ])) as Record<LeadMapStatus, string>,
);

export const PIN_DATA_URLS: Readonly<Record<LeadMapStatus, string>> = Object.freeze(
  Object.fromEntries(LEAD_MAP_STATUSES.map((status) => [
    status,
    toDataUrl(PIN_SVGS[status]),
  ])) as Record<LeadMapStatus, string>,
);

/** Count-badged variant: same circle pin, badge shows the knock count. The
 *  count badge REPLACES the unworked dot on prospect — a door knocked twice is
 *  not "never knocked", whatever its current status says. */
export function pinCountSvg(status: LeadMapStatus, bucket: number): string {
  const label = `${STATUS_CONFIG[status].label}, knocked ${bucket >= KNOCK_BADGE_MAX ? "9 or more" : bucket} times`;
  return circlePin(status, countBadge(bucket), label);
}

export function pinCountDataUrl(status: LeadMapStatus, bucket: number): string {
  return toDataUrl(pinCountSvg(status, bucket));
}

/** Canonical image id for a door: `pin-<status>` or `pin-<status>-k<bucket>`.
 *  Mirrors iconImageConcatExpression so imperative repaints and the GPU
 *  expression can never point at different atlas entries. */
export function pinIconId(status: LeadMapStatus, knockCount = 0): string {
  const bucket = knockBadgeBucket(knockCount);
  return bucket ? `${ICON_PREFIX}${status}-k${bucket}` : `${ICON_PREFIX}${status}`;
}

/** Required data-driven Mapbox expression: one symbol layer, no DOM markers.
 *  `knocks` is the bucketed count from leadGeoJson (coalesced to 0 for sources
 *  that don't carry it, e.g. LeadMap's slim features). */
export function iconImageConcatExpression(): MapExpr[] {
  const knocks: MapExpr = ["coalesce", ["get", "knocks"], 0];
  return [
    "concat", ICON_PREFIX, ["get", "status"],
    [
      "case",
      [">=", knocks, KNOCK_BADGE_MIN],
      ["concat", "-k", ["to-string", ["min", knocks, KNOCK_BADGE_MAX]]],
      "",
    ],
  ];
}

/** Backward-compatible export for existing callers while they migrate. */
export const iconImageMatchExpression = iconImageConcatExpression;

export interface ImageMap {
  hasImage(id: string): boolean;
  addImage(id: string, image: HTMLImageElement | ImageBitmap | ImageData, options?: { pixelRatio?: number }): void;
  loadImage(url: string, callback: (error?: Error | null, image?: HTMLImageElement | ImageBitmap | ImageData) => void): void;
}

function loadMapImage(map: ImageMap, url: string): Promise<HTMLImageElement | ImageBitmap | ImageData> {
  return new Promise((resolve, reject) => {
    map.loadImage(url, (error, image) => {
      if (error || !image) reject(error ?? new Error("Mapbox returned no image"));
      else resolve(image);
    });
  });
}

function loadBrowserImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode inline pin SVG"));
    image.src = url;
  });
}

async function registerOne(map: ImageMap, id: string, url: string): Promise<void> {
  if (map.hasImage(id)) return;
  // Mapbox's supported image formats vary by GL JS release. Always attempt
  // map.loadImage as requested; the browser decoder is the production-safe
  // fallback for releases that reject SVG data URLs.
  const image = await loadMapImage(map, url).catch(() => loadBrowserImage(url));
  if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio: PIN_PIXEL_RATIO });
}

/** Registers the seven base pins PLUS every knock-count badge variant
 *  (pin-<status>-k2 … pin-<status>-k10) through Mapbox's loadImage/addImage. */
export async function registerPinImages(map: ImageMap): Promise<void> {
  await Promise.all(LEAD_MAP_STATUSES.flatMap((status) => [
    registerOne(map, `${ICON_PREFIX}${status}`, PIN_DATA_URLS[status]),
    ...KNOCK_BADGE_BUCKETS.map((bucket) =>
      registerOne(map, pinIconId(status, bucket), pinCountDataUrl(status, bucket))),
  ]));
}

/** Legend/card helper generated from the exact same SVG used by the map. */
export function spriteDataUrl(key: StatusIconKey, _pixelRatio = 1): string {
  return PIN_DATA_URLS[toLeadMapStatus(key)];
}
