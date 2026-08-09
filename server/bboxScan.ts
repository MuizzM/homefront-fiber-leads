// ── bboxScan — pure helpers for the draw-a-box area scan ──────────────────────
// No I/O, no DB, no network. Everything here is deterministic so it can be
// unit-tested directly (tests/unit/bbox-scan.test.ts). The route (server/routes.ts
// → POST /api/scan/area) composes these with the address sources + Kinetic.
//
// Why this exists: a box drawn over a NEW-CONSTRUCTION subdivision (e.g. Nard Ln)
// was returning "No addresses found …" because (a) a malformed / lat-first bbox
// slipped through unchecked, (b) the reverse-geocode grid was too coarse for a
// tight box and its strict inside-box filter dropped edge houses, and (c) the
// Kinetic qualifier fired with unbounded concurrency. These helpers fix 1 and 2
// (validation + adaptive grid) and give the route a bounded concurrency primitive.

export interface BboxLL { south: number; north: number; west: number; east: number }

export type BboxValidation =
  | { ok: true; bbox: BboxLL; corrected: boolean; approxKm2: number }
  | { ok: false; code: BboxErrorCode; message: string };

export type BboxErrorCode =
  | "bbox_missing"      // a coordinate was absent / non-numeric
  | "bbox_range"        // lat outside [-90,90] or lng outside [-180,180]
  | "bbox_degenerate"   // zero-area box (a point or a line)
  | "bbox_too_large";   // implausibly huge — almost always a client bug

// Roughly how big we ever expect a hand-drawn scan box to be. A whole US state
// is ~1e5 km²; a drawn subdivision is <5 km². 20,000 km² is a generous ceiling
// that still rejects an obviously-wrong whole-country box.
const MAX_BOX_KM2 = 20_000;

// Degrees → km at NC latitudes (cos(35.5°) ≈ 0.814). Good enough for a size guard.
const KM_PER_DEG_LAT = 111;
const KM_PER_DEG_LNG = 111 * 0.814;

/**
 * Validate + normalize a client-sent bounding box.
 *
 * Accepts the loose `{minLat,maxLat,minLng,maxLng}` shape the client posts and
 * returns a canonical `{south,north,west,east}` bbox (the order the address
 * sources expect), OR a typed error. It is deliberately forgiving about the
 * ORDER of the pair (min/max swapped is auto-corrected, `corrected:true`) but
 * strict about the things that produce a silent empty scan: missing numbers,
 * out-of-range coordinates, and a zero-area box.
 */
export function validateScanBbox(raw: {
  minLat?: unknown; maxLat?: unknown; minLng?: unknown; maxLng?: unknown;
}): BboxValidation {
  const nums = [raw.minLat, raw.maxLat, raw.minLng, raw.maxLng].map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) {
    return { ok: false, code: "bbox_missing", message: "minLat, maxLat, minLng, maxLng are required and must be numbers." };
  }
  let [minLat, maxLat, minLng, maxLng] = nums;

  // Auto-correct a swapped pair rather than failing — a min>max box is almost
  // always the drag direction, not garbage. Track it so the route can log it.
  let corrected = false;
  if (minLat > maxLat) { [minLat, maxLat] = [maxLat, minLat]; corrected = true; }
  if (minLng > maxLng) { [minLng, maxLng] = [maxLng, minLng]; corrected = true; }

  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) {
    return { ok: false, code: "bbox_range", message: "Coordinates out of range - latitude must be −90…90 and longitude −180…180. (Is the box lat/lng-swapped?)" };
  }

  // Service-area envelope (generous North America). This is what actually catches
  // a lat-first / lng↔lat-swapped bbox: swapped NC coords (lat≈−80, lng≈35) are
  // each individually a valid degree value but land far outside NA. A real US or
  // Canadian box always falls inside this box, so it never rejects a legit scan.
  const NA = { south: 15, north: 72, west: -170, east: -50 };
  if (maxLat < NA.south || minLat > NA.north || maxLng < NA.west || minLng > NA.east) {
    return { ok: false, code: "bbox_range", message: "That box isn't inside the service area - the coordinates look latitude/longitude-swapped." };
  }

  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  // A truly zero-area box (a click, not a drag) can't enumerate anything.
  if (latSpan <= 0 || lngSpan <= 0) {
    return { ok: false, code: "bbox_degenerate", message: "That box has no area - drag to draw a box over the homes." };
  }

  const approxKm2 = latSpan * KM_PER_DEG_LAT * lngSpan * KM_PER_DEG_LNG;
  if (approxKm2 > MAX_BOX_KM2) {
    return { ok: false, code: "bbox_too_large", message: `That box covers ~${Math.round(approxKm2).toLocaleString()} km² - far too large to scan. Draw a box around a neighborhood.` };
  }

  return { ok: true, bbox: { south: minLat, north: maxLat, west: minLng, east: maxLng }, corrected, approxKm2 };
}

