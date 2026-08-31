// ── New Build Radar — data sources ────────────────────────────────────────────
// Pluggable, FREE-ONLY incremental sources for newly-appearing NC/SC/GA addresses
// and buildings (NC/SC have authoritative feeds; GA is OSM-Overpass-only for now,
// tracked as a coverage GAP). NEVER uses Mapbox (billing-incident history) or the
// Decodo proxy —
// these are public government / OSM datasets fetched direct. Each source is
// incremental: it returns only records that appeared since the last cursor, so a
// tick surfaces genuine NEW builds, not the whole county.
//
//  • NC OneMap AddressNC (authoritative statewide NC address points): incremental
//    via an objectid high-water-mark per county (ArcGIS auto-increments objectid on
//    insert, so objectid > cursor = addresses added since last poll). Seeded on
//    first contact so we never flood the pipeline with the existing backlog.
//  • SC county authoritative address points (sc_county_addr): SC has NO public
//    statewide address FeatureServer (verified 2026-07: AGOL search 0 results,
//    scarng-gis.sc.gov hosts only county boundaries, RFA 911 address data is not
//    published as open REST), so the authoritative feeds are per-county E911/GIS
//    ArcGIS layers. Each wired endpoint was live-probed (count + ordered query +
//    outSR=4326) before inclusion; incremental via the same objectid
//    high-water-mark pattern as NC OneMap.
//  • OSM Overpass `newer:` (NC AND SC): new residential building ways + addr nodes
//    since the last poll timestamp; also surfaces ADDRESSLESS new buildings to
//    monitor until an address appears.
//
// Remaining SC gaps (no public ArcGIS REST): statewide RFA, Cherokee (qPublic
// only), Union (WTH GIS only) — tracked as coverage GAPS by the radar rather
// than silently substituted.

export interface NewBuildCandidate {
  source: string;                 // "nc_onemap" | "sc_county_addr" | "osm_overpass"
  sourceRecordId: string;         // stable id within the source (objectid / osm id)
  address: string | null;         // null = addressless building (monitored)
  city: string | null;
  state: "NC" | "SC" | "GA";
  zip: string | null;
  county: string | null;
  lat: number | null;
  lng: number | null;
  buildStage: "addressed" | "addressless";
  confidence: "authoritative" | "observed";
  detectedAt: number;             // ms
}

export interface SourcePollResult {
  source: string;
  scope: string;                  // county name or bbox key
  candidates: NewBuildCandidate[];
  cursor: string;                 // new high-water-mark to persist
  seeded: boolean;                // true = first contact, cursor set without ingesting backlog
  recordsSeen: number;
  ok: boolean;
  note: string | null;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;

const UA = "HomeFrontFiber-NewBuildRadar/1.0 (operations@homefrontsolutions.com)";

// ── NC OneMap ─────────────────────────────────────────────────────────────────
const NC_ONEMAP_LAYER =
  "https://services.nconemap.gov/secure/rest/services/AddressNC/NC1Map_Addresses/FeatureServer/0";

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/** Build the ONE authoritative address string from NC OneMap fields. */
function ncAddress(a: Record<string, any>): string | null {
  const full = (a.full_address || a.st_address || "").trim();
  if (full) return titleCase(full);
  const num = (a.add_number ?? "").toString().trim();
  const name = [a.st_predir, a.st_name, a.st_postyp, a.st_posdir].filter(Boolean).join(" ").trim();
  if (!num || !name) return null;
  return titleCase(`${num} ${name}`);
}

/**
 * Incremental NC OneMap poll for one county. On first contact (cursor "0") it SEEDS
 * the cursor to the current max objectid and returns ZERO candidates — only later
 * polls (objectid > cursor) yield genuine new additions.
 */
export async function pollNcOneMapCounty(
  county: string,
  cursor: string,
  opts: { fetchImpl?: FetchLike; now?: () => number; limit?: number } = {},
): Promise<SourcePollResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const limit = Math.min(2000, opts.limit ?? 1000);
  const where = encodeURIComponent(`county='${county.toUpperCase().replace(/'/g, "''")}'`);
  const base = `${NC_ONEMAP_LAYER}/query`;

