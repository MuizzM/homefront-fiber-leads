// ── Scanned-door pin glyphs ───────────────────────────────────────────────────
// The scanned-door layer painted COLOUR-ONLY circles: green new_fiber, amber
// fiber_open, blue tenured_active, purple coming_soon, grey unverified. The lead
// pins beside them carry a white vector glyph inside the disc, and that mismatch
// is the whole problem — a rep reading a Rockwell street at arm's length has to
// tell five hues apart with no shape to help, and colour alone fails outright
// for the ~8% of men with a colour-vision deficiency, for whom the green
// new_fiber dot and a green sold lead are the same dot.
//
// So: the SAME silhouette language as the lead pins (statusIcons.ts) — a flat
// filled circle in the verdict colour, a white vector glyph inside, a crisp
// white outer ring — with a glyph vocabulary for the five VERDICTS.
//
// GLYPH CHOICES, and what each one has to survive:
//   new_fiber      bolt    fiber is lit, and lit recently. Nothing in the lead
//                          set uses a zigzag, so the silhouette is unambiguous.
//   fiber_open     unlock  fiber at the door with no account on it — available,
//                          unclaimed. An open shackle reads "not taken".
//   tenured_active user    already a customer. This is DELIBERATELY the same
//                          head-and-shoulders the lead set gives already_customer:
//                          same meaning, same mark, nothing new to learn.
//   coming_soon    calendar the carrier promised a DATE, and the coming ledger
//                          stores that month and audits it against the carrier's
//                          own words. Deliberately NOT the lead set's clock:
//                          follow_up is a lead a rep chose to revisit, which is a
//                          different idea that must not read as the same one.
//   unverified     dash    answered, fiber-shaped, no qualification on record.
//                          A single bar reads "nothing established yet" and is
//                          the quietest mark in the set, which is right for a
//                          pin the rep is meant to read past.
//
// The one reused glyph (user) is imported rather than re-drawn so it can never
// drift from the lead set. $ / down-arrow / door are deliberately NOT reused:
// they are the three most-learned lead marks, and a green $ (sold) next to an
// amber $ (open fiber) would be two opposite meanings in one glyph. The clock is
// off the table for the same reason — see coming_soon below.
//
// NO <text>, EVER. These SVGs are rasterized as data-URL images, where font
// resolution is unreliable (Arial is absent on most Android devices) and a glyph
// that silently fails to draw leaves a pin looking blank. Every mark is a path.

import {
  BASE_PX,
  CIRCLE,
  GLYPHS,
  PIN_PIXEL_RATIO,
  toDataUrl,
  type MapExpr,
} from "@/lib/statusIcons";

/** Server-owned vocabulary — mirrors DoorTag in server/scannedDoors.ts. */
export type DoorTag =
  | "new_fiber"
  | "fiber_open"
  | "tenured_active"
  | "coming_soon"
  | "unverified";

export const DOOR_TAGS: readonly DoorTag[] = Object.freeze([
  "new_fiber",
  "fiber_open",
  "tenured_active",
  "coming_soon",
  "unverified",
]);

/** Image-id prefix. Distinct from the lead set's `pin-` so the two atlases can
 *  never collide on a shared map style. */
export const DOOR_ICON_PREFIX = "door-";

/** Fill + ring, verbatim from the circle layer this replaces, so nothing about
 *  the map's colour meaning changes — only the glyph is added. */
export const DOOR_PIN_STYLE: Readonly<Record<DoorTag, { fill: string; ring: string }>> =
  Object.freeze({
    new_fiber: { fill: "#16a34a", ring: "#dcfce7" },
    fiber_open: { fill: "#f59e0b", ring: "#fef3c7" },
    tenured_active: { fill: "#3b82f6", ring: "#bfdbfe" },
    coming_soon: { fill: "#8b5cf6", ring: "#ede9fe" },
    unverified: { fill: "#94a3b8", ring: "#e2e8f0" },
  });

/** Human labels — must agree with DOOR_TAG_LABEL in server/scannedDoors.ts, which
 *  is the source of truth the map, the card and the legend all read. */
export const DOOR_PIN_LABEL: Readonly<Record<DoorTag, string>> = Object.freeze({
  new_fiber: "New Fiber",
  fiber_open: "Fiber, no account",
  tenured_active: "Already a customer",
  coming_soon: "Coming soon",
  unverified: "Not verified",
});

