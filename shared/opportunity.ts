// ── Opportunity clustering — find the neighborhoods worth deploying to ────────
// Verified new-fiber points are scattered across a city. A team works a
// contiguous area, not a scatter — so the product must find spatial CLUSTERS of
// opportunity, score them, and hand each one to the field as a drawable
// territory. Pure + deterministic + unit-tested; no DB, no map library.
//
// Algorithm: grid connected-components.
//   1. snap each point to a grid cell (cellDeg on a side, ~250m default)
//   2. union 8-adjacent occupied cells (union-find) → contiguous blobs
//   3. drop blobs below minPoints (noise)
//   4. per cluster: centroid, convex-hull boundary, bbox, opportunity score
// Complexity: O(n·α(n)) time (n points, near-linear union-find), O(cells) space.
// At 35k points this runs in a few ms — measured in the unit test. This beats a
// naive O(n²) pairwise DBSCAN and is stable: the same points always yield the
// same clusters (important — an operator must trust that a rescan's clusters
// mean the same thing).

export interface OppPoint {
  id: number;
  lat: number;
  lng: number;
  // Signal fields (all optional — a point may be a lead or a verified target):
  isNewFiber?: boolean;
  newlyLive?: boolean;        // provable unavailable->live flip (freshest)
  worked?: boolean;           // has >=1 knock (already being handled)
  sold?: boolean;
  leadScore?: number;         // 0..100
  competitor?: string | null; // competitor at this address (pressure signal)
  verifiedAtMs?: number | null;
}

export interface OppCluster {
  id: string;
  points: number[];           // member point ids
  size: number;
  centroid: { lat: number; lng: number };
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  hull: Array<[number, number]>; // convex-hull ring [lng,lat] — a drawable territory
  // Signal rollups:
  newFiber: number;
  newlyLive: number;
  unworked: number;           // members with no knock yet
  sold: number;
  avgScore: number;
  competitorShare: number;    // fraction with a known competitor (pressure)
  freshnessDays: number | null;
  // Derived:
  score: number;              // 0..100 — deploy-here-first
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

export interface ClusterOptions {
  cellDeg?: number;    // grid cell size in degrees (~0.0025 ≈ 250m at NC latitude)
  minPoints?: number;  // clusters smaller than this are noise
  maxSpanDeg?: number; // hard cap on a cluster's bbox span — bounds it to a
                       // workable territory. Single-linkage grid growth would
                       // otherwise chain a whole county into one un-deployable
                       // blob; a component wider than this is split (see below).
  nowMs?: number;
}

const DAY_MS = 86_400_000;

export function clusterOpportunities(points: OppPoint[], opts: ClusterOptions = {}): OppCluster[] {
  const cellDeg = opts.cellDeg ?? 0.0025;
  const minPoints = opts.minPoints ?? 4;
  const maxSpanDeg = opts.maxSpanDeg ?? 0.02; // ~2km — a walkable territory
  const nowMs = opts.nowMs ?? 0;

  const valid = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (valid.length === 0) return [];

  // ── 1. bucket points into grid cells ────────────────────────────────────────
  const cellKey = (lat: number, lng: number) =>
    `${Math.floor(lat / cellDeg)}:${Math.floor(lng / cellDeg)}`;
  const cellPoints = new Map<string, number[]>(); // cellKey -> point indices
  for (let i = 0; i < valid.length; i++) {
    const k = cellKey(valid[i].lat, valid[i].lng);
    const arr = cellPoints.get(k);
    if (arr) arr.push(i); else cellPoints.set(k, [i]);
  }

  // ── 2. union-find over 8-adjacent occupied cells ────────────────────────────
  const cells = [...cellPoints.keys()];
  const cellIndex = new Map(cells.map((c, i) => [c, i]));
  const parent = cells.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let ci = 0; ci < cells.length; ci++) {
    const [cy, cx] = cells[ci].split(":").map(Number);
    // Check the 4 forward neighbors (E, and the three on the row above) so each
    // adjacency is considered once — union is symmetric.
    for (const [dy, dx] of [[0, 1], [1, -1], [1, 0], [1, 1]] as const) {
      const nk = `${cy + dy}:${cx + dx}`;
      const ni = cellIndex.get(nk);
      if (ni !== undefined) union(ci, ni);
    }
  }

  // ── 3. group cells (and their points) by connected-component root ───────────
  const compPoints = new Map<number, number[]>();
  for (let ci = 0; ci < cells.length; ci++) {
    const root = find(ci);
    const pts = cellPoints.get(cells[ci])!;
    const bucket = compPoints.get(root);
    if (bucket) bucket.push(...pts); else compPoints.set(root, [...pts]);
  }