  try {
    // First contact → seed cursor to current max objectid, ingest nothing.
    if (!cursor || cursor === "0") {
      const statsUrl = `${base}?where=${where}&outStatistics=${encodeURIComponent(JSON.stringify([{ statisticType: "max", onStatisticField: "objectid", outStatisticFieldName: "mx" }]))}&f=json`;
      const r = await fetchImpl(statsUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return { source: "nc_onemap", scope: county, candidates: [], cursor: "0", seeded: false, recordsSeen: 0, ok: false, note: `seed HTTP ${r.status}` };
      const j = await r.json();
      const mx = j?.features?.[0]?.attributes?.mx ?? 0;
      return { source: "nc_onemap", scope: county, candidates: [], cursor: String(mx), seeded: true, recordsSeen: 0, ok: true, note: `seeded @ objectid ${mx}` };
    }

    // Incremental: rows with objectid > cursor = additions since last poll.
    const outFields = "objectid,full_address,st_address,add_number,st_predir,st_name,st_postyp,st_posdir,post_comm,inc_muni,post_code,county,ddlat,ddlong,lat,long";
    const url = `${base}?where=${where}%20AND%20objectid%3E${encodeURIComponent(cursor)}&outFields=${encodeURIComponent(outFields)}&orderByFields=objectid%20ASC&resultRecordCount=${limit}&returnGeometry=false&f=json`;
    const r = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return { source: "nc_onemap", scope: county, candidates: [], cursor, seeded: false, recordsSeen: 0, ok: false, note: `HTTP ${r.status}` };
    const j = await r.json();
    const feats: any[] = j?.features ?? [];
    let maxOid = Number(cursor);
    const candidates: NewBuildCandidate[] = [];
    for (const f of feats) {
      const a = f.attributes ?? {};
      const oid = Number(a.objectid);
      if (Number.isFinite(oid) && oid > maxOid) maxOid = oid;
      const address = ncAddress(a);
      const lat = Number(a.ddlat ?? a.lat);
      const lng = Number(a.ddlong ?? a.long);
      candidates.push({
        source: "nc_onemap", sourceRecordId: String(oid),
        address,
        city: a.post_comm ? titleCase(a.post_comm) : (a.inc_muni ? titleCase(a.inc_muni) : null),
        state: "NC",
        zip: a.post_code ? String(a.post_code).slice(0, 5) : null,
        county: titleCase(county),
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        buildStage: address ? "addressed" : "addressless",
        confidence: "authoritative",
        detectedAt: now(),
      });
    }
    return { source: "nc_onemap", scope: county, candidates, cursor: String(maxOid), seeded: false, recordsSeen: feats.length, ok: true, note: null };
  } catch (e: any) {
    return { source: "nc_onemap", scope: county, candidates: [], cursor, seeded: false, recordsSeen: 0, ok: false, note: String(e?.message ?? e).slice(0, 120) };
  }
}

// ── SC county authoritative address points (incremental via objectid) ─────────
export const SC_COUNTY_SOURCE_ID = "sc_county_addr";

export interface ScCountySource {
  county: string;                 // Title-case county name; also the coverage scope
  layerUrl: string;               // full ArcGIS REST layer URL (FeatureServer/N or MapServer/N)
  oidField: string;               // verified auto-increment OID field for this layer
  addressFields: string[];        // single-line address candidates; first non-empty wins
  cityFields: string[];           // postal-community candidates; first non-empty wins ([] = none)
  zipField: string | null;
  pageSize: number;               // ≤ the layer's verified maxRecordCount
}

// Every endpoint below was LIVE-VERIFIED (2026-07-17): responds to
// query?returnCountOnly, supports orderByFields on the OID and outSR=4326.
// Counts at verification time are noted for scale context.
export const SC_COUNTY_SOURCES: ScCountySource[] = [
  { // 201,400 pts · maxRec 2000 · Kinetic markets: Inman, Campobello, Spartanburg
    county: "Spartanburg",
    layerUrl: "https://maps.spartanburgcounty.org/server/rest/services/GIS/Address_Points/FeatureServer/0",
    oidField: "OBJECTID", addressFields: ["FullName"], cityFields: ["MSAGComm", "Inc_Muni"], zipField: "Post_Code", pageSize: 1000,
  },
  { // 306,800 pts · maxRec 5000 · layer exposes ADDRESS+ZIPCODE only (no city field)
    county: "Greenville",
    layerUrl: "https://www.gcgis.org/arcgis/rest/services/GreenvilleJS/Map_Layers_JS/MapServer/36",
    oidField: "OBJECTID", addressFields: ["ADDRESS"], cityFields: [], zipField: "ZIPCODE", pageSize: 1000,
  },
  { // 157,787 pts · maxRec 1000 · Fort Mill / Rock Hill / Tega Cay / Clover
    county: "York",
    layerUrl: "https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Addresses/FeatureServer/0",
    oidField: "OBJECTID", addressFields: ["WHOLE_ADDRESS"], cityFields: ["POST_COMM", "INC_MUNI"], zipField: "POST_CODE", pageSize: 1000,
  },
  { // 64,633 pts · maxRec 16000 · AGOL-hosted, refreshed by LancoGIS (item modified same-day at probe)
    county: "Lancaster",
    layerUrl: "https://services3.arcgis.com/rJcpRneDUBgTeCT3/arcgis/rest/services/LC_Addresses/FeatureServer/0",
    oidField: "FID", addressFields: ["WHOLE_ADDR"], cityFields: ["POSTAL_TOW", "INC_MUNI"], zipField: "POSTAL_ZIP", pageSize: 1000,
  },
  { // 120,393 pts · maxRec 2000 · SSAP (site/structure address points), daily E911 updates
    county: "Anderson",
    layerUrl: "https://propertyviewer.andersoncountysc.org/arcgis/rest/services/Address_Viewer/MapServer/0",
    oidField: "OBJECTID", addressFields: ["LST_FullAddress"], cityFields: ["Post_Comm", "Inc_Muni"], zipField: "Post_Code", pageSize: 1000,
  },
  { // 51,540 pts · maxRec 1000 · 'Address' is the clean single-line field (FullAddress embeds city/state/zip)
    county: "Laurens",
    layerUrl: "https://www.laurenscountygis.org/arcgis/rest/services/Pebble/LaurensCountyData/MapServer/1",
    oidField: "OBJECTID", addressFields: ["Address"], cityFields: ["Municipality"], zipField: "ZIPCode", pageSize: 500,
  },
];

function scFirstNonEmpty(a: Record<string, any>, fields: string[]): string | null {
  for (const f of fields) {
    const v = (a[f] ?? "").toString().trim();
    if (v && !/^unincorporated$/i.test(v)) return v;
  }
  return null;
}

/**
 * Incremental SC county address-point poll — same contract as pollNcOneMapCounty:
 * first contact (cursor ""/"0") SEEDS the cursor to the layer's current max OID
 * and ingests NOTHING; later polls return only rows with OID > cursor (genuine
 * post-seed additions), normalized to {address, city, state:'SC', zip, lat, lng}.
 */
export async function pollScCountyAddresses(
  src: ScCountySource,
  cursor: string,
  opts: { fetchImpl?: FetchLike; now?: () => number; limit?: number } = {},
): Promise<SourcePollResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const limit = Math.min(src.pageSize, Math.max(1, opts.limit ?? src.pageSize));
  const base = `${src.layerUrl}/query`;
  const oid = src.oidField;

