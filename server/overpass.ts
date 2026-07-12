/**
 * Overpass API + Mapbox Geocoding — City-wide Address Puller
 *
 * Flow:
 *   1. Mapbox geocoding: "Rockwell, NC" → bounding box (south, west, north, east)
 *   2. Overpass API: all addr:housenumber addresses in bbox (TILED for big cities)
 *   3. Returns structured address list ready for Kinetic scanning
 *
 * "Any city" robustness: a single un-tiled Overpass query over a whole large city
 * hits the public 25s runtime cap and returns empty/partial — so a big city used
 * to yield 0 addresses. We now TILE the city bbox and query each tile (bounded
 * concurrency + retry), merge + dedupe, so the whole city's addresses actually
 * reach Kinetic regardless of size. We also match addr:place (rural / new
 * subdivisions OSM tags without addr:street) and normalize the state to 2 letters.
 */
import { pooledMap } from "./bboxScan";

export interface OverpassAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
}

interface MapboxFeature {
  bbox?: number[]; // [west, south, east, north]
  center: number[];
  place_name: string;
  context?: { id: string; text: string; short_code?: string }[];
}

// Full state name → USPS 2-letter (OSM addr:state is often the full name, which
// Kinetic's address search rejects). Only the ones we operate near, plus a
// generic passthrough for anything already 2 letters.
const US_STATE_ABBR: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
  "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
  "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD", "massachusetts": "MA",
  "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT",
  "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
  "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
};

/** Normalize any state value (full name / 2-letter / OSM tag) → USPS 2-letter. */
export function normalizeState(raw: string | undefined, fallback: string): string {
  // Normalize a single value: 2-letter passes through; a known full name maps;
  // anything else → "" (unknown). We normalize BOTH raw and fallback the same
  // way so a full-name fallback ("North Carolina") never gets naively sliced to
  // "NO" and sent to Kinetic.
  const norm = (v: string | undefined): string => {
    const s = (v ?? "").trim();
    if (!s) return "";
    if (s.length === 2) return s.toUpperCase();
    return US_STATE_ABBR[s.toLowerCase()] ?? "";
  };
  return norm(raw) || norm(fallback) || (fallback ?? "").trim().toUpperCase().slice(0, 2);
}

type Bbox = { south: number; west: number; north: number; east: number };

/**
 * Geocode a city name via Mapbox → returns bounding box. Cached forever.
 */
type CityGeo = { bbox: Bbox; center: [number, number]; name: string } | null;
const cityGeoCache = new Map<string, CityGeo>();

export async function geocodeCity(city: string, state: string): Promise<CityGeo> {
  const cacheKey = `${city.trim().toLowerCase()},${state.trim().toLowerCase()}`;
  if (cityGeoCache.has(cacheKey)) return cityGeoCache.get(cacheKey)!;

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("MAPBOX_TOKEN not configured");

  const query = encodeURIComponent(`${city}, ${state}`);
  // limit=3 + state validation so a same-named city in the wrong state can't
  // hijack the whole scan's geography.
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${token}&types=place,locality,neighborhood&country=us&limit=3`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Mapbox geocoding failed: ${res.status}`);

  const data = await res.json();
  const feats: MapboxFeature[] = data.features ?? [];
  if (feats.length === 0) { cityGeoCache.set(cacheKey, null); return null; }

  // Prefer the candidate whose region context matches the requested state.
  const want = normalizeState(state, state);
  const feature = feats.find((f) => {
    const region = (f.context ?? []).find((c) => String(c.id).startsWith("region"));
    const code = region?.short_code?.replace(/^US-/i, "") ?? region?.text ?? "";
    return normalizeState(code, code).toUpperCase() === want.toUpperCase();
  }) ?? feats[0];

  let bbox: Bbox;
  if (feature.bbox && feature.bbox.length === 4) {
    bbox = { west: feature.bbox[0], south: feature.bbox[1], east: feature.bbox[2], north: feature.bbox[3] };
    const latPad = (bbox.north - bbox.south) * 0.1;
    const lngPad = (bbox.east - bbox.west) * 0.1;
    bbox.south -= latPad; bbox.north += latPad; bbox.west -= lngPad; bbox.east += lngPad;
  } else {
    // No place bbox — scale the fallback box by feature type: a "place" (town) is
    // bigger than a "neighborhood". Better an over-cover than clipping the city.
    const [lng, lat] = feature.center;
    const isPlace = /place|locality/.test(String((feature as any).place_type?.[0] ?? "place"));
    const latDelta = isPlace ? 0.09 : 0.035; // ~10km vs ~4km
    const lngDelta = isPlace ? 0.11 : 0.045;
    bbox = { south: lat - latDelta, north: lat + latDelta, west: lng - lngDelta, east: lng + lngDelta };
  }

  const result: CityGeo = { bbox, center: [feature.center[0], feature.center[1]], name: feature.place_name };
  cityGeoCache.set(cacheKey, result);
  return result;
}

