/**
 * Pure primitives shared by address discovery sources, workers, and tests.
 *
 * This module deliberately has no I/O and no database dependencies. Source
 * adapters retain their raw values, then use these helpers to create a stable
 * identity without treating display formatting as identity.
 */

export type Position = readonly [longitude: number, latitude: number];

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Position[][];
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Position[][][];
}

export type DiscoveryGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface DiscoveryTile {
  id: string;
  bbox: Bbox;
  depth: number;
  approxAreaKm2: number;
}

export interface AddressProvenance {
  source: string;
  sourceId?: string;
  sourceVersion?: string;
  retrievedAt?: string;
  license?: string;
  attribution?: string;
  method?: string;
  parentSourceId?: string;
  raw?: unknown;
}

export interface RawAddressRecord {
  source: string;
  sourceId?: string;
  rawAddress?: string;
  houseNumber?: string;
  street?: string;
  unit?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  lat?: number;
  lng?: number;
  coordinateQuality?: "ROOFTOP" | "PARCEL" | "ENTRANCE" | "CENTROID" | "INTERPOLATED" | "UNKNOWN";
  observationType?: "OBSERVED" | "INFERRED" | "INTERPOLATED" | "PARTIAL";
  confidence?: number;
  validationRequired?: boolean;
  provenance?: AddressProvenance[];
}

export interface NormalizedAddressCandidate {
  rawAddress: string;
  canonicalAddress: string;
  canonicalKey: string;
  normalizedHouseNumber: string;
  normalizedStreet: string;
  normalizedUnit: string;
  normalizedCity: string;
  normalizedState: string;
  normalizedPostalCode: string;
  country: string;
  lat?: number;
  lng?: number;
  coordinateQuality: NonNullable<RawAddressRecord["coordinateQuality"]>;
  observationType: NonNullable<RawAddressRecord["observationType"]>;
  confidence: number;
  validationRequired: boolean;
  sources: AddressProvenance[];
  providerVariants: string[];
}

export class AddressDiscoveryValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AddressDiscoveryValidationError";
  }
}

const EARTH_RADIUS_KM = 6371.0088;
const EPSILON = 1e-10;

function samePosition(a: Position, b: Position): boolean {
  return Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;
}

function orient(a: Position, b: Position, c: Position): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(point: Position, a: Position, b: Position): boolean {
  if (Math.abs(orient(a, b, point)) > EPSILON) return false;
  return point[0] >= Math.min(a[0], b[0]) - EPSILON
    && point[0] <= Math.max(a[0], b[0]) + EPSILON
    && point[1] >= Math.min(a[1], b[1]) - EPSILON
    && point[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function segmentsIntersect(a: Position, b: Position, c: Position, d: Position): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > EPSILON && o2 < -EPSILON) || (o1 < -EPSILON && o2 > EPSILON))
    && ((o3 > EPSILON && o4 < -EPSILON) || (o3 < -EPSILON && o4 > EPSILON))) return true;
  return (Math.abs(o1) <= EPSILON && pointOnSegment(c, a, b))
    || (Math.abs(o2) <= EPSILON && pointOnSegment(d, a, b))
    || (Math.abs(o3) <= EPSILON && pointOnSegment(a, c, d))
    || (Math.abs(o4) <= EPSILON && pointOnSegment(b, c, d));
}

function signedRingArea(ring: readonly Position[]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return area / 2;
}

function pointInRing(point: Position, ring: readonly Position[], includeBoundary = true): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (pointOnSegment(point, a, b)) return includeBoundary;
    const crosses = (a[1] > point[1]) !== (b[1] > point[1]);
    if (crosses) {
      const x = ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}