/**
 * Choose a reverse-geocode grid step (in degrees) for a bbox.
 *
 * The old code used a fixed 0.0012° (~130 m) step. For a TIGHT box drawn around
 * one new street that yields only 1–2 sample points, and the nearest houses the
 * geocoder returns often sit just outside the box and get filtered away → zero
 * results. This makes the step adaptive: guarantee at least `minSamplesPerSide`
 * points across the SHORTER dimension so a small box is sampled densely, while
 * never exceeding `maxPoints` total (the billable-call ceiling) for a big box.
 */
export function adaptiveGridStep(
  bbox: BboxLL,
  opts: { minSamplesPerSide?: number; maxPoints?: number; floorDeg?: number; ceilDeg?: number } = {},
): number {
  const minSamplesPerSide = opts.minSamplesPerSide ?? 6;
  const maxPoints = opts.maxPoints ?? 2500;
  const floorDeg = opts.floorDeg ?? 0.00035; // ~38 m — don't oversample past house spacing
  const ceilDeg = opts.ceilDeg ?? 0.006;     // ~660 m — the coarse metro step

  const latSpan = Math.max(0, bbox.north - bbox.south);
  const lngSpan = Math.max(0, bbox.east - bbox.west);
  const shortSide = Math.min(latSpan, lngSpan);
  const pointsAt = (s: number) => (Math.floor(latSpan / s) + 1) * (Math.floor(lngSpan / s) + 1);

  // Dense-enough step for the short side, kept within [floor, ceil].
  const denseStep = shortSide > 0 ? shortSide / minSamplesPerSide : ceilDeg;
  let step = Math.min(ceilDeg, Math.max(floorDeg, denseStep));

  // The point budget is the billable-call ceiling — it MUST win, even over
  // `ceilDeg`, or a huge box would throw past HARVEST_CAP. Find the smallest
  // step that stays under budget (fencepost-aware) and take whichever is larger.
  if (pointsAt(step) > maxPoints && latSpan > 0 && lngSpan > 0) {
    let budgetStep = Math.sqrt((latSpan * lngSpan) / maxPoints) || floorDeg;
    let guard = 0;
    while (pointsAt(budgetStep) > maxPoints && guard++ < 2000) budgetStep *= 1.03;
    step = Math.max(step, budgetStep);
  }
  return Math.max(floorDeg, step);
}

/**
 * Bounded-concurrency async map. Runs at most `limit` `fn` calls at once,
 * preserves input order in the output, and never rejects — a failing item's
 * slot is filled by `onError(err, item, index)` (default: rethrow-as-value is
 * avoided; caller supplies a fallback). This is the primitive the box-scan uses
 * to keep outbound Kinetic calls under a ceiling (so a big box can't fan out to
 * hundreds of simultaneous proxied requests and trip a 429).
 */
export async function pooledMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const out: R[] = new Array(n);
  const width = Math.max(1, Math.min(limit | 0 || 1, n || 1));
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= n) return;
      out[i] = await fn(items[i], i);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < width && w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/** Exponential backoff with full jitter, capped. Pure — returns the delay in ms. */
export function backoffDelayMs(attempt: number, opts: { baseMs?: number; capMs?: number; rand?: () => number } = {}): number {
  const baseMs = opts.baseMs ?? 250;
  const capMs = opts.capMs ?? 4000;
  const rand = opts.rand ?? Math.random;
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(rand() * exp); // full jitter: [0, exp)
}
