// ── geocoder.ts — the ONE seam every address lookup goes through ─────────────
//
// Why this file exists. Forward and reverse geocoding used to call Mapbox
// directly from four places. When both MAPBOX tokens were retired the calls
// started answering 401 and every one of those lookups died at once: the map's
// "jump to an address" search, the tap-a-house reverse lookup outside county
// address-point coverage, the lead-create coordinate fallback, and geocodeCity.
// Nothing noticed, because each call site swallowed its own failure.
//
// So: ONE module, a PROVIDER CHAIN, and no direct geocoding fetch anywhere else
// (tests/unit/geocoder-single-seam.test.ts enforces that). A provider that is
// unconfigured or failing is skipped and the next one answers. Address lookup
// now degrades to a different provider instead of to nothing.
//
// Provider order, and why:
//   1. mapbox    — best US address precision, but PAID and currently 401ing.
//                  Skipped entirely when no token is set, and short-circuited
//                  by a breaker (below) once it starts refusing us.
//   2. nominatim — OpenStreetMap, free, no token. Already the working path for
//                  the address-radius sweep (sweepService.searchAddressArea).
//                  Rate limited to <1 req/s per their usage policy, which the
//                  shared queue below enforces process-wide.
//
// Both are cached forever by query: street coordinates do not move, and a
// repeat lookup must never cost a call or a queue slot.
//
// NOT routed through here: server/mapbox-addresses.ts. That is a BULK harvest
// (~12,800 reverse geocodes per city run) behind the Mapbox spend budget.
// Nominatim's policy forbids bulk use, so that path stays on Mapbox and stays
// budget-gated rather than silently pointing a harvest at a free community API.

import { structuredLog } from "./structuredLog";
import { mapboxFetch, MapboxBudgetExhaustedError } from "./mapboxBudget";

export type GeoSource = "mapbox" | "nominatim";

export interface GeoPoint {
  lng: number;
  lat: number;
  placeName: string;
  source: GeoSource;
}

export interface GeoAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
  placeName: string;
  source: GeoSource;
}

export interface GeoBbox { south: number; west: number; north: number; east: number }

export interface GeoPlace {
  bbox: GeoBbox;
  center: [number, number];
  name: string;
  source: GeoSource;
}

const NOMINATIM_UA =
  process.env.DISCOVERY_USER_AGENT ||
  "HomeFrontFiber-geocoder/1.0 (operations@homefrontsolutionsllc.com)";

function mapboxToken(): string {
  return process.env.MAPBOX_TOKEN ?? process.env.MAPBOX_PUBLIC_TOKEN ?? "";
}

// ── Mapbox breaker ──────────────────────────────────────────────────────────
// A 401/403 means the token is retired, not that this one query was bad: every
// subsequent call would burn a round trip to learn the same thing. Trip the
// breaker and skip Mapbox until it re-arms, so a dead token costs ONE request
// instead of one per lookup. The re-arm is what makes a rotated token pick
// itself back up with no deploy.
const BREAKER_MS = Math.max(60_000, Number(process.env.GEOCODER_BREAKER_MS) || 15 * 60_000);
let mapboxOpenUntil = 0;
let mapboxLastError = "";

function mapboxAvailable(): boolean {
  return Boolean(mapboxToken()) && Date.now() >= mapboxOpenUntil;
}

function tripMapbox(reason: string): void {
  const wasClosed = Date.now() >= mapboxOpenUntil;
  mapboxOpenUntil = Date.now() + BREAKER_MS;
  mapboxLastError = reason;
  if (wasClosed) {
    structuredLog("geocode.mapbox_disabled", { reason, forMs: BREAKER_MS }, "warn");
  }
}

/** Test seam: forget the breaker state between cases. */
export function resetGeocoderState(): void {
  mapboxOpenUntil = 0;
  mapboxLastError = "";
  forwardCache.clear();
  reverseCache.clear();
  placeCache.clear();
}

