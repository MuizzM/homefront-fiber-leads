// ── Rooftop provider (AUTHORITATIVE, highest precision) ───────────────────────
// Rooftop-accurate address points — the most precise coordinates we can get, so
// it WINS the coordinate on any duplicate (PROVIDER_PRECISION rooftop=0). There's
// no universal free rooftop feed, so this is pluggable: point ROOFTOP_DATASET at a
// JSON array of {address,city,state,zip,lat,lng} OR a GeoJSON FeatureCollection of
// address points (Microsoft Building Footprints w/ addresses, a county rooftop
// export, etc.). Until one is configured it reports unavailable — it never
// fabricates points and never adds cost.
import { existsSync, readFileSync } from "node:fs";
import type { AddressProvider, BBox, ProviderResult, RawAddress } from "./types";

let _cache: { addresses: RawAddress[]; extent: BBox | null } | null = null;

function datasetPath(): string { return process.env.ROOFTOP_DATASET ?? ""; }

function load(): { addresses: RawAddress[]; extent: BBox | null } {
  if (_cache) return _cache;
  const path = datasetPath();
  const addresses: RawAddress[] = [];
  if (path && existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const rows: any[] = Array.isArray(raw) ? raw
        : Array.isArray(raw?.features) ? raw.features.map((ft: any) => ({
            address: ft.properties?.address ?? ft.properties?.ADDRESS ?? "",
            city: ft.properties?.city ?? "", state: ft.properties?.state ?? "NC", zip: ft.properties?.zip ?? "",
            lng: ft.geometry?.coordinates?.[0], lat: ft.geometry?.coordinates?.[1],
          }))
        : [];
      for (const r of rows) {
        if (r && r.address && r.lat != null && r.lng != null) {
          addresses.push({ address: r.address, city: r.city ?? "", state: r.state ?? "NC", zip: r.zip ?? "", lat: r.lat, lng: r.lng });
        }
      }
    } catch { /* bad dataset — treated as empty/unavailable */ }
  }
  let extent: BBox | null = null;
  for (const a of addresses) {
    if (a.lat == null || a.lng == null) continue;
    if (!extent) extent = { south: a.lat, north: a.lat, west: a.lng, east: a.lng };
    else {
      extent.south = Math.min(extent.south, a.lat); extent.north = Math.max(extent.north, a.lat);
      extent.west = Math.min(extent.west, a.lng); extent.east = Math.max(extent.east, a.lng);
    }
  }
  _cache = { addresses, extent };
  return _cache;
}

function intersects(a: BBox, b: BBox): boolean {
  return !(a.west > b.east || a.east < b.west || a.south > b.north || a.north < b.south);
}

export const rooftopProvider: AddressProvider = {
  name: "rooftop",
  coverageClass: "authoritative",
  available: () => load().addresses.length > 0,
  async enumerate(bbox: BBox): Promise<ProviderResult> {
    const t0 = Date.now();
    const base = { provider: "rooftop" as const, coverageClass: "authoritative" as const };
    const { addresses, extent } = load();
    if (!extent || !intersects(bbox, extent)) {
      return { ...base, addresses: [], partial: true, error: "no rooftop coverage for this bbox", ms: Date.now() - t0 };
    }
    const inBox = addresses.filter((a) => a.lat! >= bbox.south && a.lat! <= bbox.north && a.lng! >= bbox.west && a.lng! <= bbox.east);
    return { ...base, addresses: inBox, partial: false, ms: Date.now() - t0 };
  },
};

