// ── Official address points (county E911 / NC OneMap) ───────────────────────
//
// Every addressable structure in the state, with its house number and a
// lat/lng, imported from the authoritative source rather than inferred.
//
// ── WHY THIS TABLE EXISTS ──────────────────────────────────────────────────
//
// Two features need to know where the houses ARE, not just where our leads are:
//
//   · House numbers on the map. This used to come from Mapbox's vector tiles
//     (`ensureHousenumLayer` querying the `composite` source). Raster basemap
//     tiles have no queryable features, so that layer went dark when the map
//     moved to MapLibre + raster imagery. Numbers now come from here, which is
//     strictly better: they are OUR data, styled by us, present at whatever
//     zoom we choose, and identical whoever serves the imagery.
//
//   · Lasso a block, get a lead per door. Previously a rep drew a shape and it
//     selected the leads that ALREADY existed inside it. To create a lead for
//     every house in the shape, something has to know every house in the shape.
//
// ── NOT TENANT-SCOPED, ON PURPOSE ──────────────────────────────────────────
//
// This is public reference data. 4 Elm St is at the same coordinates for every
// tenant, and a per-tenant copy would multiply millions of rows by the tenant
// count to store identical facts. Leads created FROM these points are of
// course tenant-scoped as usual; the points themselves are shared.
//
// ── WHY A LOCAL TABLE RATHER THAN A LIVE PROXY ─────────────────────────────
//
// The upstream ArcGIS service caps at 2,000 records per request and is a
// third party with no uptime commitment to us. Proxying it per viewport would
// put a rep's basemap labels behind someone else's rate limit, on LTE, at the
// door. Importing once per county makes both features a local indexed read.

import { rawDb } from "./db";
import { pointInPolygon } from "@shared/geo";
import { canonicalAddressPart, premiseBaseKey } from "@shared/addressKey";

export interface AddressPoint {
  id: number;
  houseNumber: string | null;
  street: string;
  fullAddress: string;
  city: string | null;
  state: string;
  zip: string | null;
  county: string | null;
  lat: number;
  lng: number;
}

export interface AddressPointInput {
  sourceId: string;
  source: string;
  houseNumber: string | null;
  street: string;
  fullAddress: string;
  city: string | null;
  state: string;
  zip: string | null;
  county: string | null;
  lat: number;
  lng: number;
}

let migrated = false;

export function ensureAddressPointSchema(): void {
  if (migrated) return;
  migrated = true;

  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS address_points (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      house_number  TEXT,
      street        TEXT NOT NULL,
      full_address  TEXT NOT NULL,
      city          TEXT,
      state         TEXT NOT NULL,
      zip           TEXT,
      county        TEXT,
      lat           REAL NOT NULL,
      lng           REAL NOT NULL,
      canonical_key TEXT NOT NULL,
      imported_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Re-importing a county must UPDATE rather than duplicate: E911 files are
  // reissued as addresses are corrected, and a second import of the same
  // county would otherwise double every house number on the map.
  rawDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS address_points_source_uq
              ON address_points(source, source_id)`);

  // ── The spatial index ────────────────────────────────────────────────────
  //
  // A B-tree on (lat, lng) is the obvious choice and it is the wrong one: a
  // composite B-tree can only range-scan its LAST used column, so
  // `lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?` uses the index for lat and
  // then filters lng row by row. EXPLAIN QUERY PLAN says so out loud:
  //   SEARCH address_points USING COVERING INDEX ... (lat>? AND lat<?)
  // For one county that is a 0.7ms viewport query. Statewide NC is ~5.5M
  // address points, where a single latitude band is hundreds of thousands of
  // rows - scanned on every pan, on a phone, at a door.
  //
  // SQLite's R-tree module indexes both dimensions properly, so a viewport
  // costs O(log n) in the area queried rather than O(rows in the lat band).
  // It is a separate virtual table keyed by the same rowid, kept in sync by
  // the upsert below.
  rawDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS address_points_rtree USING rtree(
                id, min_lat, max_lat, min_lng, max_lng
              )`);

  // Used to skip points that already have a lead, so lassoing the same block
  // twice does not try to recreate what is already there.
  rawDb.exec(`CREATE INDEX IF NOT EXISTS address_points_canonical
              ON address_points(canonical_key)`);

  // Backfill. `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op on an install
  // that already has the base table populated from an earlier import, which
  // would leave the R-tree empty - and since every read goes THROUGH it, the
  // map would show no house numbers and a lasso would find no doors, on a
  // database that visibly contains hundreds of thousands of them. Silent and
  // total. One counted query at boot is cheap insurance against that.
  const baseCount = (rawDb.prepare(`SELECT count(*) AS n FROM address_points`).get() as any).n as number;
  if (baseCount > 0) {
    const rtreeCount = (rawDb.prepare(`SELECT count(*) AS n FROM address_points_rtree`).get() as any).n as number;
    if (rtreeCount < baseCount) {
      rawDb.exec(`
        INSERT OR REPLACE INTO address_points_rtree (id, min_lat, max_lat, min_lng, max_lng)
        SELECT id, lat, lat, lng, lng FROM address_points
      `);
    }
  }
}