  // ── 4. split oversized components, build + score clusters, drop noise ───────
  // Single-linkage grid growth can chain an entire county into one component. A
  // territory a team can't walk is worthless, so any component whose bbox span
  // exceeds maxSpanDeg is recursively bisected along its longer axis at the
  // median until every piece is bounded. Deterministic (median split, stable).
  const clusters: OppCluster[] = [];
  let seq = 0;
  for (const idxList of compPoints.values()) {
    if (idxList.length < minPoints) continue;
    for (const piece of splitBySpan(idxList.map(i => valid[i]), maxSpanDeg)) {
      if (piece.length < minPoints) continue;
      clusters.push(buildCluster(`c${seq++}`, piece, piece.map(p => p.id), nowMs));
    }
  }

  // Strongest first — the operator reads top-down.
  clusters.sort((a, b) => b.score - a.score);
  // Re-id in ranked order so c0 is always the top cluster (stable references).
  return clusters.map((c, i) => ({ ...c, id: `c${i}` }));
}

// Recursively bisect a point set along its longer axis at the median until every
// piece's bbox span ≤ maxSpanDeg. Deterministic; keeps pieces contiguous-ish
// (median cut of a contiguous blob stays contiguous). Guards against infinite
// recursion when many points share a coordinate.
function splitBySpan(pts: OppPoint[], maxSpanDeg: number): OppPoint[][] {
  const b = spanOf(pts);
  if (pts.length <= 2 || (b.spanLat <= maxSpanDeg && b.spanLng <= maxSpanDeg)) return [pts];
  const byLng = b.spanLng >= b.spanLat;
  const sorted = [...pts].sort((a, z) => byLng ? (a.lng - z.lng) : (a.lat - z.lat));
  const mid = Math.floor(sorted.length / 2);
  let cut = mid;
  // Push the cut off a run of identical coordinates so both halves are non-empty.
  const key = (p: OppPoint) => byLng ? p.lng : p.lat;
  while (cut < sorted.length && key(sorted[cut]) === key(sorted[mid])) cut++;
  if (cut >= sorted.length) { cut = mid; while (cut > 0 && key(sorted[cut - 1]) === key(sorted[mid])) cut--; }
  if (cut <= 0 || cut >= sorted.length) return [pts]; // all-collinear degenerate — accept
  return [...splitBySpan(sorted.slice(0, cut), maxSpanDeg), ...splitBySpan(sorted.slice(cut), maxSpanDeg)];
}
function spanOf(pts: OppPoint[]): { spanLat: number; spanLng: number } {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of pts) { if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat; if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng; }
  return { spanLat: maxLat - minLat, spanLng: maxLng - minLng };
}

// Split a cluster's member points into k compact, contiguous, roughly-equal
// sub-parcels so a big opportunity can be handed to k reps. Same median-bisection
// engine; returns the member-id lists per parcel. k is clamped to [1, size].
export function subdivideCluster(memberPoints: OppPoint[], k: number): number[][] {
  const n = memberPoints.length;
  const kk = Math.max(1, Math.min(Math.floor(k), n));
  if (kk === 1) return [memberPoints.map(p => p.id)];
  // Recursively bisect into ~kk parcels (binary tree of median cuts).
  const parcels: OppPoint[][] = [memberPoints];
  while (parcels.length < kk) {
    // Split the largest-span parcel next so parcels stay balanced + compact.
    let bi = 0, best = -1;
    for (let i = 0; i < parcels.length; i++) {
      const s = spanOf(parcels[i]); const sp = Math.max(s.spanLat, s.spanLng);
      if (parcels[i].length > 1 && sp > best) { best = sp; bi = i; }
    }
    if (best < 0) break; // nothing splittable
    const target = parcels.splice(bi, 1)[0];
    const s = spanOf(target); const byLng = s.spanLng >= s.spanLat;
    const sorted = [...target].sort((a, z) => byLng ? a.lng - z.lng : a.lat - z.lat);
    const mid = Math.floor(sorted.length / 2);
    parcels.push(sorted.slice(0, mid), sorted.slice(mid));
  }
  return parcels.map(p => p.map(x => x.id));
}

