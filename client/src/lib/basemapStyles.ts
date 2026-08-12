// ── Basemap styles, off Mapbox ──────────────────────────────────────────────
//
// The app used to name Mapbox-hosted styles (`mapbox://styles/mapbox/...`),
// which only mapbox-gl can resolve and which bill per MAP LOAD - every
// `new Map()`, regardless of whose tiles end up on screen. That last part is
// the thing that makes "just point it at free tiles" a non-answer: under
// mapbox-gl the bill does not move. Leaving the LIBRARY is what moves it, so
// the app now runs on MapLibre GL JS and builds its style JSON here.
//
// ── WHERE THE IMAGERY COMES FROM, AND THE STRING ATTACHED ──────────────────
//
// The satellite and street layers are Google's own map tiles, taken from the
// tile server that serves maps.google.com. They need no key and no quota, and
// they are the same imagery a rep sees in the Google Maps app - which is the
// whole reason for choosing them.
//
// This is NOT a licensed use. Google's Maps Platform terms allow access to
// their map content only through the Maps Platform APIs, and this endpoint is
// not one of them. What that means in practice, so nobody is surprised later:
//
//   · Google can block it by referrer or by volume, without notice, and there
//     is no support channel to appeal to - we would be an unauthorised client.
//   · There is no SLA and no deprecation policy. The `lyrs=` URL shape has
//     changed before and can change again, and when it does the basemap goes
//     blank for every rep at once.
//   · It is a contractual violation, so it is a finding in any technical due
//     diligence.
//
// The mitigation is that swapping providers is now a one-line change: every
// layer below is a plain XYZ raster URL, and LICENSED_ALTERNATIVES lists
// drop-in replacements that carry none of the above. If Google goes dark,
// point BASEMAP_TILES at one of them and ship.
//
// ── WHY RASTER, AND WHAT IT COSTS US ───────────────────────────────────────
//
// Mapbox served VECTOR tiles, which is how `ensureHousenumLayer` in mapPins.ts
// could restyle house numbers per basemap: it queried the `composite` source.
// Raster tiles have no queryable features, so that layer no-ops - it already
// guards on `getSource("composite")` and skips rather than faking it. Google's
// hybrid tiles draw their own house numbers at high zoom, baked into the
// image, so the rep still sees them; the app just no longer controls them.

export type BasemapMode = "satellite" | "streets" | "dark";

/** Google serves the same tiles from four hosts; MapLibre round-robins the
 *  list. (It has no `{s}` placeholder - that is a Leaflet-ism - so the hosts
 *  are spelled out.) */
function googleTiles(layers: string): string[] {
  return [0, 1, 2, 3].map(
    n => `https://mt${n}.google.com/vt/lyrs=${layers}&hl=en&gl=us&x={x}&y={y}&z={z}`,
  );
}

// Computed, not hardcoded. A literal year in an attribution string is wrong
// from the moment the calendar turns and nobody ever notices, because the one
// person who would check reads it as the IMAGERY date - which it is not. It is
// a copyright notice on the tile service. Google does not publish per-tile
// capture dates through this endpoint at all: what these tiles show is exactly
// what maps.google.com shows for the same place today, typically flown one to
// three years ago and varying street by street.
const GOOGLE_ATTRIBUTION = `Imagery ©${new Date().getFullYear()} Google, Map data ©${new Date().getFullYear()} Google`;

/**
 * Licensed, genuinely free stand-ins. Kept in code rather than a doc because
 * the moment they are needed is the moment nobody has time to research them.
 *
 * · usgsImagery  - NAIP via USGS. US public domain, no key, no quota, no terms
 *                  to violate. Reflown every 2-3 years, so new subdivisions
 *                  show as dirt for a while - which matters here, given the
 *                  new-build pipeline.
 * · esriImagery  - Maxar sub-meter, sharper than NAIP and refreshed sooner.
 *                  Free tier via ArcGIS Location Platform; requires the Esri
 *                  attribution string to stay visible.
 */
