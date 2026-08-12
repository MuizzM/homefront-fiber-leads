// ── Importing county E911 address points (NC OneMap) ────────────────────────
//
// Source: the state's AddressNC service, which aggregates the 100 counties'
// E911 address point files - the authoritative "what is addressable and where"
// dataset, the same one dispatch routes ambulances with. Public, no key, no
// quota, and licensed for exactly this.
//
//   https://services.gis.nc.gov/secure/rest/services/AddressNC/NC1Map_Addresses/MapServer/0
//
// ── PAGINATION IS NOT OPTIONAL ─────────────────────────────────────────────
//
// The service caps every response at 2,000 features and reports the cap with
// `exceededTransferLimit`. Rowan alone is tens of thousands of points, so a
// single query silently returns a 2,000-row PREFIX - which looks like a
// successful import of a small county. Every page is therefore requested with
// an explicit offset and the loop only stops when a page comes back short AND
// the service stops flagging the limit.
//
// ── WHY ORDER BY IS REQUIRED FOR CORRECTNESS ───────────────────────────────
//
// Offset pagination over an unordered result set is undefined: the server may
// return rows in a different order per request, so paging with offsets can
// skip and duplicate rows. `orderByFields=objectid` makes the sequence stable.
// Duplicates would be absorbed by the unique index anyway; SKIPS would not,
// and would silently leave holes in a rep's map.

import { upsertAddressPoints, type AddressPointInput } from "./addressPointStore";

const SERVICE =
  "https://services.gis.nc.gov/secure/rest/services/AddressNC/NC1Map_Addresses/MapServer/0/query";

const SOURCE = "nc-onemap";
const PAGE = 2000;             // the service's own maxRecordCount
const MAX_PAGES = 500;         // 1M points; a runaway guard, not a real limit

export interface ImportProgress {
  page: number;
  fetched: number;
  inserted: number;
  updated: number;
}

export interface ImportResult {
  county: string;
  fetched: number;
  inserted: number;
  updated: number;
  pages: number;
  truncated: boolean;
}

/** ArcGIS attribute row -> our shape. Returns null for rows we cannot place. */
function toPoint(f: any): AddressPointInput | null {
  const a = f?.attributes ?? {};
  const g = f?.geometry ?? {};
  const lat = Number(g.y), lng = Number(g.x);
  // A point with no coordinate is useless to both features this feeds, and
  // 0,0 is the classic "projection failed" value rather than a real place.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;

  const street = String(a.st_address ?? "").trim();
  if (!street) return null;

  const uniqueId = String(a.uniqueid ?? a.objectid ?? "").trim();
  if (!uniqueId) return null;

  return {
    source: SOURCE,
    sourceId: uniqueId,
    houseNumber: a.add_number != null && String(a.add_number).trim() !== ""
      ? String(a.add_number).trim()
      : null,
    street,
    fullAddress: String(a.full_address ?? street).trim(),
    // post_comm is the postal community - the town a rep would actually say.
    city: a.post_comm ? String(a.post_comm).trim() : null,
    state: "NC",
    zip: a.post_code ? String(a.post_code).trim() : null,
    county: a.county ? String(a.county).trim() : null,
    lat,
    lng,
  };
}

async function fetchPage(county: string, offset: number): Promise<{ features: any[]; exceeded: boolean }> {
  const params = new URLSearchParams({
    where: `county='${county.toUpperCase().replace(/'/g, "''")}'`,
    outFields: "objectid,uniqueid,add_number,st_address,full_address,post_code,post_comm,county",
    returnGeometry: "true",
    outSR: "4326",
    // See the header: offset paging without a stable order can skip rows.
    orderByFields: "objectid",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    f: "json",
  });

  const res = await fetch(`${SERVICE}?${params}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`AddressNC responded ${res.status}`);

  const body = await res.json() as any;
  // ArcGIS reports failures as HTTP 200 with an `error` body, so a status
  // check alone would treat an outage as an empty county and "succeed".
  if (body?.error) {
    throw new Error(`AddressNC error ${body.error.code}: ${body.error.message}`);
  }
  return { features: body?.features ?? [], exceeded: !!body?.exceededTransferLimit };
}

/**
 * Import every address point for one county.
 *
 * Idempotent: re-running updates in place via the unique (source, source_id)
 * index, so this is safe to re-run when a county reissues its file.
 */
export async function importCountyAddressPoints(
  county: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
  let offset = 0, pages = 0, fetched = 0, inserted = 0, updated = 0;
  let truncated = false;

  for (; pages < MAX_PAGES; pages++) {
    const { features, exceeded } = await fetchPage(county, offset);
    if (features.length === 0) break;

    const points = features.map(toPoint).filter((p): p is AddressPointInput => p !== null);
    const r = upsertAddressPoints(points);
    inserted += r.inserted;
    updated += r.updated;
    fetched += features.length;
    offset += features.length;

    onProgress?.({ page: pages + 1, fetched, inserted, updated });

    // A short page with no limit flag is the genuine end of the county.
    if (features.length < PAGE && !exceeded) break;
  }
  if (pages >= MAX_PAGES) truncated = true;

  return { county, fetched, inserted, updated, pages, truncated };
}