// ── Nominatim pacing ────────────────────────────────────────────────────────
// Their policy is a hard "absolute maximum of 1 request per second". One
// process-wide serial queue, same shape as addressDiscovery/boundary.ts, so a
// burst of map searches lines up instead of getting us blocked.
let nominatimNextAt = 0;
let nominatimTail: Promise<unknown> = Promise.resolve();

/**
 * The gap to leave between Nominatim calls.
 *
 * 1 req/s is OSM's usage policy for THEIR host, so on that host the floor is
 * not negotiable by env - a typo in a deploy must not get us blocked. A
 * self-hosted or mirrored endpoint is the operator's own capacity, so there the
 * configured interval stands on its own.
 */
function nominatimIntervalMs(): number {
  const configured = Number(process.env.NOMINATIM_MIN_INTERVAL_MS);
  const wanted = Number.isFinite(configured) && configured > 0 ? configured : 1_100;
  let official = true;
  try { official = new URL(nominatimBase()).hostname === "nominatim.openstreetmap.org"; } catch { /* keep the floor */ }
  return official ? Math.max(1_000, wanted) : wanted;
}

function nominatimPaced<T>(task: () => Promise<T>): Promise<T> {
  const run = nominatimTail.then(async () => {
    const wait = Math.max(0, nominatimNextAt - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    nominatimNextAt = Date.now() + nominatimIntervalMs();
    return task();
  });
  nominatimTail = run.then(() => undefined, () => undefined);
  return run;
}

function nominatimBase(): string {
  const configured = process.env.NOMINATIM_BASE_URL?.trim() || "https://nominatim.openstreetmap.org";
  const url = new URL(configured);
  if (url.protocol !== "https:") throw new Error("Nominatim endpoint must use HTTPS");
  return url.origin;
}

const TIMEOUT_MS = Math.max(4_000, Number(process.env.GEOCODER_TIMEOUT_MS) || 10_000);

// ── Caches (forever: coordinates do not move) ───────────────────────────────
function bounded<K, V>(cache: Map<K, V>, max: number): void {
  if (cache.size > max) cache.delete(cache.keys().next().value as K); // FIFO
}
const forwardCache = new Map<string, GeoPoint>();
const reverseCache = new Map<string, GeoAddress>();
const placeCache = new Map<string, GeoPlace | null>();

const US_STATE_BY_NAME: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

function stateFromNominatim(addr: Record<string, any> | undefined): string {
  if (!addr) return "";
  const iso = String(addr["ISO3166-2-lvl4"] ?? "");
  const fromIso = iso.split("-").pop() ?? "";
  if (/^[A-Z]{2}$/.test(fromIso)) return fromIso;
  const code = String(addr.state_code ?? "").toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  return US_STATE_BY_NAME[String(addr.state ?? "").trim().toLowerCase()] ?? "";
}

function cityFromNominatim(addr: Record<string, any> | undefined): string {
  if (!addr) return "";
  return String(
    addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.hamlet ?? addr.suburb ?? "",
  );
}

/** A Nominatim result's street line, rebuilt from parts so it never carries the POI name. */
function streetFromNominatim(addr: Record<string, any> | undefined, displayName: string): string {
  const house = String(addr?.house_number ?? "").trim();
  const road = String(addr?.road ?? "").trim();
  if (house && road) return `${house} ${road}`;
  if (road) return road;
  return String(displayName ?? "").split(",")[0]?.trim() ?? "";
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  fetcher: Fetcher = (u, i) => fetch(u, i),
): Promise<{ ok: boolean; status: number; body: any }> {
  const r = await fetcher(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) return { ok: false, status: r.status, body: null };
  return { ok: true, status: r.status, body: await r.json() };
}

// Every BILLED Mapbox call goes through mapboxFetch: it meters the request
// against the daily/monthly ceiling and REFUSES once the ceiling is hit. That
// refusal is not an outage - it lands in the provider loop's catch and the next
// provider (free) answers instead, which is exactly what the governor is for.
const billedFetch: Fetcher = (u, i) => mapboxFetch(u, i);

function logProviderError(
  provider: GeoSource,
  op: "forward" | "reverse" | "place",
  e: any,
  extra: Record<string, string> = {},
): void {
  const budgetStop = e instanceof MapboxBudgetExhaustedError;
  structuredLog(
    budgetStop ? "geocode.mapbox_budget_stop" : "geocode.provider_failed",
    { provider, op, error: String(e?.message ?? e), ...extra },
    "warn",
  );
}

// ── Forward: free text → a point ────────────────────────────────────────────

async function mapboxForward(q: string, types: string): Promise<GeoPoint | null> {
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
    `?access_token=${mapboxToken()}&country=us&limit=1&types=${types}`;
  const { ok, status, body } = await fetchJson(url, {}, billedFetch);
  if (!ok) {
    if (status === 401 || status === 403) tripMapbox(`HTTP ${status}`);
    throw new Error(`Mapbox geocoding failed: ${status}`);
  }
  const f = body?.features?.[0];
  if (!f?.center) return null;
  return { lng: f.center[0], lat: f.center[1], placeName: f.place_name ?? q, source: "mapbox" };
}

async function nominatimForward(q: string): Promise<GeoPoint | null> {
  const url = new URL("/search", nominatimBase());
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");
  const { ok, status, body } = await nominatimPaced(() =>
    fetchJson(url.toString(), { "User-Agent": NOMINATIM_UA, Accept: "application/json" }),
  );
  if (!ok) throw new Error(`Nominatim geocoding failed: ${status}`);
  const hit = Array.isArray(body) ? body[0] : null;
  if (!hit) return null;
  const lat = Number(hit.lat), lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lng, lat, placeName: String(hit.display_name ?? q), source: "nominatim" };
}