export const LICENSED_ALTERNATIVES = {
  usgsImagery: {
    tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"],
    maxzoom: 19,
    attribution: "Imagery courtesy of the U.S. Geological Survey",
  },
  esriImagery: {
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    maxzoom: 19,
    attribution: "Esri, Maxar, Earthstar Geographics",
  },
} as const;

interface RasterBasemap {
  tiles: string[];
  maxzoom: number;
  attribution: string;
}

const BASEMAP_TILES: Record<BasemapMode, RasterBasemap> = {
  // lyrs=s is BARE IMAGERY - deliberately not lyrs=y (hybrid).
  //
  // Hybrid bakes Google's own house numbers into the tile, and we draw house
  // numbers from the county E911 import. Both at once meant every roof carried
  // two numbers in two typefaces: ours large and haloed, Google's small and
  // grey, sometimes disagreeing. A rep reading a door off the map should never
  // have to decide which number the app means.
  //
  // Bare imagery drops Google's STREET names too, so those are drawn from the
  // same E911 data (see the street-label layer in mapPins.ts). One label
  // system, one source of truth, and both layers can be styled, moved and
  // toggled - none of which was possible while the labels were pixels in
  // someone else's JPEG.
  satellite: { tiles: googleTiles("s"), maxzoom: 21, attribution: GOOGLE_ATTRIBUTION },
  streets:   { tiles: googleTiles("m"), maxzoom: 21, attribution: GOOGLE_ATTRIBUTION },
  // Google publishes no dark basemap, and darkening the road tiles with raster
  // paint filters gives mud rather than a dark map (you cannot invert with
  // them). CARTO's dark_all is a real dark cartography, free, CORS-enabled and
  // properly licensed for this with the attribution below - so the one place
  // the app genuinely needs dark uses a source we are actually allowed to use.
  dark: {
    tiles: ["a", "b", "c", "d"].map(
      s => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`,
    ),
    maxzoom: 20,
    attribution: "©OpenStreetMap contributors, ©CARTO",
  },
};

// Mapbox's `DIN Offc Pro` is proprietary and served only from
// mapbox://fonts - off Mapbox it resolves to nothing and every symbol layer
// loses its text. Open Sans is the stack the open glyph server actually
// carries, so the app's text-font values name it instead. Keep these two in
// sync with the `text-font` arrays in mapPins.ts and MapView.tsx.
export const GLYPH_FONT_BOLD = "Open Sans Bold";
export const GLYPH_FONT_REGULAR = "Open Sans Regular";

// Free, CORS-enabled, community-hosted glyph PBFs. Self-hosting these under
// client/public is the obvious hardening step if the CDN ever wobbles: the
// files are static and the URL below is the only thing that would change.
const GLYPHS = "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf";

/**
 * A complete MapLibre style for one basemap mode.
 *
 * Returned fresh each call rather than shared: MapLibre mutates the style
 * object it is handed (it resolves and annotates sources), so handing the same
 * literal to two maps corrupts both.
 */
export function basemapStyle(mode: BasemapMode): any {
  const base = BASEMAP_TILES[mode];
  return {
    version: 8,
    // Named so `map.getStyle().name` stays diagnosable in the field.
    name: `homefront-${mode}`,
    glyphs: GLYPHS,
    sources: {
      basemap: {
        type: "raster",
        tiles: [...base.tiles],
        tileSize: 256,
        maxzoom: base.maxzoom,
        attribution: base.attribution,
      },
    },
    layers: [
      // A flat background under the imagery. Without it, tiles that are still
      // in flight expose the canvas clear colour (white), which strobes hard
      // against satellite while panning.
      {
        id: "background",
        type: "background",
        paint: { "background-color": mode === "dark" ? "#0b0f19" : "#e8e6e1" },
      },
      {
        id: "basemap",
        type: "raster",
        source: "basemap",
        // Zooming past the source's maxzoom keeps overzooming the last real
        // tile instead of dropping to blank - a rep at z22 on a driveway still
        // sees (softer) imagery rather than background colour.
        paint: { "raster-opacity": 1 },
      },
    ],
  };
}