function normalizeRing(input: unknown, polygonIndex: number, ringIndex: number): Position[] {
  if (!Array.isArray(input)) {
    throw new AddressDiscoveryValidationError("geometry_ring", `Polygon ${polygonIndex} ring ${ringIndex} must be an array.`);
  }
  const points: Position[] = [];
  for (const raw of input) {
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new AddressDiscoveryValidationError("geometry_coordinate", "Every coordinate must be [longitude, latitude].");
    }
    const lng = Number(raw[0]);
    const lat = Number(raw[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new AddressDiscoveryValidationError("geometry_coordinate", `Invalid coordinate [${String(raw[0])}, ${String(raw[1])}].`);
    }
    const point: Position = [lng, lat];
    if (!points.length || !samePosition(points[points.length - 1], point)) points.push(point);
  }
  if (points.length > 0 && !samePosition(points[0], points[points.length - 1])) points.push(points[0]);
  if (points.length < 4) {
    throw new AddressDiscoveryValidationError("geometry_ring", `Polygon ${polygonIndex} ring ${ringIndex} needs at least three distinct points.`);
  }
  if (Math.abs(signedRingArea(points)) <= EPSILON) {
    throw new AddressDiscoveryValidationError("geometry_degenerate", `Polygon ${polygonIndex} ring ${ringIndex} has no area.`);
  }
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1; j < points.length - 1; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === points.length - 2)) continue;
      if (segmentsIntersect(points[i], points[i + 1], points[j], points[j + 1])) {
        throw new AddressDiscoveryValidationError("geometry_self_intersection", `Polygon ${polygonIndex} ring ${ringIndex} self-intersects.`);
      }
    }
  }
  return points;
}

function ringsIntersect(a: readonly Position[], b: readonly Position[]): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

function normalizePolygon(rawRings: unknown, polygonIndex: number): Position[][] {
  if (!Array.isArray(rawRings) || rawRings.length === 0) {
    throw new AddressDiscoveryValidationError("geometry_polygon", `Polygon ${polygonIndex} has no exterior ring.`);
  }
  const rings = rawRings.map((ring, index) => normalizeRing(ring, polygonIndex, index));
  const outer = rings[0];
  for (let i = 1; i < rings.length; i++) {
    const hole = rings[i];
    if (!pointInRing(hole[0], outer, false) || ringsIntersect(outer, hole)) {
      throw new AddressDiscoveryValidationError("geometry_hole", `Polygon ${polygonIndex} hole ${i} is outside or intersects its exterior ring.`);
    }
    for (let j = 1; j < i; j++) {
      if (ringsIntersect(hole, rings[j]) || pointInRing(hole[0], rings[j]) || pointInRing(rings[j][0], hole)) {
        throw new AddressDiscoveryValidationError("geometry_hole", `Polygon ${polygonIndex} holes ${j} and ${i} overlap.`);
      }
    }
  }
  // RFC 7946 right-hand rule: exterior counter-clockwise, holes clockwise.
  return rings.map((ring, index) => {
    const shouldReverse = index === 0 ? signedRingArea(ring) < 0 : signedRingArea(ring) > 0;
    return shouldReverse ? [...ring].reverse() : ring;
  });
}

/** Validate, close, de-duplicate, and orient a Polygon or MultiPolygon. */
export function validateDiscoveryGeometry(
  input: unknown,
  options: { maxVertices?: number; maxAreaKm2?: number; minAreaKm2?: number } = {},
): DiscoveryGeometry {
  if (!input || typeof input !== "object") {
    throw new AddressDiscoveryValidationError("geometry_missing", "A Polygon or MultiPolygon geometry is required.");
  }
  const candidate = input as { type?: unknown; coordinates?: unknown };
  if (candidate.type !== "Polygon" && candidate.type !== "MultiPolygon") {
    throw new AddressDiscoveryValidationError("geometry_type", "Only Polygon and MultiPolygon geometries are supported.");
  }
  const polygonsRaw = candidate.type === "Polygon" ? [candidate.coordinates] : candidate.coordinates;
  if (!Array.isArray(polygonsRaw) || polygonsRaw.length === 0) {
    throw new AddressDiscoveryValidationError("geometry_polygon", "Geometry must contain at least one polygon.");
  }
  const vertices = JSON.stringify(candidate.coordinates).match(/\[/g)?.length ?? 0;
  if (vertices > (options.maxVertices ?? 50_000)) {
    throw new AddressDiscoveryValidationError("geometry_vertices", "Geometry has too many vertices.");
  }
  const polygons = polygonsRaw.map((polygon, index) => normalizePolygon(polygon, index));
  const normalized: DiscoveryGeometry = candidate.type === "Polygon"
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
  const bbox = geometryBbox(normalized);
  if (bbox.east - bbox.west > 180) {
    throw new AddressDiscoveryValidationError("geometry_antimeridian", "Antimeridian-crossing scan geometry is not supported.");
  }
  const area = geometryAreaKm2(normalized);
  if (area < (options.minAreaKm2 ?? 1e-7)) {
    throw new AddressDiscoveryValidationError("geometry_degenerate", "Scan geometry is too small.");
  }
  if (area > (options.maxAreaKm2 ?? 250_000)) {
    throw new AddressDiscoveryValidationError("geometry_area", `Scan geometry is too large (${Math.round(area).toLocaleString()} km²).`);
  }
  return normalized;
}

export function geometryBbox(geometry: DiscoveryGeometry): Bbox {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const polygon of polygons) for (const ring of polygon) for (const [lng, lat] of ring) {
    west = Math.min(west, lng); south = Math.min(south, lat);
    east = Math.max(east, lng); north = Math.max(north, lat);
  }
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new AddressDiscoveryValidationError("geometry_coordinate", "Geometry has no finite coordinates.");
  }
  return { west, south, east, north };
}