/**
 * Free text → coordinates. Returns null when every provider answered "no match";
 * throws only when every provider ERRORED (so a caller can tell "not found" from
 * "lookup is down"). `types` is the Mapbox layer filter; Nominatim ignores it.
 */
export async function forwardGeocode(
  q: string,
  types = "address,neighborhood,locality,place",
): Promise<GeoPoint | null> {
  const trimmed = q.trim();
  if (trimmed.length < 3) return null;
  const key = `${trimmed.toLowerCase()}|${types}`;
  const cached = forwardCache.get(key);
  if (cached) return cached;

  const errors: string[] = [];
  const providers: Array<[GeoSource, () => Promise<GeoPoint | null>]> = [];
  if (mapboxAvailable()) providers.push(["mapbox", () => mapboxForward(trimmed, types)]);
  providers.push(["nominatim", () => nominatimForward(trimmed)]);

  for (const [name, run] of providers) {
    try {
      const hit = await run();
      if (hit) {
        forwardCache.set(key, hit);
        bounded(forwardCache, 2000);
        return hit;
      }
    } catch (e: any) {
      errors.push(`${name}: ${e?.message ?? e}`);
      logProviderError(name, "forward", e);
    }
  }
  if (errors.length === providers.length) {
    structuredLog("geocode.all_providers_failed", { op: "forward", errors: errors.join(" | ") }, "error");
    throw new Error(`Address lookup is unavailable (${errors.join("; ")})`);
  }
  return null; // a provider answered, it just had no match
}

// ── Reverse: a point → an address ───────────────────────────────────────────

async function mapboxReverse(lat: number, lng: number): Promise<GeoAddress | null> {
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
    `?access_token=${mapboxToken()}&country=us&types=address&limit=1`;
  const { ok, status, body } = await fetchJson(url, {}, billedFetch);
  if (!ok) {
    if (status === 401 || status === 403) tripMapbox(`HTTP ${status}`);
    throw new Error(`Mapbox reverse geocode failed: ${status}`);
  }
  const f = body?.features?.[0];
  if (!f) return null;
  const place: string = f.place_name ?? "";
  const parts = place.split(",").map((s: string) => s.trim());
  const ctx: any[] = f.context ?? [];
  const zipMatch = place.match(/\b(\d{5})\b/);
  return {
    address: parts[0] ?? place,
    city: ctx.find((c) => String(c.id).startsWith("place"))?.text ?? (parts[1] ?? ""),
    state: ctx.find((c) => String(c.id).startsWith("region"))?.short_code?.replace("US-", "") ?? "",
    zip: zipMatch ? zipMatch[1] : "",
    lat: f.center?.[1] ?? lat,
    lng: f.center?.[0] ?? lng,
    placeName: place,
    source: "mapbox",
  };
}