  try {
    // First contact → seed to the current max OID via a top-1 DESC probe (works on
    // both FeatureServer and older MapServer layers, unlike outStatistics).
    if (!cursor || cursor === "0") {
      const seedUrl = `${base}?where=1%3D1&outFields=${encodeURIComponent(oid)}&orderByFields=${encodeURIComponent(`${oid} DESC`)}&resultRecordCount=1&returnGeometry=false&f=json`;
      const r = await fetchImpl(seedUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return { source: SC_COUNTY_SOURCE_ID, scope: src.county, candidates: [], cursor: "0", seeded: false, recordsSeen: 0, ok: false, note: `seed HTTP ${r.status}` };
      const j = await r.json();
      if (j?.error) return { source: SC_COUNTY_SOURCE_ID, scope: src.county, candidates: [], cursor: "0", seeded: false, recordsSeen: 0, ok: false, note: `seed ArcGIS error ${j.error.code ?? ""}`.trim() };
      const mx = Number(j?.features?.[0]?.attributes?.[oid] ?? 0);
      return { source: SC_COUNTY_SOURCE_ID, scope: src.county, candidates: [], cursor: String(Number.isFinite(mx) ? mx : 0), seeded: true, recordsSeen: 0, ok: true, note: `seeded @ ${oid} ${mx}` };
    }

    // Incremental: rows with OID > cursor = additions since last poll.
    const outFields = [oid, ...src.addressFields, ...src.cityFields, ...(src.zipField ? [src.zipField] : [])].join(",");
    const url =
      `${base}?where=${encodeURIComponent(`${oid}>${Number(cursor)}`)}&outFields=${encodeURIComponent(outFields)}` +
      `&orderByFields=${encodeURIComponent(`${oid} ASC`)}&resultRecordCount=${limit}&returnGeometry=true&outSR=4326&f=json`;
    const r = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return { source: SC_COUNTY_SOURCE_ID, scope: src.county, candidates: [], cursor, seeded: false, recordsSeen: 0, ok: false, note: `HTTP ${r.status}` };
    const j = await r.json();
    if (j?.error) return { source: SC_COUNTY_SOURCE_ID, scope: src.county, candidates: [], cursor, seeded: false, recordsSeen: 0, ok: false, note: `ArcGIS error ${j.error.code ?? ""}`.trim() };
    const feats: any[] = j?.features ?? [];
    let maxOid = Number(cursor);
    const candidates: NewBuildCandidate[] = [];
    for (const f of feats) {
      const a = f.attributes ?? {};
      const id = Number(a[oid]);
      if (Number.isFinite(id) && id > maxOid) maxOid = id;
      const rawAddr = scFirstNonEmpty(a, src.addressFields);
      const address = rawAddr ? titleCase(rawAddr) : null;
      const city = scFirstNonEmpty(a, src.cityFields);
      const zipRaw = src.zipField ? (a[src.zipField] ?? "").toString().trim() : "";
      const lat = Number(f.geometry?.y);
      const lng = Number(f.geometry?.x);
      candidates.push({
        source: SC_COUNTY_SOURCE_ID, sourceRecordId: `${src.county.toLowerCase()}:${id}`,
        address,
        city: city ? titleCase(city) : null,
        state: "SC",
        zip: zipRaw ? zipRaw.slice(0, 5) : null,
        county: src.county,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        buildStage: address ? "addressed" : "addressless",
        confidence: "authoritative",
        detectedAt: now(),
      });
    }
    return { source: SC_COUNTY_SOURCE_ID, scope: src.county, candidates, cursor: String(maxOid), seeded: false, recordsSeen: feats.length, ok: true, note: null };
  } catch (e: any) {
    return { source: SC_COUNTY_SOURCE_ID, scope: src.county, candidates: [], cursor, seeded: false, recordsSeen: 0, ok: false, note: String(e?.message ?? e).slice(0, 120) };
  }
}

// ── OSM Overpass (NC + SC, incremental via newer:) ────────────────────────────
export interface OverpassArea { key: string; state: "NC" | "SC" | "GA"; county: string | null; bbox: [number, number, number, number]; } // [s,w,n,e]

function parseOverpassElements(elements: any[], area: OverpassArea, now: number): NewBuildCandidate[] {
  const out: NewBuildCandidate[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    const num = t["addr:housenumber"];
    const street = t["addr:street"];
    const lat = el.lat ?? el.center?.lat ?? null;
    const lng = el.lon ?? el.center?.lon ?? null;
    const addressed = !!(num && street);
    // Only keep residential-ish buildings or addressed nodes.
    const isBuilding = !!t.building;
    if (!addressed && !isBuilding) continue;
    out.push({
      source: "osm_overpass", sourceRecordId: `${el.type}/${el.id}`,
      address: addressed ? titleCase(`${num} ${street}`) : null,
      city: t["addr:city"] ? titleCase(t["addr:city"]) : null,
      state: area.state,
      zip: t["addr:postcode"] ? String(t["addr:postcode"]).slice(0, 5) : null,
      county: area.county,
      lat: lat != null ? Number(lat) : null,
      lng: lng != null ? Number(lng) : null,
      buildStage: addressed ? "addressed" : "addressless",
      confidence: "observed",
      detectedAt: now,
    });
  }
  return out;
}

/**
 * Incremental Overpass poll for one area. `cursor` is the last-poll ISO timestamp;
 * on first contact it seeds to now and ingests nothing (avoids the OSM backlog).
 */
export async function pollOverpassArea(
  area: OverpassArea,
  cursor: string,
  opts: { fetchImpl?: FetchLike; now?: () => number; endpoint?: string } = {},
): Promise<SourcePollResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const endpoint = opts.endpoint ?? "https://overpass-api.de/api/interpreter";
  const nowIso = new Date(now()).toISOString();