// ── One Overpass query for a single (small) bbox, with retry ──────────────────
function overpassQL(b: Bbox): string {
  // Match addr:street OR addr:place (rural / unincorporated communities and many
  // new subdivisions tag addr:place, not addr:street — exactly the fiber targets).
  return `
[out:json][timeout:45];
(
  node["addr:housenumber"]["addr:street"](${b.south},${b.west},${b.north},${b.east});
  way["addr:housenumber"]["addr:street"](${b.south},${b.west},${b.north},${b.east});
  node["addr:housenumber"]["addr:place"](${b.south},${b.west},${b.north},${b.east});
  way["addr:housenumber"]["addr:place"](${b.south},${b.west},${b.north},${b.east});
);
out center;
`.trim();
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter", // fallback mirror on 429/5xx
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass(query: string, attempts = 2): Promise<{ elements: any[]; truncated: boolean }> {
  let lastErr: any;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "User-Agent": "HomeFrontFiber/1.0 (field sales lead tool)",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(50000), // > server [timeout:45] so a hit-the-cap query returns its partial+remark
      });
      // 429 (rate limit) / 5xx (gateway) are transient — back off + retry (rotates mirror).
      if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
        lastErr = new Error(`Overpass ${res.status}`);
        await sleep(800 * (attempt + 1) + Math.floor(Math.random() * 400));
        continue;
      }
      if (!res.ok) throw new Error(`Overpass API failed: ${res.status}`);
      const data = await res.json();
      // A query that hit the server runtime cap returns HTTP 200 with PARTIAL
      // elements + a remark — surface that as truncated so the caller doesn't
      // treat an under-count as the complete set.
      const remark: string = data.remark ?? "";
      const truncated = /timed out|runtime error|out of memory/i.test(remark);
      if (truncated) console.warn(`[overpass] partial result (remark: ${remark.slice(0, 120)})`);
      return { elements: data.elements ?? [], truncated };
    } catch (e: any) {
      lastErr = e;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error("Overpass failed");
}

function parseElements(elements: any[], cityName: string, stateName: string, seen: Set<string>, out: OverpassAddress[]) {
  for (const el of elements) {
    const tags = el.tags ?? {};
    const houseNum = tags["addr:housenumber"] ?? "";
    const street = tags["addr:street"] || tags["addr:place"] || ""; // addr:place fallback for rural
    if (!houseNum || !street) continue;

    const fullAddress = `${houseNum} ${street}`;
    const key = fullAddress.toLowerCase();
    if (seen.has(key)) continue;

    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!lat || !lng) continue;
    seen.add(key);

    out.push({
      address: fullAddress,
      city: tags["addr:city"] || cityName,
      state: normalizeState(tags["addr:state"], stateName), // full-name → 2-letter for Kinetic
      zip: tags["addr:postcode"] || "",
      lat, lng,
    });
  }
}

/** One tile → addresses + whether the query was truncated (hit the runtime cap). */
async function pullTile(bbox: Bbox, cityName: string, stateName: string): Promise<{ addresses: OverpassAddress[]; truncated: boolean }> {
  const { elements, truncated } = await fetchOverpass(overpassQL(bbox));
  const seen = new Set<string>();
  const out: OverpassAddress[] = [];
  parseElements(elements, cityName, stateName, seen, out);
  return { addresses: out, truncated };
}

/**
 * Pull all residential addresses in a SINGLE bounding box via Overpass.
 * Used for a drawn box / one tile. Retries transient failures.
 */