/** Same key the lead tables use, so a point and its lead can be matched. */
export function addressPointKey(p: { street: string; city: string | null; state: string }): string {
  return premiseBaseKey(p.street, p.city ?? "", p.state);
}

/**
 * Idempotent bulk upsert. Returns how many rows were new.
 *
 * Wrapped in one transaction per batch: better-sqlite3 is synchronous, and a
 * statement-per-row import of a county (tens of thousands of points) spends
 * essentially all its time in fsync without it.
 */
export function upsertAddressPoints(points: AddressPointInput[]): { inserted: number; updated: number } {
  ensureAddressPointSchema();
  const before = countAddressPoints();

  const stmt = rawDb.prepare(`
    INSERT INTO address_points
      (source, source_id, house_number, street, full_address, city, state, zip, county, lat, lng, canonical_key, imported_at)
    VALUES
      (@source, @sourceId, @houseNumber, @street, @fullAddress, @city, @state, @zip, @county, @lat, @lng, @canonicalKey, datetime('now'))
    ON CONFLICT(source, source_id) DO UPDATE SET
      house_number  = excluded.house_number,
      street        = excluded.street,
      full_address  = excluded.full_address,
      city          = excluded.city,
      state         = excluded.state,
      zip           = excluded.zip,
      county        = excluded.county,
      lat           = excluded.lat,
      lng           = excluded.lng,
      canonical_key = excluded.canonical_key,
      imported_at   = datetime('now')
  `);

  // The R-tree stores a degenerate box (a point), which is what rtree wants for
  // point data. INSERT OR REPLACE keeps it correct when a re-import moves a
  // corrected address to new coordinates.
  const rtreeStmt = rawDb.prepare(`
    INSERT OR REPLACE INTO address_points_rtree (id, min_lat, max_lat, min_lng, max_lng)
    VALUES (?, ?, ?, ?, ?)
  `);
  const idStmt = rawDb.prepare(`SELECT id FROM address_points WHERE source = ? AND source_id = ?`);

  const run = rawDb.transaction((rows: AddressPointInput[]) => {
    for (const p of rows) {
      stmt.run({
        source: p.source,
        sourceId: p.sourceId,
        houseNumber: p.houseNumber,
        street: p.street,
        fullAddress: p.fullAddress,
        city: p.city,
        state: p.state,
        zip: p.zip,
        county: p.county,
        lat: p.lat,
        lng: p.lng,
        canonicalKey: addressPointKey(p),
      });
      const row = idStmt.get(p.source, p.sourceId) as { id: number } | undefined;
      if (row) rtreeStmt.run(row.id, p.lat, p.lat, p.lng, p.lng);
    }
  });
  run(points);

  const after = countAddressPoints();
  const inserted = after - before;
  return { inserted, updated: points.length - inserted };
}