function ringAreaKm2(ring: readonly Position[]): number {
  // Spherical trapezoid area; accurate enough for validation and tile sizing.
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[i + 1];
    sum += (lng2 - lng1) * Math.PI / 180
      * (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
  }
  return Math.abs(sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM / 2);
}

export function geometryAreaKm2(geometry: DiscoveryGeometry): number {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((total, rings) => {
    const outer = ringAreaKm2(rings[0]);
    const holes = rings.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring), 0);
    return total + Math.max(0, outer - holes);
  }, 0);
}

export function pointInDiscoveryGeometry(point: Position, geometry: DiscoveryGeometry, includeBoundary = true): boolean {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((rings) => {
    if (!pointInRing(point, rings[0], includeBoundary)) return false;
    return !rings.slice(1).some((hole) => pointInRing(point, hole, !includeBoundary));
  });
}

function bboxAreaKm2(bbox: Bbox): number {
  const midLat = (bbox.south + bbox.north) / 2 * Math.PI / 180;
  return Math.max(0, bbox.north - bbox.south) * 111.195
    * Math.max(0, bbox.east - bbox.west) * 111.195 * Math.max(0.01, Math.cos(midLat));
}

function bboxIntersectsGeometry(bbox: Bbox, geometry: DiscoveryGeometry): boolean {
  const corners: Position[] = [
    [bbox.west, bbox.south], [bbox.east, bbox.south],
    [bbox.east, bbox.north], [bbox.west, bbox.north],
  ];
  if (corners.some((p) => pointInDiscoveryGeometry(p, geometry))) return true;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const edges: [Position, Position][] = corners.map((point, i) => [point, corners[(i + 1) % corners.length]]);
  for (const rings of polygons) for (const ring of rings) {
    for (const point of ring) {
      if (point[0] >= bbox.west && point[0] <= bbox.east && point[1] >= bbox.south && point[1] <= bbox.north) return true;
    }
    for (let i = 0; i < ring.length - 1; i++) {
      if (edges.some(([a, b]) => segmentsIntersect(ring[i], ring[i + 1], a, b))) return true;
    }
  }
  return false;
}

/** Plan deterministic bbox tiles, retaining the source geometry for final PIP clipping. */
export function planDiscoveryTiles(
  geometry: DiscoveryGeometry,
  options: { targetTileAreaKm2?: number; maxTiles?: number; maxDepth?: number } = {},
): DiscoveryTile[] {
  const target = Math.max(0.01, options.targetTileAreaKm2 ?? 12);
  const maxTiles = Math.max(1, Math.floor(options.maxTiles ?? 2_048));
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 16));
  const queue: { bbox: Bbox; depth: number; path: string }[] = [{ bbox: geometryBbox(geometry), depth: 0, path: "r" }];
  const tiles: DiscoveryTile[] = [];
  while (queue.length) {
    const next = queue.shift()!;
    if (!bboxIntersectsGeometry(next.bbox, geometry)) continue;
    const area = bboxAreaKm2(next.bbox);
    if (area <= target || next.depth >= maxDepth || tiles.length + queue.length + 2 > maxTiles) {
      tiles.push({ id: next.path, bbox: next.bbox, depth: next.depth, approxAreaKm2: area });
      continue;
    }
    const latKm = (next.bbox.north - next.bbox.south) * 111.195;
    const lngKm = (next.bbox.east - next.bbox.west) * 111.195
      * Math.cos((next.bbox.south + next.bbox.north) / 2 * Math.PI / 180);
    if (lngKm >= latKm) {
      const mid = (next.bbox.west + next.bbox.east) / 2;
      queue.push(
        { bbox: { ...next.bbox, east: mid }, depth: next.depth + 1, path: `${next.path}0` },
        { bbox: { ...next.bbox, west: mid }, depth: next.depth + 1, path: `${next.path}1` },
      );
    } else {
      const mid = (next.bbox.south + next.bbox.north) / 2;
      queue.push(
        { bbox: { ...next.bbox, north: mid }, depth: next.depth + 1, path: `${next.path}0` },
        { bbox: { ...next.bbox, south: mid }, depth: next.depth + 1, path: `${next.path}1` },
      );
    }
  }
  return tiles;
}

