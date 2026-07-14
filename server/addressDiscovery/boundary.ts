import crypto from "node:crypto";
import { rawDb } from "../db";
import { validateDiscoveryGeometry } from "@shared/addressDiscovery";
import type { DiscoveryBBox, DiscoveryGeometry } from "./types";
import { geometryBBox } from "./types";

export interface ResolvedBoundary {
  id: string;
  name: string;
  state: string;
  geometry: DiscoveryGeometry;
  bbox: DiscoveryBBox;
  centroid: [number, number] | null;
  source: "nominatim";
  sourceRef: string | null;
  metadata: Record<string, unknown>;
  cached: boolean;
}

let nominatimNextAt = 0;
let nominatimTail = Promise.resolve();

function normalizedKey(name: string, state: string): string {
  return `${name.trim().toLowerCase().replace(/\s+/g, " ")}|${state.trim().toUpperCase()}|US`;
}

function safeBaseUrl(): string {
  const configured =
    process.env.NOMINATIM_BASE_URL?.trim() ||
    "https://nominatim.openstreetmap.org";
  const url = new URL(configured);
  if (url.protocol !== "https:")
    throw new Error("Nominatim endpoint must use HTTPS");
  const official = url.hostname === "nominatim.openstreetmap.org";
  const privateHost =
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(
      url.hostname,
    );
  if (privateHost) throw new Error("Private Nominatim endpoint is not allowed");
  if (!official && process.env.ALLOW_CUSTOM_DISCOVERY_ENDPOINTS !== "true") {
    throw new Error(
      "Custom Nominatim endpoint requires ALLOW_CUSTOM_DISCOVERY_ENDPOINTS=true",
    );
  }
  return url.origin;
}

function validGeometry(value: any): value is DiscoveryGeometry {
  return (
    (value?.type === "Polygon" || value?.type === "MultiPolygon") &&
    Array.isArray(value.coordinates)
  );
}

const STATE_NAMES: Record<string, string> = {
  AL: "ALABAMA",
  AK: "ALASKA",
  AZ: "ARIZONA",
  AR: "ARKANSAS",
  CA: "CALIFORNIA",
  CO: "COLORADO",
  CT: "CONNECTICUT",
  DE: "DELAWARE",
  FL: "FLORIDA",
  GA: "GEORGIA",
  HI: "HAWAII",
  ID: "IDAHO",
  IL: "ILLINOIS",
  IN: "INDIANA",
  IA: "IOWA",
  KS: "KANSAS",
  KY: "KENTUCKY",
  LA: "LOUISIANA",
  ME: "MAINE",
  MD: "MARYLAND",
  MA: "MASSACHUSETTS",
  MI: "MICHIGAN",
  MN: "MINNESOTA",
  MS: "MISSISSIPPI",
  MO: "MISSOURI",
  MT: "MONTANA",
  NE: "NEBRASKA",
  NV: "NEVADA",
  NH: "NEW HAMPSHIRE",
  NJ: "NEW JERSEY",
  NM: "NEW MEXICO",
  NY: "NEW YORK",
  NC: "NORTH CAROLINA",
  ND: "NORTH DAKOTA",
  OH: "OHIO",
  OK: "OKLAHOMA",
  OR: "OREGON",
  PA: "PENNSYLVANIA",
  RI: "RHODE ISLAND",
  SC: "SOUTH CAROLINA",
  SD: "SOUTH DAKOTA",
  TN: "TENNESSEE",
  TX: "TEXAS",
  UT: "UTAH",
  VT: "VERMONT",
  VA: "VIRGINIA",
  WA: "WASHINGTON",
  WV: "WEST VIRGINIA",
  WI: "WISCONSIN",
  WY: "WYOMING",
  DC: "DISTRICT OF COLUMBIA",
};

function featureMatchesState(feature: any, requestedState: string): boolean {
  const properties = feature?.properties ?? {};
  const address = properties.address ?? {};
  const code = String(
    address["ISO3166-2-lvl4"] ??
      properties["ISO3166-2-lvl4"] ??
      address.state_code ??
      "",
  ).toUpperCase();
  if (code === `US-${requestedState}` || code === requestedState) return true;
  const state = String(address.state ?? properties.state ?? "")
    .trim()
    .toUpperCase();
  return state === requestedState || state === STATE_NAMES[requestedState];
}