export function countAddressPoints(): number {
  ensureAddressPointSchema();
  return (rawDb.prepare(`SELECT count(*) AS n FROM address_points`).get() as any).n as number;
}

const ROW_TO_POINT = (r: any): AddressPoint => ({
  id: r.id,
  houseNumber: r.house_number,
  street: r.street,
  fullAddress: r.full_address,
  city: r.city,
  state: r.state,
  zip: r.zip,
  county: r.county,
  lat: r.lat,
  lng: r.lng,
});

/**
 * Points inside a viewport, for the house-number layer.
 *
 * `limit` is a HARD cap, not a suggestion: a rep who zooms out over a whole
 * county would otherwise pull hundreds of thousands of rows to draw labels
 * that would be unreadable anyway. Callers get `truncated` and are expected to
 * hide the layer rather than draw a partial, arbitrary subset - a map that
 * shows house numbers for a random 5,000 of 80,000 houses is worse than one
 * that shows none, because a rep cannot tell which is which.
 */
export function addressPointsInBbox(
  west: number, south: number, east: number, north: number, limit = 4000,
): { points: AddressPoint[]; truncated: boolean } {
  ensureAddressPointSchema();
  const rows = rawDb.prepare(`
    SELECT p.id, p.house_number, p.street, p.full_address, p.city, p.state, p.zip, p.county, p.lat, p.lng
    FROM address_points_rtree r
    JOIN address_points p ON p.id = r.id
    WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lng >= ? AND r.min_lng <= ?
    LIMIT ?
  `).all(south, north, west, east, limit + 1) as any[];

  const truncated = rows.length > limit;
  return { points: rows.slice(0, limit).map(ROW_TO_POINT), truncated };
}

/**
 * Points by premise key (addressPointKey), for geocoding an imported address
 * against the county file before anything is paid for. Chunked IN queries on
 * the canonical_key index; the first point per key wins (a duplex listed twice
 * shares coordinates anyway).
 */
export function lookupAddressPointsByKeys(keys: string[]): Map<string, AddressPoint> {
  ensureAddressPointSchema();
  const out = new Map<string, AddressPoint>();
  const list = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const rows = rawDb.prepare(`
      SELECT id, house_number, street, full_address, city, state, zip, county, lat, lng, canonical_key
      FROM address_points WHERE canonical_key IN (${chunk.map(() => "?").join(",")})
    `).all(...chunk) as any[];
    for (const r of rows) if (!out.has(r.canonical_key)) out.set(r.canonical_key, ROW_TO_POINT(r));
  }
  return out;
}

/**
 * The nearest address points to a tapped spot, for snapping a tap-to-add to
 * the county file before paying for a reverse geocode.
 *
 * A padded bbox does the indexed cut (R-tree), then a haversine sort over the
 * few survivors. `radiusM` is small on purpose: a tap is on or beside a roof,
 * and the house next door is 20 to 30 m away, so 45 m says "this house" and
 * anything farther is honestly "no county match here".
 */
export function nearestAddressPoints(
  lat: number, lng: number, radiusM = 45, limit = 3,
): Array<AddressPoint & { meters: number }> {
  ensureAddressPointSchema();
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const rows = rawDb.prepare(`
    SELECT p.id, p.house_number, p.street, p.full_address, p.city, p.state, p.zip, p.county, p.lat, p.lng
    FROM address_points_rtree r
    JOIN address_points p ON p.id = r.id
    WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lng >= ? AND r.min_lng <= ?
    LIMIT 64
  `).all(lat - dLat, lat + dLat, lng - dLng, lng + dLng) as any[];
  const toRad = (d: number) => (d * Math.PI) / 180;
  const out = rows.map(ROW_TO_POINT).map((p) => {
    const a = toRad(p.lat - lat), b = toRad(p.lng - lng);
    const h = Math.sin(a / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(p.lat)) * Math.sin(b / 2) ** 2;
    return { ...p, meters: 2 * 6371000 * Math.asin(Math.sqrt(h)) };
  }).filter((p) => p.meters <= radiusM);
  out.sort((x, y) => x.meters - y.meters || x.id - y.id);
  return out.slice(0, limit);
}

