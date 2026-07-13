import { STATE_COLORS, type PinDisplayState } from "@shared/knock";
import {
  LEAD_MAP_STATUSES,
  STATUS_CONFIG,
  toLeadMapStatus,
  type LeadMapStatus,
} from "@shared/statusConfig";

export const ICON_PREFIX = "pin-";
export const BASE_PX = 40;
export type StatusIconKey = PinDisplayState | LeadMapStatus | "neutral";
export type MapExpr = string | number | boolean | MapExpr[];

export const DISPLAY_STATES = Object.keys(STATE_COLORS) as PinDisplayState[];

export const STATUS_ICON: Record<PinDisplayState | "neutral", {
  key: string;
  glyph: string;
  tint: PinDisplayState;
}> = Object.freeze({
  unworked:       { key: "pin-prospect",       glyph: "none",   tint: "unworked" },
  not_home:       { key: "pin-not_home",       glyph: "door",   tint: "not_home" },
  contacted:      { key: "pin-prospect",       glyph: "none",   tint: "contacted" },
  interested:     { key: "pin-interested",     glyph: "star",   tint: "interested" },
  follow_up:      { key: "pin-follow_up",      glyph: "clock",  tint: "follow_up" },
  callback:       { key: "pin-follow_up",      glyph: "clock",  tint: "callback" },
  sold:           { key: "pin-sold",           glyph: "dollar", tint: "sold" },
  not_interested: { key: "pin-not_interested", glyph: "x",      tint: "not_interested" },
  neutral:        { key: "pin-prospect",       glyph: "none",   tint: "unworked" },
});

function tearDrop(color: string, glyph: string, ariaLabel: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="52" viewBox="0 0 40 52" role="img" aria-label="${ariaLabel}">
    <defs><filter id="s" x="-35%" y="-25%" width="170%" height="175%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#0f172a" flood-opacity=".35"/></filter></defs>
    <path filter="url(#s)" d="M20 1.5C9.78 1.5 1.5 9.78 1.5 20c0 13.75 18.5 30.5 18.5 30.5S38.5 33.75 38.5 20C38.5 9.78 30.22 1.5 20 1.5Z" fill="${color}" stroke="#fff" stroke-width="2.5"/>
    ${glyph}
  </svg>`;
}

const GLYPHS = {
  door: `<path d="M14 11.5h12v19H14z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><path d="M17 14.5h6v16h-6z" fill="#fff"/><circle cx="21.4" cy="22.5" r="1" fill="#334155"/>`,
  star: `<path d="m20 10.5 3.05 6.18 6.82 1-4.94 4.8 1.17 6.79L20 26.06l-6.1 3.21 1.17-6.79-4.94-4.8 6.82-1L20 10.5Z" fill="#fff"/>`,
  dollar: `<text x="20" y="28.5" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="22" font-weight="800">$</text>`,
  x: `<path d="m13 13 14 14m0-14L13 27" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>`,
  clock: `<circle cx="20" cy="20" r="9" fill="none" stroke="#fff" stroke-width="2.5"/><path d="M20 14v6l4.4 2.7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
} as const;

const PROSPECT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="52" viewBox="0 0 40 52" role="img" aria-label="Prospect">
  <defs><filter id="s" x="-35%" y="-25%" width="170%" height="175%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#0f172a" flood-opacity=".35"/></filter></defs>
  <path filter="url(#s)" d="M7 4.5h26a2.5 2.5 0 0 1 2.5 2.5v21a2.5 2.5 0 0 1-2.5 2.5h-6L20 49 13 30.5H7A2.5 2.5 0 0 1 4.5 28V7A2.5 2.5 0 0 1 7 4.5Z" fill="${STATUS_CONFIG.prospect.color}" stroke="#fff" stroke-width="2.5"/>
  <path d="M20 10v12m-5-5 5 5 5-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/** Six inline SVG assets. The teardrops and prospect arrow have a common 52px bottom tip. */
export const PIN_SVGS: Readonly<Record<LeadMapStatus, string>> = Object.freeze({
  not_home: tearDrop(STATUS_CONFIG.not_home.color, GLYPHS.door, STATUS_CONFIG.not_home.label),
  interested: tearDrop(STATUS_CONFIG.interested.color, GLYPHS.star, STATUS_CONFIG.interested.label),
  sold: tearDrop(STATUS_CONFIG.sold.color, GLYPHS.dollar, STATUS_CONFIG.sold.label),
  not_interested: tearDrop(STATUS_CONFIG.not_interested.color, GLYPHS.x, STATUS_CONFIG.not_interested.label),
  prospect: PROSPECT_SVG,
  follow_up: tearDrop(STATUS_CONFIG.follow_up.color, GLYPHS.clock, STATUS_CONFIG.follow_up.label),
});

export const PIN_DATA_URLS: Readonly<Record<LeadMapStatus, string>> = Object.freeze(
  Object.fromEntries(LEAD_MAP_STATUSES.map((status) => [
    status,
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PIN_SVGS[status])}`,
  ])) as Record<LeadMapStatus, string>,
);

/** Required data-driven Mapbox expression: one symbol layer, no DOM markers. */
export function iconImageConcatExpression(): MapExpr[] {
  return ["concat", ICON_PREFIX, ["get", "status"]];
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

/** Registers pin-not_home … pin-follow_up through Mapbox's loadImage/addImage API. */
export async function registerPinImages(map: ImageMap): Promise<void> {
  await Promise.all(LEAD_MAP_STATUSES.map(async (status) => {
    const id = `${ICON_PREFIX}${status}`;
    if (map.hasImage(id)) return;
    // Mapbox's supported image formats vary by GL JS release. Always attempt
    // map.loadImage as requested; the browser decoder is the production-safe
    // fallback for releases that reject SVG data URLs.
    const image = await loadMapImage(map, PIN_DATA_URLS[status])
      .catch(() => loadBrowserImage(PIN_DATA_URLS[status]));
    if (!map.hasImage(id)) map.addImage(id, image);
  }));
}

/** Legend/card helper generated from the exact same SVG used by the map. */
export function spriteDataUrl(key: StatusIconKey, _pixelRatio = 1): string {
  return PIN_DATA_URLS[toLeadMapStatus(key)];
}
