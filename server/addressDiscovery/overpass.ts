import { createHash } from "node:crypto";
import {
  dedupeAddressCandidates,
  normalizeAddress,
  planDiscoveryTiles,
  pointInDiscoveryGeometry,
  validateDiscoveryGeometry,
  type AddressProvenance,
  type Bbox,
  type DiscoveryGeometry,
  type NormalizedAddressCandidate,
  type Position,
  type RawAddressRecord,
} from "../../shared/addressDiscovery";

export interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role?: string;
}

export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  nodes?: number[];
  members?: OsmMember[];
  geometry?: { lat: number; lon: number }[];
}

export interface OsmResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string; copyright?: string };
  elements?: OsmElement[];
  remark?: string;
}

export interface ParsedOsmAddress extends NormalizedAddressCandidate {
  osmType: OsmElement["type"];
  osmId: number;
  inferenceMethod: "DIRECT" | "FULL_ADDRESS" | "PLACE" | "ASSOCIATED_STREET" | "CONTAINED_ADDRESS" | "NEARBY_ROAD" | "INTERPOLATION" | "UNRESOLVED_PARTIAL";
}

export interface ParseOsmOptions {
  city?: string;
  state?: string;
  postalCode?: string;
  geometry?: DiscoveryGeometry;
  retrievedAt?: string;
  sourceVersion?: string;
  nearbyRoadMaxMeters?: number;
}

function elementKey(element: Pick<OsmElement, "type" | "id">): string {
  return `${element.type}/${element.id}`;
}

function mergeOsmElements(existing: OsmElement | undefined, incoming: OsmElement): OsmElement {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    lat: incoming.lat ?? existing.lat,
    lon: incoming.lon ?? existing.lon,
    center: incoming.center ?? existing.center,
    tags: { ...existing.tags, ...incoming.tags },
    nodes: (incoming.nodes?.length ?? 0) >= (existing.nodes?.length ?? 0) ? incoming.nodes : existing.nodes,
    members: (incoming.members?.length ?? 0) >= (existing.members?.length ?? 0) ? incoming.members : existing.members,
    geometry: (incoming.geometry?.length ?? 0) >= (existing.geometry?.length ?? 0) ? incoming.geometry : existing.geometry,
  };
}