/**
 * Points inside a lasso ring.
 *
 * Two stages on purpose. SQLite here has no spatial index, so the bbox does
 * the cheap indexed cut and the ray-cast runs only over what survives it -
 * the same `pointInPolygon` the lead selection uses, so a lasso that selects a
 * house and a lasso that creates one can never disagree about what "inside"
 * means.
 */
export function addressPointsInRing(
  ring: Array<[number, number]>, limit = 5000,
): { points: AddressPoint[]; truncated: boolean } {
  ensureAddressPointSchema();
  if (ring.length < 3) return { points: [], truncated: false };

  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  const rows = rawDb.prepare(`
    SELECT p.id, p.house_number, p.street, p.full_address, p.city, p.state, p.zip, p.county, p.lat, p.lng
    FROM address_points_rtree r
    JOIN address_points p ON p.id = r.id
    WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lng >= ? AND r.min_lng <= ?
  `).all(south, north, west, east) as any[];

  const out: AddressPoint[] = [];
  for (const r of rows) {
    if (out.length >= limit) return { points: out, truncated: true };
    if (pointInPolygon(r.lat, r.lng, ring)) out.push(ROW_TO_POINT(r));
  }
  return { points: out, truncated: false };
}

/** Test seam. */
export function _resetAddressPointsForTests(): void {
  ensureAddressPointSchema();
  rawDb.exec(`DELETE FROM address_points`);
  rawDb.exec(`DELETE FROM address_points_rtree`);
}

/**
 * One label per street in the viewport, for the street-name layer.
 *
 * The basemap is bare imagery now (see basemapStyles.ts), so these replace
 * Google's baked-in road labels. Derived from the SAME address points as the
 * house numbers, which is the point: one source, so a street can never be
 * named one thing by the basemap and another by our own data.
 *
 * Placement is the centroid of that street's points inside the viewport, not a
 * road centreline - we have address points, not road geometry. In practice the
 * centroid of the houses on a street sits on or beside the street, which is
 * where a reader expects the name.
 */
export function streetLabelsInBbox(
  west: number, south: number, east: number, north: number, maxStreets = 60,
): Array<[number, number, string]> {
  ensureAddressPointSchema();
  const rows = rawDb.prepare(`
    SELECT p.street, p.lat, p.lng
    FROM address_points_rtree r
    JOIN address_points p ON p.id = r.id
    WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lng >= ? AND r.min_lng <= ?
    LIMIT 20000
  `).all(south, north, west, east) as any[];

  // Accumulate sums rather than collecting points per street: a dense viewport
  // is tens of thousands of rows and the arrays would be pure garbage.
  const acc = new Map<string, { lat: number; lng: number; n: number }>();
  for (const r of rows) {
    const name = streetNameOf(r.street);
    if (!name) continue;
    const cur = acc.get(name);
    if (cur) { cur.lat += r.lat; cur.lng += r.lng; cur.n++; }
    else acc.set(name, { lat: r.lat, lng: r.lng, n: 1 });
  }

  // Busiest streets first, so a capped viewport keeps the ones a rep is most
  // likely to be standing on rather than an arbitrary alphabetical slice.
  return [...acc.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, maxStreets)
    .map(([name, v]) => [v.lng / v.n, v.lat / v.n, name] as [number, number, string]);
}

/**
 * "955 CANNON STREET" -> "Cannon Street".
 *
 * E911 stores the house number inside the street string, so the leading
 * numeric token is dropped. Titled rather than left SHOUTING: the source is
 * all-caps and a map of capitals reads as an error message.
 */
