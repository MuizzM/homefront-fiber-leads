export type FreshConfidence = "cross_verified" | "single_source_provisional";

export interface FreshFiberPoint {
  id: number;
  address: string;
  city: string;
  /** Two-letter state code; monitoring currently includes FL, GA, IA, KY, NC, and SC. */
  state: string;
  zip?: string | null;
  lat: number;
  lng: number;
  firstSeenLiveAt: string;
  confidence: FreshConfidence;
  sources: string[];
  leadId?: number | null;
  carrier?: string; // 'kinetic' (default) | 'frontier' — red on the map
  customerSegment?: "new_opportunity" | "existing_customer" | "unknown";
  customerConfidence?: "medium" | "low";
}

export interface FreshFiberCluster {
  id: string;
  city: string;
  state: string;
  centroid: { lat: number; lng: number };
  density: number;
  confirmed: number;
  provisional: number;
  firstDetectedAt: string;
  latestDetectedAt: string;
  score: number;
  mapUrl: string;
  addresses: FreshFiberPoint[];
}

const EARTH_METERS = 6_371_000;

export function haversineMeters(a: Pick<FreshFiberPoint, "lat" | "lng">, b: Pick<FreshFiberPoint, "lat" | "lng">): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_METERS * Math.asin(Math.sqrt(x));
}

export function clusterFreshFiber(
  points: FreshFiberPoint[],
  options: { radiusMeters?: number; nowMs?: number } = {},
): FreshFiberCluster[] {
  const radius = Math.max(25, Math.min(1_000, options.radiusMeters ?? 250));
  const nowMs = options.nowMs ?? Date.now();
  const parent = points.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const cellDeg = radius / 111_320;
  const buckets = new Map<string, number[]>();
  const cell = (p: FreshFiberPoint) => [Math.floor(p.lat / cellDeg), Math.floor(p.lng / cellDeg)] as const;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const [y, x] = cell(p);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const candidates = buckets.get(`${p.state}|${p.city.toLowerCase()}|${y + dy}|${x + dx}`) ?? [];
      for (const j of candidates) if (haversineMeters(p, points[j]) <= radius) union(i, j);
    }
    const key = `${p.state}|${p.city.toLowerCase()}|${y}|${x}`;
    buckets.set(key, [...(buckets.get(key) ?? []), i]);
  }

  const groups = new Map<number, FreshFiberPoint[]>();
  points.forEach((point, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), point]));
  return [...groups.values()].map((addresses) => {
    addresses.sort((a, b) => Date.parse(b.firstSeenLiveAt) - Date.parse(a.firstSeenLiveAt));
    const lat = addresses.reduce((sum, p) => sum + p.lat, 0) / addresses.length;
    const lng = addresses.reduce((sum, p) => sum + p.lng, 0) / addresses.length;
    const times = addresses.map((p) => Date.parse(p.firstSeenLiveAt)).filter(Number.isFinite);
    const latest = Math.max(...times);
    const earliest = Math.min(...times);
    const confirmed = addresses.filter((p) => p.confidence === "cross_verified").length;
    const ageHours = Math.max(0, (nowMs - latest) / 3_600_000);
    const recency = Math.max(0, 45 - ageHours * 0.35);
    const density = Math.min(40, 12 * Math.log2(addresses.length + 1));
    const verification = Math.min(15, confirmed * 5);
    const score = Math.round(Math.max(0, Math.min(100, recency + density + verification)));
    return {
      id: `${addresses[0].state}-${addresses[0].city.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${lat.toFixed(4)}-${lng.toFixed(4)}`,
      city: addresses[0].city, state: addresses[0].state,
      centroid: { lat, lng }, density: addresses.length, confirmed,
      provisional: addresses.length - confirmed,
      firstDetectedAt: new Date(earliest).toISOString(), latestDetectedAt: new Date(latest).toISOString(),
      score, mapUrl: `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`,
      addresses,
    };
  }).sort((a, b) => b.score - a.score || b.density - a.density || Date.parse(b.latestDetectedAt) - Date.parse(a.latestDetectedAt));
}
