import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rawDb } from "../db";
import { harvestBboxAddresses } from "../mapbox-addresses";
import { planUnifiedAreaScan } from "../areaScanStrategy";
import { OverpassClient, parseOsmElements } from "./overpass";
import type {
  AddressSourceAdapter,
  AddressSourceContext,
  AddressSourceMetadata,
  DiscoveryBBox,
  SourceAddressRecord,
  SourcePage,
} from "./types";
import { bboxPolygon, pointInGeometry } from "./types";

const sha = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

class RateGate {
  private nextAt = 0;
  private tail = Promise.resolve();
  constructor(private readonly intervalMs: number) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = Math.max(0, this.nextAt - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      this.nextAt = Date.now() + this.intervalMs;
      return task();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const overpassGate = new RateGate(
  Math.max(1_000, Number(process.env.OVERPASS_MIN_INTERVAL_MS) || 5_000),
);
const mapboxGate = new RateGate(
  Math.max(250, Number(process.env.MAPBOX_DISCOVERY_MIN_INTERVAL_MS) || 500),
);
let overpassClient: OverpassClient | null = null;

function getOverpassClient(): OverpassClient {
  if (overpassClient) return overpassClient;
  const endpoints = process.env.OVERPASS_ENDPOINTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedHosts = process.env.OVERPASS_ALLOWED_HOSTS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  overpassClient = new OverpassClient({
    endpoints,
    allowedHosts,
    concurrency: Math.max(
      1,
      Math.min(4, Number(process.env.OVERPASS_CONCURRENCY) || 1),
    ),
    timeoutMs: Math.max(
      5_000,
      Number(process.env.OVERPASS_TIMEOUT_MS) || 55_000,
    ),
    maxAttempts: Math.max(
      1,
      Math.min(8, Number(process.env.OVERPASS_MAX_ATTEMPTS) || 4),
    ),
    baseBackoffMs: Math.max(
      100,
      Number(process.env.OVERPASS_BASE_BACKOFF_MS) || 500,
    ),
    maxBackoffMs: Math.max(
      1_000,
      Number(process.env.OVERPASS_MAX_BACKOFF_MS) || 15_000,
    ),
    userAgent:
      process.env.DISCOVERY_USER_AGENT ||
      "HomeFrontFiber/2.0 (address discovery; support@homefrontsolutions.com)",
  });
  return overpassClient;
}

function inBox(lat: number, lng: number, b: DiscoveryBBox): boolean {
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
}

function clean(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function recordFromLoose(
  raw: any,
  sourceRecordId: string,
): SourceAddressRecord | null {
  const props = raw?.properties ?? raw ?? {};
  const coords =
    raw?.geometry?.type === "Point" ? raw.geometry.coordinates : null;
  const lat = Number(props.lat ?? props.latitude ?? raw?.lat ?? coords?.[1]);
  const lng = Number(
    props.lng ?? props.lon ?? props.longitude ?? raw?.lng ?? coords?.[0],
  );
  const house = clean(
    props.house_number ??
      props.housenumber ??
      props.number ??
      props["addr:housenumber"],
  );
  const street = clean(
    props.street ?? props.street_name ?? props.road ?? props["addr:street"],
  );
  const unit = clean(props.unit ?? props.apartment ?? props["addr:unit"]);
  const city = clean(
    props.city ?? props.municipality ?? props.locality ?? props["addr:city"],
  );
  const state = clean(props.state ?? props.region ?? props["addr:state"]);
  const postalCode = clean(
    props.postal_code ?? props.postcode ?? props.zip ?? props["addr:postcode"],
  );
  const full =
    clean(
      props.full_address ??
        props.address ??
        props.address_full ??
        props["addr:full"],
    ) ?? [house, street, unit ? `#${unit}` : null].filter(Boolean).join(" ");
  if (!full) return null;
  return {
    sourceRecordId,
    fullAddress: full,
    houseNumber: house,
    street,
    unit,
    city,
    state,
    postalCode,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    coordinateQuality:
      (clean(
        props.coordinate_quality,
      ) as SourceAddressRecord["coordinateQuality"]) ?? "unknown",
    confidence: Number.isFinite(Number(props.confidence))
      ? Number(props.confidence)
      : 0.75,
    inferred: Boolean(props.inferred),
    observedAt: clean(props.observed_at) ?? undefined,
    evidenceKind: clean(props.evidence_kind) ?? undefined,
    raw,
  };
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  return rows
    .filter((r) => r.some(Boolean))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

type CachedFile = { mtimeMs: number; records: SourceAddressRecord[] };
const fileCache = new Map<string, CachedFile>();

function readAddressFile(
  filePath: string,
  includeGeometryEvidence = false,
): SourceAddressRecord[] {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  const cached = fileCache.get(resolved);
  if (cached?.mtimeMs === stat.mtimeMs) return cached.records;
  if (
    stat.size >
    (Number(process.env.ADDRESS_SOURCE_MAX_FILE_BYTES) || 512 * 1024 * 1024)
  ) {
    throw new Error("Address dataset exceeds configured file-size limit");
  }
  const text = fs.readFileSync(resolved, "utf8");
  let rawRows: any[];
  if (/\.csv$/i.test(resolved)) rawRows = parseCsv(text);
  else {
    const decoded = JSON.parse(text);
    rawRows =
      decoded?.type === "FeatureCollection"
        ? decoded.features
        : Array.isArray(decoded)
          ? decoded
          : [];
  }
  const records = rawRows
    .map((raw, index) => {
      const sourceRecordId =
        clean(raw?.id ?? raw?.properties?.id) ?? String(index);
      const address = recordFromLoose(raw, sourceRecordId);
      if (address || !includeGeometryEvidence) return address;
      const coordinates = raw?.geometry?.coordinates;
      const numericPairs: [number, number][] = [];
      const collect = (value: unknown): void => {
        if (
          Array.isArray(value) &&
          value.length >= 2 &&
          Number.isFinite(Number(value[0])) &&
          Number.isFinite(Number(value[1]))
        ) {
          numericPairs.push([Number(value[0]), Number(value[1])]);
          return;
        }
        if (Array.isArray(value)) value.forEach(collect);
      };
      collect(coordinates);
      if (!numericPairs.length) return null;
      return {
        sourceRecordId,
        fullAddress: "",
        lat:
          numericPairs.reduce((sum, point) => sum + point[1], 0) /
          numericPairs.length,
        lng:
          numericPairs.reduce((sum, point) => sum + point[0], 0) /
          numericPairs.length,
        coordinateQuality: "building_centroid" as const,
        confidence: 0.4,
        inferred: true,
        evidenceKind: "building_footprint",
        raw,
      };
    })
    .filter(Boolean) as SourceAddressRecord[];
  fileCache.set(resolved, { mtimeMs: stat.mtimeMs, records });
  return records;
}

class FileAddressSource implements AddressSourceAdapter {
  constructor(
    readonly metadata: AddressSourceMetadata,
    private readonly envName: string,
  ) {}
  available(): boolean {
    return Boolean(
      process.env[this.envName] &&
      fs.existsSync(path.resolve(process.env[this.envName]!)),
    );
  }
  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    if (!this.available())
      return { ok: false, message: `${this.envName} is not configured` };
    try {
      readAddressFile(process.env[this.envName]!, this.metadata.evidenceOnly);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  }
  async discover(ctx: AddressSourceContext): Promise<SourcePage> {
    const rows = readAddressFile(
      process.env[this.envName]!,
      this.metadata.evidenceOnly,
    );
    return {
      records: rows.filter(
        (r) =>
          r.lat != null &&
          r.lng != null &&
          inBox(r.lat, r.lng, ctx.bbox) &&
          pointInGeometry(r.lng, r.lat, ctx.geometry),
      ),
      partial: false,
    };
  }
}

const OSM_META: AddressSourceMetadata = {
  id: "osm_overpass",
  label: "OpenStreetMap / Overpass",
  coverageClass: "supplemental",
  authoritative: false,
  evidenceOnly: false,
  licenseName: "ODbL 1.0",
  licenseUrl: "https://www.openstreetmap.org/copyright",
  defaultPriority: 70,
};

const osmSource: AddressSourceAdapter = {
  metadata: OSM_META,
  available: () => process.env.OVERPASS_DISABLED !== "true",
  async healthCheck() {
    return {
      ok: process.env.OVERPASS_DISABLED !== "true",
      message:
        process.env.OVERPASS_DISABLED === "true" ? "Disabled" : undefined,
    };
  },
  async discover(ctx) {
    return overpassGate.run(async () => {
      const result = await getOverpassClient().fetchArea(
        bboxPolygon(ctx.bbox),
        {
          targetTileAreaKm2: Math.max(
            0.01,
            Number(process.env.OVERPASS_TARGET_TILE_AREA_KM2) || 5,
          ),
          maxTiles: 64,
          maxRequests: Math.max(
            4,
            Number(process.env.OVERPASS_MAX_REQUESTS_PER_TILE) || 64,
          ),
          maxSubdivisionDepth: Math.max(
            1,
            Number(process.env.OVERPASS_MAX_SUBDIVISION_DEPTH) || 4,
          ),
          signal: ctx.signal,
        },
      );
      const parsed = parseOsmElements(result.elements, {
        city: ctx.city ?? undefined,
        state: ctx.state,
        geometry: ctx.geometry,
        retrievedAt: new Date().toISOString(),
      });
      const records: SourceAddressRecord[] = parsed.map((candidate) => {
        const provenance = candidate.sources[0];
        const quality = (
          {
            ROOFTOP: "rooftop",
            ENTRANCE: "entrance",
            PARCEL: "parcel",
            CENTROID: "building_centroid",
            INTERPOLATED: "interpolated",
            UNKNOWN: "unknown",
          } as const
        )[candidate.coordinateQuality];
        return {
          sourceRecordId:
            provenance?.sourceId ?? `${candidate.osmType}/${candidate.osmId}`,
          fullAddress: candidate.rawAddress || candidate.canonicalAddress,
          houseNumber: candidate.normalizedHouseNumber || null,
          street: candidate.normalizedStreet || null,
          unit: candidate.normalizedUnit || null,
          city: candidate.normalizedCity || ctx.city,
          state: candidate.normalizedState || ctx.state,
          postalCode: candidate.normalizedPostalCode || null,
          lat: candidate.lat ?? null,
          lng: candidate.lng ?? null,
          coordinateQuality: quality,
          confidence: candidate.confidence,
          inferred:
            candidate.observationType !== "OBSERVED" ||
            candidate.validationRequired,
          evidenceKind: candidate.inferenceMethod.toLowerCase(),
          raw: {
            candidate,
            completedTileIds: result.completedTileIds,
            truncatedTileIds: result.truncatedTileIds,
          },
        };
      });
      return {
        records,
        partial: !result.complete,
        diagnostics: {
          complete: result.complete,
          completedTileIds: result.completedTileIds,
          failedTileIds: result.failedTileIds,
          truncatedTileIds: result.truncatedTileIds,
          requests: result.requests,
        },
      };
    });
  },
};

const MAPBOX_META: AddressSourceMetadata = {
  id: "mapbox_reverse_geocode",
  label: "Mapbox address augmentation",
  coverageClass: "supplemental",
  authoritative: false,
  evidenceOnly: false,
  licenseName: "Mapbox Terms of Service",
  licenseUrl: "https://www.mapbox.com/legal/tos",
  defaultPriority: 60,
};

/**
 * Mapbox is an address-enumeration source only. It never supplies fiber,
 * account, or freshness verdicts. Tight field boxes receive the same adaptive,
 * capped reverse-geocode grid as the legacy area route; oversized tiles skip
 * the paid augmentation instead of silently coarsening coverage.
 */
export function createMapboxAddressSource(
  harvest: typeof harvestBboxAddresses = harvestBboxAddresses,
  token: () => string = () =>
    process.env.MAPBOX_TOKEN?.trim() ||
    process.env.MAPBOX_PUBLIC_TOKEN?.trim() ||
    "",
): AddressSourceAdapter {
  return {
    metadata: MAPBOX_META,
    available: () => Boolean(token()),
    async healthCheck() {
      return token()
        ? { ok: true, message: "Configured for capped reverse geocoding" }
        : { ok: false, message: "Mapbox token is not configured" };
    },
    async discover(ctx) {
      const accessToken = token();
      if (!accessToken) throw new Error("Mapbox token is not configured");
      // ELECTED area scans (a box the operator drew) get the aggressive tier:
      // a much higher auto-grid cap (so a neighbourhood-plus box never silently
      // SKIPS the paid augmentation and misses new builds) + a denser sample
      // spacing + a higher hard harvest ceiling. Background market/town harvests
      // keep the conservative defaults. A hard cap always remains — Mapbox
      // geocoding is separately billed and has a documented runaway-cost
      // history, so "no limits" is a raised ceiling, never an absent one.
      const elected = ctx.thorough === true;
      const plan = planUnifiedAreaScan(ctx.bbox, {
        hasMapboxToken: true,
        autoGridMaxPoints: Math.max(
          25,
          elected
            ? Number(process.env.AREA_ELECTED_GRID_POINTS) || 8_000
            : Number(process.env.AREA_AUTO_GRID_POINTS) || 900,
        ),
        harvestCap: Math.max(
          25,
          elected
            ? Number(process.env.MAPBOX_ELECTED_HARVEST_CAP) || 12_000
            : Number(process.env.MAPBOX_HARVEST_CAP) || 5_000,
        ),
        ceilDeg: elected
          ? Number(process.env.AREA_ELECTED_GRID_STEP) || 0.0008
          : undefined,
        minSamplesPerSide: elected ? 10 : undefined,
      });
      if (!plan.gridEnabled) {
        return {
          records: [],
          partial: true,
          diagnostics: {
            skipped: "grid_over_automatic_cap",
            gridPoints: plan.gridPoints,
            automaticCap: plan.autoGridMaxPoints,
          },
        };
      }
      return mapboxGate.run(async () => {
        const rows = await harvest(
          ctx.bbox,
          ctx.state,
          accessToken,
          undefined,
          plan.gridStep,
          ctx.signal,
        );
        const records: SourceAddressRecord[] = rows
          .filter((row) => pointInGeometry(row.lng, row.lat, ctx.geometry))
          .map((row) => ({
            sourceRecordId: sha(
              `${row.address}|${row.city}|${row.state}|${row.zip}|${row.lat}|${row.lng}`,
            ),
            fullAddress: row.address,
            city: row.city || ctx.city,
            state: row.state || ctx.state,
            postalCode: row.zip || null,
            lat: row.lat,
            lng: row.lng,
            coordinateQuality: "rooftop",
            confidence: 0.9,
            inferred: false,
            evidenceKind: "reverse_geocode",
            raw: {
              source: "mapbox_reverse_geocode",
              observedAt: new Date().toISOString(),
            },
          }));
        return {
          records,
          partial: false,
          diagnostics: { gridPoints: plan.gridPoints, gridStep: plan.gridStep },
        };
      });
    },
  };
}

function dbSource(
  metadata: AddressSourceMetadata,
  manualOnly: boolean,
): AddressSourceAdapter {
  return {
    metadata,
    available: () => true,
    async healthCheck() {
      return { ok: true };
    },
    async discover(ctx) {
      const rows = manualOnly
        ? (rawDb
            .prepare(
              `SELECT r.id,r.full_address,r.city,r.state,r.postal_code,r.lat,r.lng,r.raw_json,r.authoritative,
              r.source_id,u.license_name,u.license_url FROM uploaded_address_records r
            JOIN address_source_uploads u ON u.id=r.upload_id
            WHERE r.tenant_id=? AND r.lat BETWEEN ? AND ? AND r.lng BETWEEN ? AND ?`,
            )
            .all(
              ctx.tenantId,
              ctx.bbox.south,
              ctx.bbox.north,
              ctx.bbox.west,
              ctx.bbox.east,
            ) as any[])
        : (rawDb
            .prepare(
              `SELECT id,address AS full_address,city,state,zip AS postal_code,lat,lng FROM scan_targets
            WHERE tenant_id=? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
            )
            .all(
              ctx.tenantId,
              ctx.bbox.south,
              ctx.bbox.north,
              ctx.bbox.west,
              ctx.bbox.east,
            ) as any[]);
      const records = rows
        .filter(
          (r) =>
            Number.isFinite(r.lat) &&
            Number.isFinite(r.lng) &&
            pointInGeometry(r.lng, r.lat, ctx.geometry),
        )
        .map((r) => ({
          sourceRecordId: String(r.id),
          sourceId: r.source_id,
          fullAddress: r.full_address,
          city: r.city,
          state: r.state,
          postalCode: r.postal_code,
          lat: r.lat,
          lng: r.lng,
          coordinateQuality: "unknown" as const,
          confidence: manualOnly ? 0.8 : 0.85,
          inferred: false,
          authoritative: manualOnly ? Boolean(r.authoritative) : false,
          licenseName: r.license_name ?? null,
          licenseUrl: r.license_url ?? null,
          raw: r.raw_json ? JSON.parse(r.raw_json) : r,
        }));
      return { records, partial: false };
    },
  };
}

const sourceDefinitions: AddressSourceAdapter[] = [
  new FileAddressSource(
    {
      id: "openaddresses",
      label: "OpenAddresses",
      coverageClass: "primary",
      authoritative: false,
      evidenceOnly: false,
      licenseName: "Per-source OpenAddresses license",
      licenseUrl: "https://openaddresses.io/",
      defaultPriority: 30,
    },
    "OPENADDRESSES_DATA_PATH",
  ),
  new FileAddressSource(
    {
      id: "nad",
      label: "National Address Database",
      coverageClass: "authoritative",
      authoritative: true,
      evidenceOnly: false,
      licenseName: "US Government public data",
      licenseUrl:
        "https://www.transportation.gov/gis/national-address-database",
      defaultPriority: 10,
    },
    "NAD_DATA_PATH",
  ),
  new FileAddressSource(
    {
      id: "local_gis",
      label: "Local / county GIS or E911",
      coverageClass: "authoritative",
      authoritative: true,
      evidenceOnly: false,
      licenseName: "Configured local dataset license",
      licenseUrl: null,
      defaultPriority: 5,
    },
    "LOCAL_GIS_ADDRESS_PATH",
  ),
  new FileAddressSource(
    {
      id: "building_footprints",
      label: "Building footprints",
      coverageClass: "evidence_only",
      authoritative: false,
      evidenceOnly: true,
      licenseName: "Configured footprint dataset license",
      licenseUrl: null,
      defaultPriority: 80,
    },
    "BUILDING_FOOTPRINTS_PATH",
  ),
  dbSource(
    {
      id: "first_party",
      label: "First-party address inventory",
      coverageClass: "primary",
      authoritative: false,
      evidenceOnly: false,
      licenseName: "First-party",
      licenseUrl: null,
      defaultPriority: 20,
    },
    false,
  ),
  dbSource(
    {
      id: "manual_upload",
      label: "Manual CSV / GeoJSON uploads",
      coverageClass: "supplemental",
      authoritative: false,
      evidenceOnly: false,
      licenseName: "Uploader-supplied",
      licenseUrl: null,
      defaultPriority: 15,
    },
    true,
  ),
  createMapboxAddressSource(),
  osmSource,
];

export function addressSources(tenantId: number): AddressSourceAdapter[] {
  const configRows = rawDb
    .prepare(
      `SELECT source_id,enabled,priority,circuit_open_until FROM address_source_health WHERE tenant_id=?`,
    )
    .all(tenantId) as any[];
  const byId = new Map(configRows.map((r) => [r.source_id, r]));
  return sourceDefinitions
    .filter((source) => {
      const row = byId.get(source.metadata.id);
      if (row?.enabled === 0 || !source.available(tenantId)) return false;
      return (
        !row?.circuit_open_until ||
        Date.parse(row.circuit_open_until) <= Date.now()
      );
    })
    .sort(
      (a, b) =>
        (byId.get(a.metadata.id)?.priority ?? a.metadata.defaultPriority) -
        (byId.get(b.metadata.id)?.priority ?? b.metadata.defaultPriority),
    );
}

export function allSourceMetadata(): AddressSourceMetadata[] {
  return sourceDefinitions.map((s) => s.metadata);
}

export function sourceById(id: string): AddressSourceAdapter | undefined {
  return sourceDefinitions.find((s) => s.metadata.id === id);
}

export function stableSourceCacheKey(
  sourceId: string,
  ctx: Pick<AddressSourceContext, "bbox" | "geometry" | "city" | "state">,
): string {
  const envBySource: Record<string, string> = {
    openaddresses: "OPENADDRESSES_DATA_PATH",
    nad: "NAD_DATA_PATH",
    local_gis: "LOCAL_GIS_ADDRESS_PATH",
    building_footprints: "BUILDING_FOOTPRINTS_PATH",
  };
  const configuredPath = envBySource[sourceId]
    ? process.env[envBySource[sourceId]]
    : undefined;
  let datasetVersion: string | null = null;
  if (configuredPath) {
    try {
      const stat = fs.statSync(path.resolve(configuredPath));
      datasetVersion = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      datasetVersion = "missing";
    }
  }
  return sha(
    JSON.stringify({
      sourceId,
      bbox: ctx.bbox,
      geometry: ctx.geometry,
      city: ctx.city,
      state: ctx.state,
      datasetVersion,
      cacheVersion: process.env.ADDRESS_SOURCE_CACHE_VERSION ?? "v1",
    }),
  );
}

export function parseUploadedPayload(
  format: "csv" | "geojson" | "json",
  content: string,
): SourceAddressRecord[] {
  if (Buffer.byteLength(content, "utf8") > 10 * 1024 * 1024)
    throw new Error("Upload exceeds 10 MB");
  let rows: any[];
  if (format === "csv") rows = parseCsv(content);
  else {
    const parsed = JSON.parse(content);
    rows =
      parsed?.type === "FeatureCollection"
        ? parsed.features
        : Array.isArray(parsed)
          ? parsed
          : [];
  }
  return rows
    .map((raw, index) =>
      recordFromLoose(
        raw,
        clean(raw?.id ?? raw?.properties?.id) ?? String(index),
      ),
    )
    .filter(Boolean) as SourceAddressRecord[];
}
