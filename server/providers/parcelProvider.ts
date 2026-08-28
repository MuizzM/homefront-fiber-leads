// ── Parcel provider (AUTHORITATIVE) ───────────────────────────────────────────
// County GIS parcel records — the closest thing to "every address that officially
// exists here". Used as the DENOMINATOR for coverage: if Mapbox found 60% of the
// parcels, we know we're missing 40% and can go get them. Loads every
// `*_gis_addresses.json` in server/ (Rockwell today; drop in more counties).
//
// Crucially it only claims authority WHERE it has data: a bbox outside every
// loaded parcel extent returns partial=true so coverage never treats "no parcel
// file for this town" as "no addresses exist here".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressProvider, BBox, ProviderResult, RawAddress } from "./types";

interface Loaded { addresses: RawAddress[]; extent: BBox | null }
let _cache: Loaded | null = null;

function serverDir(): string | null {
  // `__dirname` exists in the CJS production bundle (script/build.ts formats
  // "cjs") but NOT under `npm run dev`, which runs ESM through tsx. Bare
  // `__dirname` there is a ReferenceError, and this call sits outside any
  // try/catch - so /api/coverage/preview answered
  // `{"error":"__dirname is not defined"}` in dev while working in production.
  //
  // Same guard the rest of the codebase already uses for this (see
  // server/cspHashes.ts:70 and server/onboardingPdf.ts:33). Returning null lets
  // load() fall through to its cwd candidates, which is what it was already
  // written to do.
  const dir = typeof __dirname === "string" ? __dirname : null;
  if (!dir) return null;
  return dir.includes("providers") ? join(dir, "..") : dir;
}

function load(): Loaded {
  if (_cache) return _cache;
  const addresses: RawAddress[] = [];
  for (const dir of [serverDir(), join(process.cwd(), "server"), process.cwd()]) {
    if (!dir) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('_gis_addresses.json')) continue;
        try {
          const rows = JSON.parse(readFileSync(join(dir, f), "utf-8"));
          if (Array.isArray(rows)) for (const r of rows) {
            if (r && r.address && r.lat != null && r.lng != null) {
              addresses.push({ address: r.address, city: r.city ?? "", state: r.state ?? "NC", zip: r.zip ?? "", lat: r.lat, lng: r.lng });
            }
          }
        } catch { /* skip a bad file */ }
      }
      if (addresses.length) break; // first dir that yields data wins
    } catch { /* dir doesn't exist */ }
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

export const parcelProvider: AddressProvider = {
  name: "parcel",
  coverageClass: "authoritative",
  available: () => load().addresses.length > 0,
  async enumerate(bbox: BBox): Promise<ProviderResult> {
    const t0 = Date.now();
    const base = { provider: "parcel" as const, coverageClass: "authoritative" as const };
    const { addresses, extent } = load();
    // No parcel data for this region → we have NO authority here. Say partial so
    // coverage doesn't read "0 parcels" as "0 addresses exist".
    if (!extent || !intersects(bbox, extent)) {
      return { ...base, addresses: [], partial: true, error: "no parcel coverage for this bbox", ms: Date.now() - t0 };
    }
    const inBox = addresses.filter((a) => a.lat! >= bbox.south && a.lat! <= bbox.north && a.lng! >= bbox.west && a.lng! <= bbox.east);
    return { ...base, addresses: inBox, partial: false, ms: Date.now() - t0 };
  },
};