export function streetNameOf(stAddress: string | null | undefined): string {
  if (!stAddress) return "";
  const withoutNumber = String(stAddress).trim().replace(/^[0-9]+[A-Za-z]?\s+/, "");
  if (!withoutNumber) return "";
  return withoutNumber
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// ── Forward lookup: a typed address → the E911 point for that house ─────────
//
// The rep's search box used to depend entirely on a paid provider being alive.
// It is not: this table already holds every addressable structure in the
// imported counties, and `canonical_key` is already a PER-HOUSE key
// ("117 CARRIAGE LN|SALISBURY|NC"), built by the same premiseBaseKey() the lead
// tables use. So the exact address a rep types can be answered from our own
// data - free, offline, and with no token to expire.
//
// Deliberately HOUSE-LEVEL only. The street part must begin with a house
// number, so "Salisbury, NC" or "Carriage Ln" fall through to the geocoders
// rather than matching some arbitrary point on the street: a confident wrong
// pin is worse than no pin. A miss returns null and the caller pays a provider
// exactly as before.

/** A free-text address split into the parts premiseBaseKey needs. */
export function parseAddressQuery(query: string): {
  street: string; city: string; state: string | null; zip: string | null;
} | null {
  const parts = String(query ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const street = parts[0];
  // House-level only: a leading number is what makes this lookup unambiguous.
  if (!/^\d/.test(street)) return null;

  // Everything after the street is re-joined and tokenized, so the comma-less
  // tail ("Salisbury NC 28146") parses the same as the comma-separated one.
  const rest = parts.slice(1).join(" ").trim().split(/\s+/).filter(Boolean);
  let zip: string | null = null;
  let state: string | null = null;
  if (rest.length && /^\d{5}(-\d{4})?$/.test(rest[rest.length - 1])) {
    zip = rest.pop()!.slice(0, 5);
  }
  if (rest.length && /^[A-Za-z]{2}$/.test(rest[rest.length - 1])) {
    state = rest.pop()!.toUpperCase();
  }
  const city = rest.join(" ");
  if (!city) return null;
  return { street, city, state, zip };
}

/**
 * The E911 point for a typed address, or null when we do not hold it.
 *
 * With a state, this is an equality hit on the canonical_key index. Without one
 * ("117 Carriage Ln, Salisbury"), it is a RANGE scan over the same index rather
 * than a LIKE: SQLite's LIKE is case-insensitive for ASCII and would refuse the
 * index, turning a rep's keystroke into a full table scan of a million rows.
 */
export function lookupAddressPointByAddress(query: string): AddressPoint | null {
  ensureAddressPointSchema();
  const parsed = parseAddressQuery(query);
  if (!parsed) return null;

  const { street, city, state, zip } = parsed;
  let rows: any[];
  if (state) {
    rows = rawDb.prepare(
      `SELECT * FROM address_points WHERE canonical_key = ? LIMIT 25`,
    ).all(premiseBaseKey(street, city, state));
  } else {
    const prefix = `${canonicalAddressPart(street)}|${canonicalAddressPart(city)}|`;
    rows = rawDb.prepare(
      `SELECT * FROM address_points
        WHERE canonical_key >= ? AND canonical_key < ?
        LIMIT 25`,
    ).all(prefix, `${prefix}￿`);
  }
  if (rows.length === 0) return null;

  // A typed ZIP is a tiebreaker, never a filter: the state E911 rows carry the
  // postal ZIP and a rep may type the mailing one, so a ZIP that matches wins
  // and a ZIP that matches nothing still returns the address.
  if (zip) {
    const exact = rows.find((r) => String(r.zip ?? "").slice(0, 5) === zip);
    if (exact) return ROW_TO_POINT(exact);
  }
  return ROW_TO_POINT(rows[0]);
}