function elementPosition(element: OsmElement, nodes: ReadonlyMap<number, OsmElement>): Position | undefined {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (Number.isFinite(lat) && Number.isFinite(lng)) return [Number(lng), Number(lat)];
  const points = elementGeometry(element, nodes);
  if (!points.length) return undefined;
  // Mean center is deliberately a fallback. Overpass `out center` remains the
  // preferred representative point for concave building geometries.
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

function elementGeometry(element: OsmElement, nodes: ReadonlyMap<number, OsmElement>): Position[] {
  if (element.geometry?.length) {
    return element.geometry
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
      .map((point) => [point.lon, point.lat] as Position);
  }
  return (element.nodes ?? [])
    .map((id) => nodes.get(id))
    .filter((node): node is OsmElement => Boolean(node && Number.isFinite(node.lat) && Number.isFinite(node.lon)))
    .map((node) => [Number(node.lon), Number(node.lat)] as Position);
}

function pointInRing(point: Position, ring: readonly Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const crosses = (a[1] > point[1]) !== (b[1] > point[1]);
    if (crosses && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distanceMetersToSegment(point: Position, a: Position, b: Position): number {
  const latScale = 111_195;
  const lngScale = latScale * Math.cos(point[1] * Math.PI / 180);
  const ax = (a[0] - point[0]) * lngScale, ay = (a[1] - point[1]) * latScale;
  const bx = (b[0] - point[0]) * lngScale, by = (b[1] - point[1]) * latScale;
  const dx = bx - ax, dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function distanceMetersBetween(a: Position, b: Position): number {
  const meanLat = (a[1] + b[1]) / 2 * Math.PI / 180;
  const x = (b[0] - a[0]) * 111_195 * Math.cos(meanLat);
  const y = (b[1] - a[1]) * 111_195;
  return Math.hypot(x, y);
}

function distanceMetersToLine(point: Position, line: readonly Position[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return distanceMetersToSegment(point, line[0], line[0]);
  let distance = Infinity;
  for (let i = 0; i < line.length - 1; i++) distance = Math.min(distance, distanceMetersToSegment(point, line[i], line[i + 1]));
  return distance;
}

function interpolateOnLine(line: readonly Position[], fraction: number): Position | undefined {
  if (!line.length) return undefined;
  if (line.length === 1) return line[0];
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const length = distanceMetersBetween(line[i], line[i + 1]);
    lengths.push(length);
    total += length;
  }
  if (total <= 0) return line[0];
  let target = Math.max(0, Math.min(1, fraction)) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const local = lengths[i] > 0 ? target / lengths[i] : 0;
      return [
        line[i][0] + (line[i + 1][0] - line[i][0]) * local,
        line[i][1] + (line[i + 1][1] - line[i][1]) * local,
      ];
    }
    target -= lengths[i];
  }
  return line[line.length - 1];
}

function addressProvenance(element: OsmElement, options: ParseOsmOptions, method: string, parentSourceId?: string): AddressProvenance[] {
  return [{
    source: "openstreetmap",
    sourceId: elementKey(element),
    sourceVersion: options.sourceVersion,
    retrievedAt: options.retrievedAt,
    attribution: "© OpenStreetMap contributors",
    license: "ODbL-1.0",
    method,
    parentSourceId,
    raw: { tags: element.tags ?? {}, members: element.members },
  }];
}

function candidateFromElement(
  element: OsmElement,
  nodes: ReadonlyMap<number, OsmElement>,
  options: ParseOsmOptions,
  street: string,
  method: ParsedOsmAddress["inferenceMethod"],
  confidence: number,
  fullAddress?: string,
  parentSourceId?: string,
  sourceIdOverride?: string,
): ParsedOsmAddress | undefined {
  const position = elementPosition(element, nodes);
  if (!position) return undefined;
  if (options.geometry && !pointInDiscoveryGeometry(position, options.geometry)) return undefined;
  const tags = element.tags ?? {};
  const observationType = method === "INTERPOLATION" ? "INTERPOLATED"
    : method === "UNRESOLVED_PARTIAL" ? "PARTIAL"
      : method === "DIRECT" || method === "FULL_ADDRESS" || method === "PLACE" ? "OBSERVED" : "INFERRED";
  const raw: RawAddressRecord = {
    source: "openstreetmap",
    sourceId: sourceIdOverride ?? elementKey(element),
    rawAddress: fullAddress,
    houseNumber: tags["addr:housenumber"],
    street,
    unit: tags["addr:unit"] || tags["addr:flats"],
    city: tags["addr:city"] || options.city,
    state: tags["addr:state"] || options.state,
    postalCode: tags["addr:postcode"] || options.postalCode,
    country: tags["addr:country"] || "US",
    lat: position[1],
    lng: position[0],
    coordinateQuality: method === "INTERPOLATION" ? "INTERPOLATED"
      : element.type === "node" && tags.entrance ? "ENTRANCE"
        : element.type === "node" ? "ROOFTOP" : "CENTROID",
    observationType,
    confidence,
    validationRequired: method === "INTERPOLATION" || method === "UNRESOLVED_PARTIAL" || method === "NEARBY_ROAD" || method === "CONTAINED_ADDRESS",
    provenance: addressProvenance(element, options, method, parentSourceId).map((item) => ({
      ...item,
      sourceId: sourceIdOverride ?? item.sourceId,
    })),
  };
  return { ...normalizeAddress(raw), osmType: element.type, osmId: element.id, inferenceMethod: method };
}

interface NumericHouseNumber {
  value: number;
  suffix: string;
  width: number;
}

function parseNumericHouseNumber(value: string | undefined): NumericHouseNumber | undefined {
  const match = (value ?? "").trim().match(/^(\d+)\s*([A-Za-z]?)$/);
  if (!match) return undefined;
  return { value: Number(match[1]), suffix: match[2].toUpperCase(), width: match[1].length };
}

/** Generate evidence-backed candidates for one OSM interpolation way. */
export function interpolateAddressWay(
  way: OsmElement,
  nodeIndex: ReadonlyMap<number, OsmElement>,
  options: ParseOsmOptions = {},
): ParsedOsmAddress[] {
  if (way.type !== "way") return [];
  const ruleRaw = way.tags?.["addr:interpolation"]?.trim().toLowerCase();
  if (!ruleRaw) return [];
  const endpointNodes = (way.nodes ?? []).map((id) => nodeIndex.get(id)).filter((node): node is OsmElement => Boolean(node?.tags?.["addr:housenumber"]));
  if (endpointNodes.length < 2) return [];
  const firstNode = endpointNodes[0], lastNode = endpointNodes[endpointNodes.length - 1];
  const first = parseNumericHouseNumber(firstNode.tags?.["addr:housenumber"]);
  const last = parseNumericHouseNumber(lastNode.tags?.["addr:housenumber"]);
  if (!first || !last || first.value === last.value || first.suffix !== last.suffix) return [];
  let interval: number;
  if (ruleRaw === "all") interval = 1;
  else if (ruleRaw === "odd" || ruleRaw === "even") interval = 2;
  else if (/^\d+$/.test(ruleRaw)) interval = Math.max(1, Number(ruleRaw));
  else return [];
  const low = Math.min(first.value, last.value), high = Math.max(first.value, last.value);
  if ((ruleRaw === "odd" && (low % 2 === 0 || high % 2 === 0))
    || (ruleRaw === "even" && (low % 2 !== 0 || high % 2 !== 0))) return [];
  const count = Math.floor((high - low - 1) / interval);
  if (count <= 0 || count > 1_000) return [];
  const street = way.tags?.["addr:street"] || firstNode.tags?.["addr:street"] || lastNode.tags?.["addr:street"] || way.tags?.["addr:place"] || "";
  if (!street) return [];
  const sharedUnit = firstNode.tags?.["addr:unit"] === lastNode.tags?.["addr:unit"] ? firstNode.tags?.["addr:unit"] : undefined;
  let line = elementGeometry(way, nodeIndex);
  const firstIndex = way.nodes?.indexOf(firstNode.id) ?? -1;
  const lastIndex = way.nodes?.indexOf(lastNode.id) ?? -1;
  if (firstIndex >= 0 && lastIndex >= 0 && line.length === way.nodes?.length) {
    line = firstIndex <= lastIndex
      ? line.slice(firstIndex, lastIndex + 1)
      : line.slice(lastIndex, firstIndex + 1).reverse();
  }
  if (line.length < 2) return [];
  const generated: ParsedOsmAddress[] = [];
  for (let number = low + interval; number < high; number += interval) {
    if (ruleRaw === "odd" && number % 2 === 0) continue;
    if (ruleRaw === "even" && number % 2 !== 0) continue;
    const fractionByNumber = (number - first.value) / (last.value - first.value);
    const position = interpolateOnLine(line, fractionByNumber);
    if (!position || (options.geometry && !pointInDiscoveryGeometry(position, options.geometry))) continue;
    const textNumber = `${String(number).padStart(Math.min(first.width, last.width), "0")}${first.suffix}`;
    const synthetic: OsmElement = {
      type: "way",
      id: way.id,
      center: { lat: position[1], lon: position[0] },
      tags: {
        ...way.tags,
        "addr:housenumber": textNumber,
        "addr:street": street,
        ...(sharedUnit ? { "addr:unit": sharedUnit } : {}),
      },
    };
    const candidate = candidateFromElement(
      synthetic,
      nodeIndex,
      options,
      street,
      "INTERPOLATION",
      0.58,
      undefined,
      elementKey(way),
      `${elementKey(way)}#${textNumber}`,
    );
    if (candidate) generated.push(candidate);
  }
  return generated;
}

/** Parse all useful addressed OSM element shapes without inventing addresses. */
export function parseOsmElements(elements: readonly OsmElement[], options: ParseOsmOptions = {}): ParsedOsmAddress[] {
  // Recursive Overpass output can repeat an addressed node/way later in `skel`
  // form. Merge duplicates so the skeletal copy never erases address tags.
  const merged = new Map<string, OsmElement>();
  for (const element of elements) merged.set(elementKey(element), mergeOsmElements(merged.get(elementKey(element)), element));
  const allElements = [...merged.values()];
  const nodes = new Map(allElements.filter((element) => element.type === "node").map((element) => [element.id, element]));
  const ways = new Map(allElements.filter((element) => element.type === "way").map((element) => [element.id, element]));
  const associatedStreet = new Map<string, string>();
  for (const relation of allElements) {
    if (relation.type !== "relation" || relation.tags?.type !== "associatedStreet") continue;
    const streetMembers = (relation.members ?? []).filter((member) => member.role === "street" && member.type === "way");
    const street = relation.tags?.name || relation.tags?.["addr:street"]
      || streetMembers.map((member) => ways.get(member.ref)?.tags?.name).find(Boolean) || "";
    if (!street) continue;
    for (const member of relation.members ?? []) {
      if (member.role === "house" || member.role === "address" || member.role === "") associatedStreet.set(`${member.type}/${member.ref}`, street);
    }
  }

  const namedRoads = allElements.filter((element) => element.type === "way" && element.tags?.highway && element.tags?.name)
    .map((element) => ({ element, line: elementGeometry(element, nodes) }))
    .filter((road) => road.line.length > 0);
  const addressedNodes = [...nodes.values()].filter((node) => node.tags?.["addr:street"] || node.tags?.["addr:place"] || node.tags?.["addr:full"]);
  const parsed: ParsedOsmAddress[] = [];

  for (const element of allElements) {
    const tags = element.tags ?? {};
    if (tags["addr:interpolation"] && element.type === "way") {
      parsed.push(...interpolateAddressWay(element, nodes, options));
      continue;
    }
    const houseNumber = tags["addr:housenumber"];
    const fullAddress = tags["addr:full"];
    if (!houseNumber && !fullAddress) continue;
    let street = tags["addr:street"] || tags["addr:place"] || "";
    let method: ParsedOsmAddress["inferenceMethod"] = fullAddress && !houseNumber ? "FULL_ADDRESS"
      : tags["addr:street"] ? "DIRECT" : tags["addr:place"] ? "PLACE" : "UNRESOLVED_PARTIAL";
    let confidence = method === "DIRECT" ? 0.97 : method === "FULL_ADDRESS" ? 0.94 : method === "PLACE" ? 0.84 : 0.3;
    let parentSourceId: string | undefined;

    if (!street && associatedStreet.has(elementKey(element))) {
      street = associatedStreet.get(elementKey(element))!;
      method = "ASSOCIATED_STREET";
      confidence = 0.82;
    }
    if (!street && element.type === "way") {
      const ring = elementGeometry(element, nodes);
      if (ring.length >= 3) {
        const contained = addressedNodes.filter((node) => {
          const point = elementPosition(node, nodes);
          return point ? pointInRing(point, ring) : false;
        });
        const candidates = [...new Set(contained.map((node) => node.tags?.["addr:street"] || node.tags?.["addr:place"]).filter((name): name is string => Boolean(name)))];
        if (candidates.length === 1) {
          street = candidates[0]; method = "CONTAINED_ADDRESS"; confidence = 0.72;
          parentSourceId = elementKey(contained[0]);
        }
      }
    }
    if (!street) {
      const point = elementPosition(element, nodes);
      if (point) {
        const nearest = namedRoads.map((road) => ({ ...road, distance: distanceMetersToLine(point, road.line) }))
          .sort((a, b) => a.distance - b.distance);
        const max = options.nearbyRoadMaxMeters ?? 60;
        // Reject ambiguity: require the nearest road to be materially closer.
        if (nearest[0]?.distance <= max && (!nearest[1] || nearest[1].distance - nearest[0].distance >= 20 || nearest[1].distance / Math.max(1, nearest[0].distance) >= 1.8)) {
          street = nearest[0].element.tags!.name!;
          method = "NEARBY_ROAD";
          confidence = 0.5;
          parentSourceId = elementKey(nearest[0].element);
        }
      }
    }
    const candidate = candidateFromElement(element, nodes, options, street, method, confidence, fullAddress, parentSourceId);
    if (candidate) parsed.push(candidate);
  }
  return dedupeAddressCandidates(parsed) as ParsedOsmAddress[];
}

function selectorForBbox(bbox: Bbox): string {
  return `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
}

function selectorForGeometry(geometry: DiscoveryGeometry): string[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((polygon) => `(poly:"${polygon[0].slice(0, -1).map(([lng, lat]) => `${lat} ${lng}`).join(" ")}")`);
}

/** Build a bounded query for a bbox or already-tiled polygon. */
export function buildOverpassQuery(area: Bbox | DiscoveryGeometry, timeoutSeconds = 120): string {
  const selectors = "type" in area ? selectorForGeometry(area) : [selectorForBbox(area)];
  const statements = selectors.flatMap((selector) => [
    `nwr${selector}["addr:housenumber"];`,
    `nwr${selector}["addr:full"];`,
    `way${selector}["addr:interpolation"];`,
    `nwr${selector}["building"]["addr:housenumber"];`,
    `nwr${selector}["entrance"]["addr:housenumber"];`,
    `relation${selector}["type"="associatedStreet"];`,
    `way${selector}["highway"]["name"];`,
  ]).join("\n  ");
  // Overpass permits one geolocation modifier (center | geom | bb), not both.
  // `center` gives stable way/relation representatives; the recursive `>` then
  // returns member nodes used for interpolation and nearby-road geometry.
  return `[out:json][timeout:${Math.max(10, Math.min(180, Math.floor(timeoutSeconds)))}];\n(\n  ${statements}\n);\nout body center qt;\n>;\nout skel qt;`;
}

export function detectOverpassTruncation(response: OsmResponse, maxElements = 250_000): boolean {
  const remark = response.remark ?? "";
  return /timed?\s*out|runtime error|out of memory|query run out|rate limit|too many requests|maxsize/i.test(remark)
    || (response.elements?.length ?? 0) >= maxElements;
}

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

/** Validate configurable endpoints before any network request (SSRF guard). */
export function validateOverpassEndpoint(endpoint: string, allowedHosts: readonly string[] = []): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Overpass endpoint must be a valid URL."); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const explicitlyAllowed = allowedHosts.map((host) => host.toLowerCase()).includes(hostname);
  if (url.protocol !== "https:") throw new Error("Overpass endpoint must use HTTPS.");
  if (url.username || url.password) throw new Error("Overpass endpoint credentials are not allowed in the URL.");
  if (url.search || url.hash) throw new Error("Overpass endpoint must not contain a query string or fragment.");
  if (!explicitlyAllowed && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname.endsWith(".internal") || isPrivateIpv4(hostname) || hostname.includes(":"))) {
    throw new Error("Overpass endpoint resolves to a disallowed local/private host.");
  }
  return url;
}

function splitBbox(bbox: Bbox): Bbox[] {
  const latMid = (bbox.south + bbox.north) / 2;
  const lngMid = (bbox.west + bbox.east) / 2;
  return [
    { south: bbox.south, west: bbox.west, north: latMid, east: lngMid },
    { south: bbox.south, west: lngMid, north: latMid, east: bbox.east },
    { south: latMid, west: bbox.west, north: bbox.north, east: lngMid },
    { south: latMid, west: lngMid, north: bbox.north, east: bbox.east },
  ];
}

export interface OverpassEndpointHealth {
  endpoint: string;
  score: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastLatencyMs?: number;
  lastStatus?: number;
  lastError?: string;
}

export interface OverpassFetchResult {
  elements: OsmElement[];
  truncated: boolean;
  remark?: string;
  endpoint: string;
  sourceTimestamp?: string;
  fromCache: boolean;
  queryHash: string;
}

export interface OverpassAreaResult {
  elements: OsmElement[];
  complete: boolean;
  completedTileIds: string[];
  failedTileIds: string[];
  truncatedTileIds: string[];
  requests: number;
}

export interface OverpassClientOptions {
  endpoints?: string[];
  allowedHosts?: string[];
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  maxResponseBytes?: number;
  maxElements?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

interface CacheEntry {
  expiresAt: number;
  result: OverpassFetchResult;
}

const DEFAULT_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function finiteOption(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

/** Reliable, concurrency-bounded Overpass transport with health-aware failover. */
export class OverpassClient {
  private readonly endpoints: URL[];
  private readonly health = new Map<string, OverpassEndpointHealth>();
  private readonly cache = new Map<string, CacheEntry>();
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly options: Required<Omit<OverpassClientOptions, "endpoints" | "allowedHosts">>;

  constructor(options: OverpassClientOptions = {}) {
    const allowedHosts = options.allowedHosts ?? [];
    this.endpoints = (options.endpoints?.length ? options.endpoints : DEFAULT_ENDPOINTS)
      .map((endpoint) => validateOverpassEndpoint(endpoint, allowedHosts));
    if (!this.endpoints.length) throw new Error("At least one Overpass endpoint is required.");
    this.options = {
      concurrency: Math.max(1, Math.min(8, Math.floor(finiteOption(options.concurrency, 2)))),
      timeoutMs: Math.max(1_000, finiteOption(options.timeoutMs, 55_000)),
      maxAttempts: Math.max(1, Math.min(8, Math.floor(finiteOption(options.maxAttempts, 4)))),
      baseBackoffMs: Math.max(1, finiteOption(options.baseBackoffMs, 500)),
      maxBackoffMs: Math.max(1, finiteOption(options.maxBackoffMs, 15_000)),
      cacheTtlMs: Math.max(0, finiteOption(options.cacheTtlMs, 15 * 60_000)),
      cacheMaxEntries: Math.max(1, Math.floor(finiteOption(options.cacheMaxEntries, 256))),
      maxResponseBytes: Math.max(1_024, finiteOption(options.maxResponseBytes, 50 * 1024 * 1024)),
      maxElements: Math.max(1, finiteOption(options.maxElements, 250_000)),
      userAgent: options.userAgent ?? "HomeFrontFiber/2.0 (address discovery; support@homefrontsolutions.com)",
      fetchImpl: options.fetchImpl ?? fetch,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
    };
    for (const endpoint of this.endpoints) {
      this.health.set(endpoint.href, { endpoint: endpoint.href, score: 100, successes: 0, failures: 0, consecutiveFailures: 0, cooldownUntil: 0 });
    }
  }

  getEndpointHealth(): OverpassEndpointHealth[] {
    return [...this.health.values()].map((value) => ({ ...value }));
  }

  private async acquire(): Promise<void> {
    if (this.active < this.options.concurrency) { this.active++; return; }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  private pickEndpoint(): URL {
    const now = this.options.now();
    const ranked = [...this.endpoints].sort((a, b) => {
      const ah = this.health.get(a.href)!;
      const bh = this.health.get(b.href)!;
      const ac = ah.cooldownUntil > now ? 1 : 0;
      const bc = bh.cooldownUntil > now ? 1 : 0;
      return ac - bc || bh.score - ah.score;
    });
    return ranked[0];
  }

  private recordSuccess(endpoint: URL, latencyMs: number, status: number): void {
    const health = this.health.get(endpoint.href)!;
    health.successes++;
    health.consecutiveFailures = 0;
    health.cooldownUntil = 0;
    health.score = Math.min(100, health.score + 3);
    health.lastLatencyMs = latencyMs;
    health.lastStatus = status;
    health.lastError = undefined;
  }

  private recordFailure(endpoint: URL, error: unknown, status?: number): void {
    const health = this.health.get(endpoint.href)!;
    health.failures++;
    health.consecutiveFailures++;
    health.score = Math.max(0, health.score - Math.min(40, 8 * health.consecutiveFailures));
    health.lastStatus = status;
    health.lastError = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
    if (health.consecutiveFailures >= 2) health.cooldownUntil = this.options.now() + Math.min(60_000, 2_000 * 2 ** health.consecutiveFailures);
  }

  private cacheSet(key: string, result: OverpassFetchResult): void {
    if (this.options.cacheTtlMs <= 0) return;
    this.cache.delete(key);
    this.cache.set(key, { expiresAt: this.options.now() + this.options.cacheTtlMs, result });
    while (this.cache.size > this.options.cacheMaxEntries) this.cache.delete(this.cache.keys().next().value!);
  }

  async fetchQuery(query: string, sourceTimestamp = "", signal?: AbortSignal): Promise<OverpassFetchResult> {
    if (signal?.aborted) throw signal.reason ?? new Error("Overpass request cancelled.");
    if (!query.trim() || query.length > 1_000_000) throw new Error("Overpass query is empty or exceeds the safe request size.");
    const queryHash = createHash("sha256").update(query).update("\0").update(sourceTimestamp).digest("hex");
    const cached = this.cache.get(queryHash);
    if (cached && cached.expiresAt > this.options.now()) return { ...cached.result, elements: [...cached.result.elements], fromCache: true };
    if (cached) this.cache.delete(queryHash);

    await this.acquire();
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < this.options.maxAttempts; attempt++) {
        const endpoint = this.pickEndpoint();
        const started = this.options.now();
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason ?? new Error("Overpass request cancelled."));
        signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => controller.abort(new Error("Overpass request timed out.")), this.options.timeoutMs);
        try {
          const response = await this.options.fetchImpl(endpoint, {
            method: "POST",
            redirect: "error",
            headers: {
              "Accept": "application/json",
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              "User-Agent": this.options.userAgent,
            },
            body: `data=${encodeURIComponent(query)}`,
            signal: controller.signal,
          });
          const status = response.status;
          if (!response.ok) {
            const error = Object.assign(new Error(`Overpass HTTP ${status}`), { retryable: RETRYABLE_STATUS.has(status) });
            this.recordFailure(endpoint, error, status);
            if (!error.retryable) throw error;
            lastError = error;
            const retryAfter = Number(response.headers.get("retry-after"));
            const exponential = Math.min(this.options.maxBackoffMs, this.options.baseBackoffMs * 2 ** attempt);
            await this.options.sleep(Number.isFinite(retryAfter) && retryAfter >= 0
              ? Math.min(this.options.maxBackoffMs, retryAfter * 1_000)
              : Math.floor(exponential * (0.5 + this.options.random() * 0.5)));
            continue;
          }
          const declaredBytes = Number(response.headers.get("content-length"));
          if (Number.isFinite(declaredBytes) && declaredBytes > this.options.maxResponseBytes) {
            throw new Error("Overpass response exceeded the safe size limit.");
          }
          const body = await response.text();
          if (Buffer.byteLength(body, "utf8") > this.options.maxResponseBytes) throw new Error("Overpass response exceeded the safe size limit.");
          const data = JSON.parse(body) as OsmResponse;
          if (!Array.isArray(data.elements)) throw new Error("Overpass response did not contain an elements array.");
          const result: OverpassFetchResult = {
            elements: data.elements,
            truncated: detectOverpassTruncation(data, this.options.maxElements),
            remark: data.remark,
            endpoint: endpoint.href,
            sourceTimestamp: data.osm3s?.timestamp_osm_base,
            fromCache: false,
            queryHash,
          };
          this.recordSuccess(endpoint, this.options.now() - started, status);
          if (!result.truncated) this.cacheSet(queryHash, result);
          return result;
        } catch (error) {
          if ((error as { retryable?: boolean }).retryable === false) throw error;
          lastError = error;
          this.recordFailure(endpoint, error);
          if (attempt + 1 < this.options.maxAttempts) {
            const exponential = Math.min(this.options.maxBackoffMs, this.options.baseBackoffMs * 2 ** attempt);
            await this.options.sleep(Math.floor(exponential * (0.5 + this.options.random() * 0.5)));
          }
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Overpass request failed.");
    } finally {
      this.release();
    }
  }

  /**
   * Fetch a geometry as checkpointable tiles. Truncated tiles are subdivided;
   * unresolved leaves remain explicitly incomplete instead of being accepted.
   */
  async fetchArea(
    geometryInput: DiscoveryGeometry,
    options: {
      targetTileAreaKm2?: number;
      maxTiles?: number;
      maxRequests?: number;
      maxSubdivisionDepth?: number;
      completedTileIds?: ReadonlySet<string>;
      sourceTimestamp?: string;
      signal?: AbortSignal;
      onTile?: (event: { tileId: string; status: "completed" | "failed" | "subdivided"; result?: OverpassFetchResult; error?: unknown }) => void | Promise<void>;
    } = {},
  ): Promise<OverpassAreaResult> {
    const geometry = validateDiscoveryGeometry(geometryInput);
    const planned = planDiscoveryTiles(geometry, { targetTileAreaKm2: options.targetTileAreaKm2 ?? 12, maxTiles: options.maxTiles ?? 1_024 });
    const queue = planned.map((tile) => ({ id: tile.id, bbox: tile.bbox, depth: 0 }));
    const completed: string[] = [], failed: string[] = [], truncated: string[] = [];
    const elements = new Map<string, OsmElement>();
    const maxRequests = Math.max(1, options.maxRequests ?? 2_048);
    const maxDepth = Math.max(0, options.maxSubdivisionDepth ?? 4);
    let requests = 0;
    while (queue.length) {
      const tile = queue.shift()!;
      if (options.completedTileIds?.has(tile.id)) { completed.push(tile.id); continue; }
      if (requests >= maxRequests) { failed.push(tile.id, ...queue.map((item) => item.id)); break; }
      requests++;
      try {
        const result = await this.fetchQuery(buildOverpassQuery(tile.bbox), options.sourceTimestamp, options.signal);
        if (result.truncated && tile.depth < maxDepth) {
          await options.onTile?.({ tileId: tile.id, status: "subdivided", result });
          splitBbox(tile.bbox).forEach((bbox, index) => queue.push({ id: `${tile.id}.${index}`, bbox, depth: tile.depth + 1 }));
          continue;
        }
        if (result.truncated) truncated.push(tile.id);
        else completed.push(tile.id);
        for (const element of result.elements) {
          const key = elementKey(element);
          elements.set(key, mergeOsmElements(elements.get(key), element));
        }
        await options.onTile?.({ tileId: tile.id, status: "completed", result });
      } catch (error) {
        failed.push(tile.id);
        await options.onTile?.({ tileId: tile.id, status: "failed", error });
      }
    }
    return {
      elements: [...elements.values()],
      complete: failed.length === 0 && truncated.length === 0,
      completedTileIds: completed,
      failedTileIds: failed,
      truncatedTileIds: truncated,
      requests,
    };
  }
}

export function bboxToGeometry(bbox: Bbox): DiscoveryGeometry {
  return {
    type: "Polygon",
    coordinates: [[
      [bbox.west, bbox.south], [bbox.east, bbox.south],
      [bbox.east, bbox.north], [bbox.west, bbox.north], [bbox.west, bbox.south],
    ]],
  };
}