const DIRECTIONALS: Record<string, string> = {
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
  NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
  N: "N", S: "S", E: "E", W: "W", NE: "NE", NW: "NW", SE: "SE", SW: "SW",
};

const STATE_CODES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA",
  COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA",
  HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS",
  KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA",
  MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT",
  NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND",
  OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT",
  VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV",
  WISCONSIN: "WI", WYOMING: "WY", "DISTRICT OF COLUMBIA": "DC",
};

const STREET_SUFFIXES: Record<string, string> = {
  ALLEY: "ALY", ANNEX: "ANX", AVENUE: "AVE", BOULEVARD: "BLVD", BYPASS: "BYP",
  CIRCLE: "CIR", COURT: "CT", COVE: "CV", CRESCENT: "CRES", DRIVE: "DR",
  EXPRESSWAY: "EXPY", EXTENSION: "EXT", FREEWAY: "FWY", GARDENS: "GDNS",
  HEIGHTS: "HTS", HIGHWAY: "HWY", HOLLOW: "HOLW", JUNCTION: "JCT", LANE: "LN",
  PARKWAY: "PKWY", PLACE: "PL", PLAZA: "PLZ", POINT: "PT", ROAD: "RD",
  SQUARE: "SQ", STREET: "ST", TERRACE: "TER", TRAIL: "TRL", TURNPIKE: "TPKE",
  WAY: "WAY",
  ALY: "ALY", ANX: "ANX", AVE: "AVE", BLVD: "BLVD", BYP: "BYP", CIR: "CIR",
  CT: "CT", CV: "CV", CRES: "CRES", DR: "DR", EXPY: "EXPY", EXT: "EXT",
  FWY: "FWY", GDNS: "GDNS", HTS: "HTS", HWY: "HWY", HOLW: "HOLW", JCT: "JCT",
  LN: "LN", PKWY: "PKWY", PL: "PL", PLZ: "PLZ", PT: "PT", RD: "RD", SQ: "SQ",
  ST: "ST", TER: "TER", TRL: "TRL", TPKE: "TPKE",
};

const SUFFIX_EXPANSIONS: Record<string, string> = Object.fromEntries(
  Object.entries(STREET_SUFFIXES).filter(([long, short]) => long !== short).map(([long, short]) => [short, long]),
);
const DIRECTION_EXPANSIONS: Record<string, string> = Object.fromEntries(
  Object.entries(DIRECTIONALS).filter(([long, short]) => long !== short).map(([long, short]) => [short, long]),
);