function buildCluster(id: string, members: OppPoint[], ids: number[], nowMs: number): OppCluster {
  const size = members.length;
  let sumLat = 0, sumLng = 0, newFiber = 0, newlyLive = 0, unworked = 0, sold = 0;
  let scoreSum = 0, scoreN = 0, competitorN = 0, freshestMs: number | null = null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;

  for (const p of members) {
    sumLat += p.lat; sumLng += p.lng;
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng;
    if (p.isNewFiber) newFiber++;
    if (p.newlyLive) newlyLive++;
    if (!p.worked) unworked++;
    if (p.sold) sold++;
    if (typeof p.leadScore === "number") { scoreSum += p.leadScore; scoreN++; }
    if (p.competitor) competitorN++;
    if (p.verifiedAtMs != null && (freshestMs == null || p.verifiedAtMs > freshestMs)) freshestMs = p.verifiedAtMs;
  }

  const centroid = { lat: sumLat / size, lng: sumLng / size };
  const avgScore = scoreN > 0 ? scoreSum / scoreN : 0;
  const competitorShare = size > 0 ? competitorN / size : 0;
  const freshnessDays = freshestMs != null && nowMs > 0 ? Math.max(0, (nowMs - freshestMs) / DAY_MS) : null;
  const hull = convexHull(members.map(p => [p.lng, p.lat] as [number, number]));

  const reasons: string[] = [];
  // Score: substance (unworked new-fiber) dominates, freshness + demand-pressure
  // lift it, and an already-sold-heavy or fully-worked cluster is discounted.
  const unworkedNewFiber = members.filter(p => p.isNewFiber && !p.worked).length;
  const substance = 55 * satur(unworkedNewFiber, 25);
  if (unworkedNewFiber > 0) reasons.push(`${unworkedNewFiber} unworked new-fiber doors`);

  let freshness = 0;
  if (newlyLive > 0) { freshness = 20; reasons.push(`${newlyLive} just went live`); }
  else if (freshnessDays != null && freshnessDays <= 3) { freshness = 12; reasons.push("freshly verified"); }
  else if (freshnessDays != null && freshnessDays > 21) reasons.push(`${Math.round(freshnessDays)}d old`);

  const density = 12 * satur(size, 40);
  const pressure = 8 * competitorShare; // competitor-served homes = switchable demand
  if (competitorShare >= 0.5) reasons.push(`${Math.round(competitorShare * 100)}% competitor-served (switchable)`);
  const quality = 5 * (avgScore / 100);

  const workedShare = size > 0 ? (size - unworked) / size : 0;
  const worn = workedShare >= 0.7 ? -12 : workedShare >= 0.4 ? -5 : 0;
  if (workedShare >= 0.7) reasons.push("mostly worked already");

  const score = clamp(0, 100, substance + freshness + density + pressure + quality + worn);

  const confidence: OppCluster["confidence"] = size >= 30 ? "high" : size >= 10 ? "medium" : "low";

  return {
    id, points: ids, size, centroid,
    bbox: { minLat, maxLat, minLng, maxLng },
    hull,
    newFiber, newlyLive, unworked, sold,
    avgScore: round(avgScore, 1),
    competitorShare: round(competitorShare, 3),
    freshnessDays: freshnessDays == null ? null : round(freshnessDays, 1),
    score: Math.round(score),
    confidence,
    reasons: reasons.slice(0, 3),
  };
}

// Andrew's monotone chain convex hull. Input/output rings are [lng,lat]. O(n log n).
// Returns a closed-ish ring (first point NOT repeated at the end) suitable for a
// territory polygon. Degenerate inputs (<3 unique points) return the points as-is.
export function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const uniq = dedupe(pts);
  if (uniq.length <= 2) return uniq;
  const sorted = [...uniq].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Expand a hull outward by ~padMeters so a drawn territory encloses the homes at
// its edge (a tight hull clips boundary doors). Simple centroid-radial push —
// good enough for an operational polygon, not a cartographic buffer.
export function padHull(hull: Array<[number, number]>, padMeters: number): Array<[number, number]> {
  if (hull.length < 3 || padMeters <= 0) return hull;
  const cLat = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  const cLng = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const metersPerDegLat = 111_320;
  const metersPerDegLng = 111_320 * Math.cos((cLat * Math.PI) / 180);
  return hull.map(([lng, lat]) => {
    const dLat = lat - cLat, dLng = lng - cLng;
    const distM = Math.hypot(dLat * metersPerDegLat, dLng * metersPerDegLng);
    if (distM < 1e-6) return [lng, lat] as [number, number];
    const scale = (distM + padMeters) / distM;
    return [cLng + dLng * scale, cLat + dLat * scale] as [number, number];
  });
}

function dedupe(pts: Array<[number, number]>): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const p of pts) {
    const k = `${p[0]},${p[1]}`;
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}
function satur(value: number, k: number): number { return value <= 0 ? 0 : value / (value + k); }
function clamp(lo: number, hi: number, n: number): number { return Math.max(lo, Math.min(hi, isFinite(n) ? n : lo)); }
function round(n: number, dp: number): number { const f = Math.pow(10, dp); return Math.round(n * f) / f; }