// Two new marks, drawn on the same 40-unit grid centred at (20,20) as every
// lead glyph, so they sit identically inside the disc.
const DOOR_GLYPHS: Record<DoorTag, string> = {
  // Bolt: a filled zigzag. Solid rather than stroked so it holds its shape when
  // the pin is painted at ~13px on a zoomed-out street.
  new_fiber: `<path d="M22.6 10.5 13.4 21.4h5.2l-1.6 8.1 9.4-11.2h-5.4l1.6-7.8Z" fill="#fff"/>`,
  // Unlocked padlock: body plus a shackle that lifts away on one side. The gap
  // is what carries the meaning, so it is drawn wide enough to survive downscale.
  fiber_open: `<circle cx="20" cy="24.4" r="1.9" fill="#0f172a"/><rect x="13.2" y="19" width="13.6" height="11.2" rx="2.2" fill="#fff"/><path d="M16.6 19v-3.1a3.9 3.9 0 0 1 7.8 0" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>`,
  // Reused verbatim from the lead set — same meaning, same mark.
  tenured_active: GLYPHS.user,
  // Calendar, NOT the lead set's clock. Both mean "later", but follow_up's clock
  // is a lead a rep chose to revisit and coming_soon is a DATE THE CARRIER GAVE
  // US — the ledger stores the promised month and audits it against the provider's
  // own words. Sharing the clock made those two read as one idea separated only
  // by hue, which is the exact failure this whole change exists to fix. Rings
  // deliberately break the top edge: that silhouette survives the downscale to
  // ~14px where a clock face and a calendar body are otherwise the same blob.
  coming_soon: `<rect x="12" y="14.2" width="16" height="14.4" rx="2.2" fill="none" stroke="#fff" stroke-width="2.3"/><path d="M12 19.6h16" fill="none" stroke="#fff" stroke-width="2.3"/><path d="M16.6 11.4v4.4M23.4 11.4v4.4" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/><rect x="18.2" y="22.1" width="3.8" height="3.8" rx="0.9" fill="#fff"/>`,
  // Dash: the quietest legible mark in the set.
  unverified: `<path d="M13.5 20h13" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>`,
};

/** The outer ring is the verdict's own light tint rather than plain white: it is
 *  what separated the five circles from each other on a light basemap before,
 *  and dropping it would lose contrast the map already relied on. */
const RING_WIDTH = 2;

function doorPinSvg(tag: DoorTag): string {
  const { fill, ring } = DOOR_PIN_STYLE[tag];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BASE_PX * PIN_PIXEL_RATIO}" height="${BASE_PX * PIN_PIXEL_RATIO}" viewBox="0 0 40 40" role="img" aria-label="${DOOR_PIN_LABEL[tag]}">
    <circle cx="${CIRCLE.cx}" cy="${CIRCLE.cy}" r="${CIRCLE.r}" fill="${fill}" stroke="${ring}" stroke-width="${RING_WIDTH}"/>
    ${DOOR_GLYPHS[tag]}
  </svg>`;
}

export const DOOR_PIN_SVGS: Readonly<Record<DoorTag, string>> = Object.freeze(
  Object.fromEntries(DOOR_TAGS.map((tag) => [tag, doorPinSvg(tag)])) as Record<DoorTag, string>,
);

export const DOOR_PIN_DATA_URLS: Readonly<Record<DoorTag, string>> = Object.freeze(
  Object.fromEntries(
    DOOR_TAGS.map((tag) => [tag, toDataUrl(DOOR_PIN_SVGS[tag])]),
  ) as Record<DoorTag, string>,
);

/** Canonical atlas id for a verdict. */
export function doorPinIconId(tag: DoorTag): string {
  return `${DOOR_ICON_PREFIX}${tag}`;
}

/** Data-driven icon-image expression: one symbol layer, no DOM markers. An
 *  unknown or missing tag falls back to `unverified` rather than resolving to a
 *  missing image, which MapLibre renders as NOTHING — a door that silently
 *  disappears is worse than one drawn as "not verified". */
export function doorIconImageExpression(): MapExpr[] {
  return [
    "concat",
    DOOR_ICON_PREFIX,
    [
      "match",
      ["get", "tag"],
      ...DOOR_TAGS.flatMap((tag) => [tag, tag] as MapExpr[]),
      "unverified",
    ] as unknown as MapExpr,
  ];
}

/** Size ramp mirroring the circle layer's zoom feel: small enough at street
 *  overview not to blob together, a real target up close. */
export function doorIconSizeExpression(): MapExpr[] {
  return ["interpolate", ["linear"], ["zoom"], 12, 0.34, 15, 0.44, 17, 0.56, 20, 0.72];
}

/** Workable doors sit ABOVE context doors. Tenured/unverified are pins a rep
 *  reads past, so when pins collide the sellable one must be the survivor. */
export function doorSymbolSortKey(): MapExpr[] {
  return [
    "match",
    ["get", "tag"],
    "new_fiber", 0,
    "fiber_open", 1,
    "coming_soon", 2,
    "tenured_active", 3,
    "unverified", 4,
    5,
  ];
}

export interface DoorImageMap {
  hasImage(id: string): boolean;
  addImage(
    id: string,
    image: HTMLImageElement | ImageBitmap | ImageData,
    options?: { pixelRatio?: number },
  ): void;
}

function decodeInline(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode inline door pin SVG"));
    image.src = url;
  });
}

/** Registers the five verdict pins. Data-URLs go straight to the browser decoder
 *  — map.loadImage() fetch()es its URL and the app's CSP connect-src has no
 *  data: entry, so routing through it would burn a guaranteed-failing fetch and
 *  a console error per pin before falling back here anyway. */
export async function registerDoorPinImages(map: DoorImageMap): Promise<void> {
  await Promise.all(
    DOOR_TAGS.map(async (tag) => {
      const id = doorPinIconId(tag);
      if (map.hasImage(id)) return;
      const image = await decodeInline(DOOR_PIN_DATA_URLS[tag]);
      if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio: PIN_PIXEL_RATIO });
    }),
  );
}