async function rateLimited<T>(task: () => Promise<T>): Promise<T> {
  const run = nominatimTail.then(async () => {
    const wait = Math.max(0, nominatimNextAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    nominatimNextAt =
      Date.now() +
      Math.max(1_000, Number(process.env.NOMINATIM_MIN_INTERVAL_MS) || 1_100);
    return task();
  });
  nominatimTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function fetchBoundary(
  name: string,
  state: string,
): Promise<ResolvedBoundary> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(5_000, Number(process.env.NOMINATIM_TIMEOUT_MS) || 20_000),
  );
  const query = new URL("/search", safeBaseUrl());
  query.searchParams.set("format", "geojson");
  query.searchParams.set("polygon_geojson", "1");
  query.searchParams.set("addressdetails", "1");
  query.searchParams.set("limit", "10");
  query.searchParams.set("countrycodes", "us");
  query.searchParams.set("q", `${name}, ${state}, USA`);
  try {
    const response = await fetch(query, {
      signal: controller.signal,
      headers: {
        Accept: "application/geo+json, application/json",
        "User-Agent":
          process.env.DISCOVERY_USER_AGENT ||
          "HomeFrontFiber-address-discovery/1.0",
      },
    });
    if (response.status === 429)
      throw new Error("Nominatim rate limit reached; boundary job will retry");
    if (!response.ok)
      throw new Error(`Nominatim boundary request failed (${response.status})`);
    const body = (await response.json()) as any;
    const candidates = (Array.isArray(body?.features) ? body.features : [])
      .filter((item: any) => featureMatchesState(item, state.toUpperCase()))
      .sort(
        (a: any, b: any) =>
          Number(b?.properties?.osm_type === "relation") -
          Number(a?.properties?.osm_type === "relation"),
      );
    const feature = candidates.find((item: any) => {
      if (!validGeometry(item?.geometry)) return false;
      const type = String(
        item?.properties?.type ?? item?.properties?.addresstype ?? "",
      ).toLowerCase();
      const cls = String(
        item?.properties?.category ?? item?.properties?.class ?? "",
      ).toLowerCase();
      return (
        ["city", "town", "municipality", "administrative"].includes(type) ||
        cls === "boundary"
      );
    });
    if (!feature || !validGeometry(feature.geometry)) {
      throw new Error(
        "No administrative Polygon/MultiPolygon was returned; submit a user-drawn boundary instead",
      );
    }
    const geometry = validateDiscoveryGeometry(feature.geometry, {
      maxAreaKm2: 250_000,
    }) as DiscoveryGeometry;
    const bbox = geometryBBox(geometry);
    const center =
      feature.properties?.lat != null && feature.properties?.lon != null
        ? ([Number(feature.properties.lon), Number(feature.properties.lat)] as [
            number,
            number,
          ])
        : ([(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2] as [
            number,
            number,
          ]);
    return {
      id: crypto.randomUUID(),
      name,
      state: state.toUpperCase(),
      geometry,
      bbox,
      centroid: center,
      source: "nominatim",
      sourceRef: feature.properties?.osm_id
        ? `${feature.properties.osm_type ?? "relation"}/${feature.properties.osm_id}`
        : null,
      metadata: {
        displayName: feature.properties?.display_name ?? null,
        placeRank: feature.properties?.place_rank ?? null,
        importance: feature.properties?.importance ?? null,
        licence: body?.licence ?? "OpenStreetMap contributors, ODbL",
      },
      cached: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveTownBoundary(
  tenantId: number,
  name: string,
  state: string,
): Promise<ResolvedBoundary> {
  const key = normalizedKey(name, state);
  const cached = rawDb
    .prepare(
      `SELECT id,name,state,geometry_json AS geometryJson,bbox_json AS bboxJson,
      centroid_json AS centroidJson,source,source_ref AS sourceRef,source_metadata_json AS metadataJson
      FROM town_boundaries WHERE tenant_id=? AND boundary_key=? AND expires_at > datetime('now')`,
    )
    .get(tenantId, key) as any;
  if (cached) {
    return {
      id: cached.id,
      name: cached.name,
      state: cached.state,
      geometry: JSON.parse(cached.geometryJson),
      bbox: JSON.parse(cached.bboxJson),
      centroid: cached.centroidJson ? JSON.parse(cached.centroidJson) : null,
      source: "nominatim",
      sourceRef: cached.sourceRef,
      metadata: JSON.parse(cached.metadataJson || "{}"),
      cached: true,
    };
  }
  const boundary = await rateLimited(() => fetchBoundary(name, state));
  const ttlDays = Math.max(
    1,
    Math.min(365, Number(process.env.BOUNDARY_CACHE_DAYS) || 30),
  );
  rawDb
    .prepare(
      `INSERT INTO town_boundaries
      (id,tenant_id,boundary_key,name,state,country_code,geometry_json,bbox_json,centroid_json,source,source_ref,source_metadata_json,fetched_at,expires_at)
      VALUES (?,?,?,?,?,'US',?,?,?,?,?,?,datetime('now'),datetime('now',?))
      ON CONFLICT(tenant_id,boundary_key) DO UPDATE SET
        name=excluded.name,state=excluded.state,geometry_json=excluded.geometry_json,bbox_json=excluded.bbox_json,
        centroid_json=excluded.centroid_json,source=excluded.source,source_ref=excluded.source_ref,
        source_metadata_json=excluded.source_metadata_json,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,updated_at=datetime('now')`,
    )
    .run(
      boundary.id,
      tenantId,
      key,
      name,
      state.toUpperCase(),
      JSON.stringify(boundary.geometry),
      JSON.stringify(boundary.bbox),
      JSON.stringify(boundary.centroid),
      boundary.source,
      boundary.sourceRef,
      JSON.stringify(boundary.metadata),
      `+${ttlDays} days`,
    );
  return boundary;
}

export function localityLabelFromAddress(
  address: Record<string, unknown>,
): string {
  const direct = String(
    address.city ??
      address.town ??
      address.village ??
      address.hamlet ??
      address.suburb ??
      address.neighbourhood ??
      address.municipality ??
      "",
  ).trim();
  if (direct) return direct;
  // Rural subdivisions often reverse-geocode only to a county. A missing city
  // must not block address enumeration; individual Mapbox/OSM records can still
  // supply their more precise locality during canonicalization.
  return String(address.county ?? "").trim();
}

export async function resolvePointLocality(
  lng: number,
  lat: number,
): Promise<{ city: string; state: string; countryCode: "US" }> {
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90
  ) {
    throw new Error("Invalid locality coordinate");
  }
  return rateLimited(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(5_000, Number(process.env.NOMINATIM_TIMEOUT_MS) || 20_000),
    );
    const url = new URL("/reverse", safeBaseUrl());
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("zoom", "12");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent":
            process.env.DISCOVERY_USER_AGENT ||
            "HomeFrontFiber-address-discovery/1.0",
        },
      });
      if (response.status === 429)
        throw new Error(
          "Nominatim rate limit reached; locality job will retry",
        );
      if (!response.ok)
        throw new Error(
          `Nominatim locality request failed (${response.status})`,
        );
      const body = (await response.json()) as any;
      const address = body?.address ?? {};
      if (String(address.country_code ?? "").toLowerCase() !== "us")
        throw new Error("Discovery geometry must be inside the United States");
      const city = localityLabelFromAddress(address);
      const iso = String(address["ISO3166-2-lvl4"] ?? "").toUpperCase();
      let state = iso.startsWith("US-") ? iso.slice(3) : "";
      if (!state) {
        const requested = String(address.state ?? "")
          .trim()
          .toUpperCase();
        state =
          Object.entries(STATE_NAMES).find(
            ([, name]) => name === requested,
          )?.[0] ?? "";
      }
      if (!city || !/^[A-Z]{2}$/.test(state))
        throw new Error(
          "Could not resolve a US city/state for the selected geometry",
        );
      return { city, state, countryCode: "US" };
    } finally {
      clearTimeout(timeout);
    }
  });
}