  if (!cursor) {
    return { source: "osm_overpass", scope: area.key, candidates: [], cursor: nowIso, seeded: true, recordsSeen: 0, ok: true, note: `seeded @ ${nowIso}` };
  }
  const [s, w, n, e] = area.bbox;
  const q = `[out:json][timeout:40];(way["building"](newer:"${cursor}")(${s},${w},${n},${e});node["addr:housenumber"](newer:"${cursor}")(${s},${w},${n},${e}););out center tags;`;
  try {
    const r = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: "data=" + encodeURIComponent(q),
      signal: AbortSignal.timeout(50000),
    });
    if (!r.ok) return { source: "osm_overpass", scope: area.key, candidates: [], cursor, seeded: false, recordsSeen: 0, ok: false, note: `HTTP ${r.status}` };
    const j = await r.json();
    const els: any[] = j?.elements ?? [];
    const candidates = parseOverpassElements(els, area, now());
    return { source: "osm_overpass", scope: area.key, candidates, cursor: nowIso, seeded: false, recordsSeen: els.length, ok: true, note: null };
  } catch (err: any) {
    return { source: "osm_overpass", scope: area.key, candidates: [], cursor, seeded: false, recordsSeen: 0, ok: false, note: String(err?.message ?? err).slice(0, 120) };
  }
}

/**
 * Fetch the N most-recently-added addresses for a county (highest objectids) as
 * new-build candidates. Used for a BOUNDED admin demo / verification poll — the
 * continuous radar seeds clean and only ingests genuine post-seed additions, so
 * this is the only path that surfaces the existing recent backlog, and `lookback`
 * is clamped small to bound cost.
 */
export async function fetchNcOneMapRecent(
  county: string,
  lookback: number,
  opts: { fetchImpl?: FetchLike; now?: () => number } = {},
): Promise<SourcePollResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const clamp = Math.min(50, Math.max(1, Math.floor(lookback)));
  // Seed to (max - clamp) then run the normal incremental poll → the clamp
  // most-recent additions come back as candidates.
  const seed = await pollNcOneMapCounty(county, "0", opts);
  if (!seed.ok) return seed;
  const from = String(Math.max(0, Number(seed.cursor) - clamp));
  return pollNcOneMapCounty(county, from, { ...opts, limit: clamp, fetchImpl });
}

export const _internal = { ncAddress, parseOverpassElements, titleCase, scFirstNonEmpty };