export function normalizeUnicodeText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalTokens(value: string): string[] {
  return normalizeUnicodeText(value)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/\bNORTH CAROLINA\s+(?:STATE\s+)?(?:ROUTE|HIGHWAY|HWY)\s+/g, "NC HWY ")
    .replace(/\bNC\s+(?:ROUTE|HIGHWAY|HWY)\s+/g, "NC HWY ")
    .replace(/\bU\.?\s*S\.?\s+(?:ROUTE|HIGHWAY|HWY)?\s*/g, "US HWY ")
    .replace(/\bINTERSTATE\s+(?:HIGHWAY\s+)?/g, "I ")
    .replace(/\bSTATE\s+(?:ROUTE|ROAD|HIGHWAY)\s+/g, "STATE HWY ")
    .replace(/[^A-Z0-9#'\-/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function normalizeHouseNumber(value: string | undefined): string {
  return canonicalTokens(value ?? "").join(" ").replace(/\s*([\-/])\s*/g, "$1");
}

export function normalizeStreet(value: string | undefined): string {
  const tokens = canonicalTokens(value ?? "");
  if (!tokens.length) return "";
  if (DIRECTIONALS[tokens[0]]) tokens[0] = DIRECTIONALS[tokens[0]];
  if (DIRECTIONALS[tokens[tokens.length - 1]]) tokens[tokens.length - 1] = DIRECTIONALS[tokens[tokens.length - 1]];
  for (let i = 0; i < tokens.length; i++) if (STREET_SUFFIXES[tokens[i]]) tokens[i] = STREET_SUFFIXES[tokens[i]];
  return tokens.join(" ");
}

export function normalizeUnit(value: string | undefined): string {
  const text = canonicalTokens(value ?? "").join(" ");
  if (!text) return "";
  return text
    .replace(/^APARTMENT\b/, "APT")
    .replace(/^BUILDING\b/, "BLDG")
    .replace(/^SUITE\b/, "STE")
    .replace(/^FLOOR\b/, "FL")
    .replace(/^#\s*/, "UNIT ")
    .replace(/^(APT|UNIT|STE|BLDG|FL|LOT|TRLR)\s*#?\s*/, "$1 ")
    .trim();
}

export function normalizePostalCode(value: string | undefined): string {
  const digits = (value ?? "").replace(/[^0-9]/g, "");
  if (digits.length >= 9) return `${digits.slice(0, 5)}-${digits.slice(5, 9)}`;
  return digits.slice(0, 5);
}

function normalizePlace(value: string | undefined): string {
  return canonicalTokens(value ?? "").join(" ");
}

function normalizeStateCode(value: string | undefined): string {
  const normalized = normalizePlace(value);
  if (normalized.length === 2) return normalized;
  return STATE_CODES[normalized] ?? normalized;
}

function splitAddress(raw: RawAddressRecord): {
  houseNumber: string; street: string; unit: string; city: string; state: string; postalCode: string;
} {
  let houseNumber = raw.houseNumber ?? "";
  let street = raw.street ?? "";
  let unit = raw.unit ?? "";
  let city = raw.city ?? "";
  let state = raw.state ?? "";
  let postalCode = raw.postalCode ?? "";
  const full = normalizeUnicodeText(raw.rawAddress);
  if (full) {
    const parts = full.split(",").map((part) => part.trim()).filter(Boolean);
    const line = parts[0] ?? "";
    if (!houseNumber || !street) {
      const match = line.match(/^([^\s,]+)\s+(.+)$/);
      if (match) { houseNumber ||= match[1]; street ||= match[2]; }
    }
    if (!city && parts.length > 1) city = parts[1];
    if ((!state || !postalCode) && parts.length > 2) {
      const locality = parts[2].match(/^([A-Za-z .]+?)(?:\s+(\d{5}(?:-\d{4})?))?$/);
      if (locality) { state ||= locality[1].trim(); postalCode ||= locality[2] ?? ""; }
    }
  }
  const unitMatch = street.match(/(?:\s+|,)(#\s*[A-Za-z0-9-]+|(?:APT|APARTMENT|UNIT|SUITE|STE|BLDG|BUILDING|FLOOR|FL|LOT|TRLR)\s*#?\s*[A-Za-z0-9-]+)\s*$/i);
  if (!unit && unitMatch) {
    unit = unitMatch[1];
    street = street.slice(0, unitMatch.index).trim();
  }
  return { houseNumber, street, unit, city, state, postalCode };
}

function coordinateIdentity(lat: number | undefined, lng: number | undefined): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  // Five decimals is roughly one metre; only secondary evidence when ZIP is absent.
  return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

export function createCanonicalAddressKey(input: {
  normalizedHouseNumber: string;
  normalizedStreet: string;
  normalizedUnit?: string;
  normalizedPostalCode?: string;
  normalizedState?: string;
  normalizedCity?: string;
  lat?: number;
  lng?: number;
}): string {
  const locality = input.normalizedPostalCode
    || [input.normalizedState, input.normalizedCity, coordinateIdentity(input.lat, input.lng)].filter(Boolean).join(":");
  return [input.normalizedHouseNumber, input.normalizedStreet, input.normalizedUnit ?? "", locality].join("|");
}

export function generateProviderAddressVariants(candidate: Pick<NormalizedAddressCandidate,
  "normalizedHouseNumber" | "normalizedStreet" | "normalizedUnit" | "normalizedCity" | "normalizedState" | "normalizedPostalCode"
>): string[] {
  const streetTokens = candidate.normalizedStreet.split(" ").filter(Boolean);
  const variants: string[] = [];
  const add = (street: string) => {
    const line = [candidate.normalizedHouseNumber, street, candidate.normalizedUnit].filter(Boolean).join(" ");
    const locality = [candidate.normalizedCity, candidate.normalizedState, candidate.normalizedPostalCode].filter(Boolean).join(", ");
    const formatted = [line, locality].filter(Boolean).join(", ");
    if (formatted && !variants.includes(formatted)) variants.push(formatted);
  };
  add(candidate.normalizedStreet);
  const expanded = streetTokens.map((token, index) => {
    if ((index === 0 || index === streetTokens.length - 1) && DIRECTION_EXPANSIONS[token]) return DIRECTION_EXPANSIONS[token];
    return SUFFIX_EXPANSIONS[token] ?? token;
  }).join(" ");
  if (expanded !== candidate.normalizedStreet) add(expanded);
  // Provider-sensitive highway spelling variants.
  if (/^(?:US|STATE) HWY \d/.test(candidate.normalizedStreet)) add(candidate.normalizedStreet.replace(" HWY ", " HIGHWAY "));
  if (/^I \d/.test(candidate.normalizedStreet)) add(candidate.normalizedStreet.replace(/^I /, "INTERSTATE "));
  return variants;
}

export function normalizeAddress(raw: RawAddressRecord): NormalizedAddressCandidate {
  const parsed = splitAddress(raw);
  const normalizedHouseNumber = normalizeHouseNumber(parsed.houseNumber);
  const normalizedStreet = normalizeStreet(parsed.street);
  const normalizedUnit = normalizeUnit(parsed.unit);
  const normalizedCity = normalizePlace(parsed.city);
  const normalizedState = normalizeStateCode(parsed.state);
  const normalizedPostalCode = normalizePostalCode(parsed.postalCode);
  const country = normalizePlace(raw.country || "US");
  const canonicalKey = createCanonicalAddressKey({
    normalizedHouseNumber, normalizedStreet, normalizedUnit, normalizedPostalCode,
    normalizedState, normalizedCity, lat: raw.lat, lng: raw.lng,
  });
  const line = [normalizedHouseNumber, normalizedStreet, normalizedUnit].filter(Boolean).join(" ");
  const locality = [normalizedCity, normalizedState, normalizedPostalCode].filter(Boolean).join(", ");
  const canonicalAddress = [line, locality].filter(Boolean).join(", ");
  const rawAddress = raw.rawAddress
    || [[raw.houseNumber, raw.street, raw.unit].filter(Boolean).join(" "), raw.city, raw.state, raw.postalCode].filter(Boolean).join(", ");
  const source: AddressProvenance = {
    source: raw.source,
    sourceId: raw.sourceId,
    method: raw.observationType,
  };
  const candidate: NormalizedAddressCandidate = {
    rawAddress,
    canonicalAddress,
    canonicalKey,
    normalizedHouseNumber,
    normalizedStreet,
    normalizedUnit,
    normalizedCity,
    normalizedState,
    normalizedPostalCode,
    country,
    lat: Number.isFinite(raw.lat) ? raw.lat : undefined,
    lng: Number.isFinite(raw.lng) ? raw.lng : undefined,
    coordinateQuality: raw.coordinateQuality ?? "UNKNOWN",
    observationType: raw.observationType ?? (normalizedHouseNumber && normalizedStreet ? "OBSERVED" : "PARTIAL"),
    confidence: Math.min(1, Math.max(0, raw.confidence ?? (normalizedHouseNumber && normalizedStreet ? 0.9 : 0.35))),
    validationRequired: raw.validationRequired ?? !(normalizedHouseNumber && normalizedStreet),
    sources: raw.provenance?.length ? [...raw.provenance] : [source],
    providerVariants: [],
  };
  candidate.providerVariants = generateProviderAddressVariants(candidate);
  return candidate;
}

function haversineMeters(a: NormalizedAddressCandidate, b: NormalizedAddressCandidate): number {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return Infinity;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad, lat2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * 1000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function mergeCandidates(
  a: NormalizedAddressCandidate,
  b: NormalizedAddressCandidate,
  sourceRank: ReadonlyMap<string, number>,
): NormalizedAddressCandidate {
  const aRank = Math.min(...a.sources.map((source) => sourceRank.get(source.source) ?? Number.MAX_SAFE_INTEGER));
  const bRank = Math.min(...b.sources.map((source) => sourceRank.get(source.source) ?? Number.MAX_SAFE_INTEGER));
  const best = bRank < aRank || (bRank === aRank && b.confidence > a.confidence) ? b : a;
  const other = best === a ? b : a;
  const sources = [...best.sources];
  for (const source of other.sources) {
    if (!sources.some((item) => item.source === source.source && item.sourceId === source.sourceId)) sources.push(source);
  }
  return {
    ...best,
    lat: best.lat ?? other.lat,
    lng: best.lng ?? other.lng,
    validationRequired: best.validationRequired && other.validationRequired,
    sources,
    providerVariants: [...new Set([...best.providerVariants, ...other.providerVariants])],
  };
}

/**
 * Conservative in-memory dedupe for a discovery batch. Durable uniqueness must
 * still be enforced by storage. Separate units are never spatially merged.
 */
export function dedupeAddressCandidates(
  candidates: readonly NormalizedAddressCandidate[],
  options: { sourcePriority?: readonly string[]; spatialToleranceMeters?: number } = {},
): NormalizedAddressCandidate[] {
  const out: NormalizedAddressCandidate[] = [];
  const byCanonical = new Map<string, number>();
  const bySource = new Map<string, number>();
  // Canonical keys intentionally include ZIP/coordinates and therefore cannot
  // catch every equivalent record. Index the stable address identity as well
  // so the conservative spatial fallback examines only plausible matches,
  // rather than scanning the entire accumulated result for every candidate.
  const byAddressIdentity = new Map<string, Set<number>>();
  const sourceRank = new Map((options.sourcePriority ?? []).map((source, index) => [source, index]));
  const spatialToleranceMeters = Math.max(0, options.spatialToleranceMeters ?? 30);
  for (const candidate of candidates) {
    let match = candidate.canonicalKey && candidate.normalizedHouseNumber && candidate.normalizedStreet
      ? byCanonical.get(candidate.canonicalKey) : undefined;
    if (match == null) {
      for (const source of candidate.sources) {
        const key = source.sourceId ? `${source.source}:${source.sourceId}` : "";
        if (key && bySource.has(key)) {
          const sourceMatch = bySource.get(key)!;
          // A building/parcel source ID can legitimately carry multiple units.
          // Source identity is never allowed to collapse distinct unit identity.
          if (out[sourceMatch].normalizedUnit === candidate.normalizedUnit) { match = sourceMatch; break; }
        }
      }
    }
    if (match == null && candidate.normalizedHouseNumber && candidate.normalizedStreet) {
      const identity = [candidate.normalizedHouseNumber, candidate.normalizedStreet, candidate.normalizedUnit].join("|");
      const plausible = byAddressIdentity.get(identity) ?? new Set<number>();
      const spatialMatch = [...plausible].find((index) => {
        const existing = out[index];
        return existing.normalizedUnit === candidate.normalizedUnit
        && (!existing.normalizedPostalCode || !candidate.normalizedPostalCode || existing.normalizedPostalCode === candidate.normalizedPostalCode)
        && haversineMeters(existing, candidate) <= spatialToleranceMeters;
      });
      if (spatialMatch != null) match = spatialMatch;
    }
    const index = match == null ? out.push(candidate) - 1 : match;
    if (match != null) out[index] = mergeCandidates(out[index], candidate, sourceRank);
    if (out[index].canonicalKey) byCanonical.set(out[index].canonicalKey, index);
    if (out[index].normalizedHouseNumber && out[index].normalizedStreet) {
      const identity = [out[index].normalizedHouseNumber, out[index].normalizedStreet, out[index].normalizedUnit].join("|");
      const indexes = byAddressIdentity.get(identity) ?? new Set<number>();
      indexes.add(index);
      byAddressIdentity.set(identity, indexes);
    }
    for (const source of out[index].sources) if (source.sourceId) bySource.set(`${source.source}:${source.sourceId}`, index);
  }
  return out;
}