async function nominatimReverse(lat: number, lng: number): Promise<GeoAddress | null> {
  const url = new URL("/reverse", nominatimBase());
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "18"); // building level
  const { ok, status, body } = await nominatimPaced(() =>
    fetchJson(url.toString(), { "User-Agent": NOMINATIM_UA, Accept: "application/json" }),
  );
  if (!ok) throw new Error(`Nominatim reverse geocode failed: ${status}`);
  if (!body || body.error || !body.lat) return null;
  const addr = body.address ?? {};
  return {
    address: streetFromNominatim(addr, body.display_name),
    city: cityFromNominatim(addr),
    state: stateFromNominatim(addr),
    zip: String(addr.postcode ?? "").slice(0, 5),
    lat: Number(body.lat) || lat,
    lng: Number(body.lon) || lng,
    placeName: String(body.display_name ?? ""),
    source: "nominatim",
  };
}

/**
 * Coordinates → an address. Same contract as forwardGeocode: null = no match,
 * throw = every provider is down. Callers that have a county address file
 * should consult it FIRST — it is free, exact, and needs no network.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<GeoAddress | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`; // ~11 m grid
  const cached = reverseCache.get(key);
  if (cached) return cached;

  const errors: string[] = [];
  const providers: Array<[GeoSource, () => Promise<GeoAddress | null>]> = [];
  if (mapboxAvailable()) providers.push(["mapbox", () => mapboxReverse(lat, lng)]);
  providers.push(["nominatim", () => nominatimReverse(lat, lng)]);

  for (const [name, run] of providers) {
    try {
      const hit = await run();
      if (hit) {
        reverseCache.set(key, hit);
        bounded(reverseCache, 4000);
        return hit;
      }
    } catch (e: any) {
      errors.push(`${name}: ${e?.message ?? e}`);
      logProviderError(name, "reverse", e);
    }
  }
  if (errors.length === providers.length) {
    structuredLog("geocode.all_providers_failed", { op: "reverse", errors: errors.join(" | ") }, "error");
    throw new Error(`Reverse lookup is unavailable (${errors.join("; ")})`);
  }
  return null;
}

// ── Place: a city name → a bounding box ─────────────────────────────────────

function padBbox(b: GeoBbox): GeoBbox {
  const latPad = (b.north - b.south) * 0.1;
  const lngPad = (b.east - b.west) * 0.1;
  return { south: b.south - latPad, north: b.north + latPad, west: b.west - lngPad, east: b.east + lngPad };
}

async function mapboxPlace(city: string, state: string): Promise<GeoPlace | null> {
  const q = encodeURIComponent(`${city}, ${state}`);
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json` +
    `?access_token=${mapboxToken()}&types=place,locality,neighborhood&country=us&limit=3`;
  const { ok, status, body } = await fetchJson(url, {}, billedFetch);
  if (!ok) {
    if (status === 401 || status === 403) tripMapbox(`HTTP ${status}`);
    throw new Error(`Mapbox geocoding failed: ${status}`);
  }
  const feats: any[] = body?.features ?? [];
  if (!feats.length) return null;
  const want = state.trim().toUpperCase();
  // Prefer the candidate in the REQUESTED state: a same-named city elsewhere
  // must never hijack a scan's geography.
  const f =
    feats.find((x) => {
      const region = (x.context ?? []).find((c: any) => String(c.id).startsWith("region"));
      const code = String(region?.short_code ?? "").replace(/^US-/i, "").toUpperCase();
      return code === want;
    }) ?? feats[0];
  const bbox: GeoBbox =
    f.bbox?.length === 4
      ? padBbox({ west: f.bbox[0], south: f.bbox[1], east: f.bbox[2], north: f.bbox[3] })
      : { west: f.center[0] - 0.05, south: f.center[1] - 0.05, east: f.center[0] + 0.05, north: f.center[1] + 0.05 };
  return { bbox, center: [f.center[0], f.center[1]], name: f.text ?? city, source: "mapbox" };
}

async function nominatimPlace(city: string, state: string): Promise<GeoPlace | null> {
  const url = new URL("/search", nominatimBase());
  url.searchParams.set("q", `${city}, ${state}, USA`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "us");
  const { ok, status, body } = await nominatimPaced(() =>
    fetchJson(url.toString(), { "User-Agent": NOMINATIM_UA, Accept: "application/json" }),
  );
  if (!ok) throw new Error(`Nominatim geocoding failed: ${status}`);
  const rows: any[] = Array.isArray(body) ? body : [];
  const want = state.trim().toUpperCase();
  // Same state guard as the Mapbox branch, and a populated-place guard: a
  // bare `limit=1` returns "Monroe County" for "Monroe, Iowa".
  const isPlace = (r: any) =>
    ["city", "town", "village", "hamlet", "municipality", "borough"].includes(
      String(r.addresstype ?? r.type ?? "").toLowerCase(),
    );
  const inState = rows.filter((r) => stateFromNominatim(r.address) === want);
  const pool = inState.length ? inState : rows;
  const hit = pool.find(isPlace) ?? pool[0];
  if (!hit) return null;
  const bb = hit.boundingbox?.map(Number);
  if (!bb || bb.length !== 4 || bb.some((n: number) => !Number.isFinite(n))) return null;
  // Nominatim boundingbox order is [south, north, west, east].
  const bbox = padBbox({ south: bb[0], north: bb[1], west: bb[2], east: bb[3] });
  return {
    bbox,
    center: [Number(hit.lon), Number(hit.lat)],
    name: String(hit.name ?? city),
    source: "nominatim",
  };
}

/** A city/town name → its bounding box. null = no such place; throws = lookup down. */
export async function geocodePlace(city: string, state: string): Promise<GeoPlace | null> {
  const key = `${city.trim().toLowerCase()},${state.trim().toLowerCase()}`;
  if (placeCache.has(key)) return placeCache.get(key)!;

  const errors: string[] = [];
  const providers: Array<[GeoSource, () => Promise<GeoPlace | null>]> = [];
  if (mapboxAvailable()) providers.push(["mapbox", () => mapboxPlace(city, state)]);
  providers.push(["nominatim", () => nominatimPlace(city, state)]);

  for (const [name, run] of providers) {
    try {
      const hit = await run();
      if (hit) {
        placeCache.set(key, hit);
        bounded(placeCache, 2000);
        return hit;
      }
    } catch (e: any) {
      errors.push(`${name}: ${e?.message ?? e}`);
      logProviderError(name, "place", e, { city, state });
    }
  }
  if (errors.length === providers.length) {
    structuredLog("geocode.all_providers_failed", { op: "place", city, state, errors: errors.join(" | ") }, "error");
    throw new Error(`Place lookup is unavailable (${errors.join("; ")})`);
  }
  placeCache.set(key, null); // a provider answered: this place does not exist
  return null;
}

/**
 * Which providers are actually usable right now, for the admin diagnostic
 * endpoint. This is the alarm that a silent token death trips: `usable` false
 * means address lookup is running on nothing.
 */
export function geocoderStatus(): {
  usable: boolean;
  providers: Array<{ name: GeoSource; configured: boolean; available: boolean; note?: string }>;
} {
  const hasToken = Boolean(mapboxToken());
  const mapboxUp = mapboxAvailable();
  const providers = [
    {
      name: "mapbox" as const,
      configured: hasToken,
      available: mapboxUp,
      note: !hasToken
        ? "no MAPBOX_TOKEN / MAPBOX_PUBLIC_TOKEN set"
        : mapboxUp
          ? undefined
          : `skipped until ${new Date(mapboxOpenUntil).toISOString()} after ${mapboxLastError}`,
    },
    { name: "nominatim" as const, configured: true, available: true, note: "free fallback, <1 req/s" },
  ];
  return { usable: providers.some((p) => p.available), providers };
}