export async function pullAddressesFromOverpass(
  bbox: Bbox,
  cityName: string,
  stateName: string,
): Promise<OverpassAddress[]> {
  return (await pullTile(bbox, cityName, stateName)).addresses;
}

/** Split a bbox into a grid of tiles no larger than tileDeg on a side. */
export function tileBbox(bbox: Bbox, tileDeg = 0.06): Bbox[] {
  const tiles: Bbox[] = [];
  const step = Math.max(0.01, tileDeg);
  for (let s = bbox.south; s < bbox.north; s += step) {
    for (let w = bbox.west; w < bbox.east; w += step) {
      tiles.push({ south: s, west: w, north: Math.min(s + step, bbox.north), east: Math.min(w + step, bbox.east) });
    }
  }
  return tiles;
}

/**
 * Pull EVERY residential address across a whole-city bbox. Small bboxes run as
 * one query; large ones are tiled so no single query hits the 25–60s Overpass
 * cap and returns empty. Tiles run at bounded concurrency (polite to public
 * Overpass) and are merged + deduped.
 */
export async function pullCityAddressesTiled(bbox: Bbox, cityName: string, stateName: string): Promise<OverpassAddress[]> {
  const latSpan = bbox.north - bbox.south;
  const lngSpan = bbox.east - bbox.west;

  // Small enough for a single request — don't tile.
  if (latSpan <= 0.08 && lngSpan <= 0.08) {
    return pullAddressesFromOverpass(bbox, cityName, stateName);
  }

  // Choose a tile size that keeps the query count bounded (≤ ~48 tiles) even for
  // a large metro — coarser tiles for a bigger city, so we stay polite to public
  // Overpass instead of firing hundreds of requests.
  const MAX_TILES = 48;
  let tileDeg = 0.06;
  while (Math.ceil(latSpan / tileDeg) * Math.ceil(lngSpan / tileDeg) > MAX_TILES) tileDeg += 0.02;
  const tiles = tileBbox(bbox, tileDeg);
  const seen = new Set<string>();
  const out: OverpassAddress[] = [];
  // Overall wall-clock deadline: this pull is awaited synchronously before the
  // endpoint responds, so it must never block for minutes. Past the deadline we
  // skip remaining tiles and return what we have (marked incomplete in the log).
  const deadline = Date.now() + Number(process.env.OVERPASS_CITY_DEADLINE_MS ?? 75000);
  let failed = 0, skipped = 0, truncatedTiles = 0;
  // Concurrency 3 — enough to be fast, gentle enough not to trip public rate limits.
  const perTile = await pooledMap(tiles, 3, async (t) => {
    if (Date.now() > deadline) { skipped++; return [] as OverpassAddress[]; }
    try {
      const { addresses, truncated } = await pullTile(t, cityName, stateName);
      if (truncated) truncatedTiles++;
      return addresses;
    } catch { failed++; return [] as OverpassAddress[]; } // one flaky tile can't sink the whole city
  });
  for (const list of perTile) {
    for (const a of list) {
      const key = a.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  const incomplete = failed + skipped + truncatedTiles;
  console.log(`[overpass] ${cityName}, ${stateName}: ${out.length} addresses across ${tiles.length} tiles (failed ${failed}, past-deadline ${skipped}, truncated ${truncatedTiles})`);
  if (incomplete > tiles.length * 0.25) {
    console.warn(`[overpass] ${cityName}, ${stateName}: ${incomplete}/${tiles.length} tiles incomplete — result likely UNDER-counts; a re-pull may find more.`);
  }
  return out;
}

/**
 * Main entry: city + state → EVERY residential address ready for scanning.
 */
export async function getCityAddresses(city: string, state: string): Promise<{
  addresses: OverpassAddress[];
  cityName: string;
  bbox: Bbox;
  center: [number, number];
}> {
  const geo = await geocodeCity(city, state);
  if (!geo) throw new Error(`City not found: "${city}, ${state}". Try a more specific name.`);

  const addresses = await pullCityAddressesTiled(geo.bbox, city, state);

  return { addresses, cityName: geo.name, bbox: geo.bbox, center: geo.center };
}
