// ── Budgeted target selection — spend proxy money where it pays off ───────────
// Given a pool of addresses and a fixed budget of Kinetic checks, WHICH do we
// verify? Not a random slice, and not "the whole city" (that's a billing event).
// We rank by expected value and take the top `budget`.
//
// The dominant real signal is spatial autocorrelation: fiber is built out block
// by block, so an address next to a KNOWN new-fiber home is far likelier to be
// new-fiber than one in an untouched part of town. We exploit that — plus
// freshness (never-scanned > stale), field opportunity signal, and a light
// spread term so we don't pour the whole budget into one street.
//
// Pure + deterministic + unit-tested. No DB, no proxy.

export interface PoolTarget {
  id: number;
  lat: number | null;
  lng: number | null;
  lastScannedAtMs: number | null; // null = never scanned (most valuable to check)
  lastIsNewFiber?: boolean;       // last result (for rescan change-hunting)
  opportunityScore?: number | null; // field-learned signal (may be null)
}

export interface KnownPoint { lat: number; lng: number } // known new-fiber locations

export interface RankOptions {
  cellDeg?: number;   // grid resolution for proximity (~0.0025 ≈ 250m)
  nowMs?: number;
  rescan?: boolean;   // true = hunting for CHANGE (prioritize stale known-live)
}

export interface RankedTarget {
  id: number;
  ev: number;         // expected value 0..1 (explainable, comparable)
  seq: number;        // final priority order (0 = check first)
}

// Rank every target; caller slices [0, budget). O(n + k) with a grid index.
export function rankTargets(targets: PoolTarget[], known: KnownPoint[], opts: RankOptions = {}): RankedTarget[] {
  const cellDeg = opts.cellDeg ?? 0.0025;
  const nowMs = opts.nowMs ?? 0;
  const rescan = !!opts.rescan;

  // Grid index of known new-fiber POINT COUNTS → cheap O(1) graded proximity.
  // Counting (not just membership) lets evidence stack: five verified fiber homes
  // around an address is much stronger contiguity evidence than one.
  const cellKey = (lat: number, lng: number) => `${Math.floor(lat / cellDeg)}:${Math.floor(lng / cellDeg)}`;
  const knownCount = new Map<string, number>();
  for (const k of known) {
    if (Number.isFinite(k.lat) && Number.isFinite(k.lng)) {
      const key = cellKey(k.lat, k.lng);
      knownCount.set(key, (knownCount.get(key) ?? 0) + 1);
    }
  }
  // Same-cell evidence counts full; the surrounding ring counts 0.4× (farther ≈
  // weaker — and the discount keeps same-block adjacency the strongest signal
  // even after the frontier bonus below). Returns {score, center} so the
  // frontier test can tell "on the build edge" (ring evidence only) apart from
  // "inside a lit block".
  const neighborEvidence = (lat: number, lng: number): { score: number; center: number } => {
    const cy = Math.floor(lat / cellDeg), cx = Math.floor(lng / cellDeg);
    const center = knownCount.get(`${cy}:${cx}`) ?? 0;
    let ring = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dy === 0 && dx === 0) continue;
      ring += knownCount.get(`${cy + dy}:${cx + dx}`) ?? 0;
    }
    return { score: center + 0.4 * ring, center };
  };

  // Spread term: penalize picking many targets from the same cell so budget maps
  // the city rather than one block. We track how many we've already favored per
  // cell as we assign EV — but EV must be order-independent, so instead we bake a
  // deterministic within-cell rank: the Nth target in a cell gets a decaying
  // spread bonus. Group first.
  const byCell = new Map<string, number[]>(); // cell -> target indices
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.lat == null || t.lng == null) continue;
    const k = cellKey(t.lat, t.lng);
    const arr = byCell.get(k); if (arr) arr.push(i); else byCell.set(k, [i]);
  }
  const withinCellRank = new Array<number>(targets.length).fill(0);
  for (const idxs of byCell.values()) {
    // Stable order within a cell by id → deterministic.
    idxs.sort((a, b) => targets[a].id - targets[b].id);
    idxs.forEach((i, rank) => { withinCellRank[i] = rank; });
  }

  const scored: RankedTarget[] = targets.map((t, i) => {
    if (t.lat == null || t.lng == null) return { id: t.id, ev: 0, seq: 0 };

    // NOVELTY GATE — how much would checking this address actually TEACH us?
    // This gates everything: proximity to known fiber only matters if we don't
    // already know the answer. A freshly-verified address next to new-fiber has
    // near-zero value (we just checked it); a never-scanned one is fully novel;
    // a stale known-live one is novel again only when we're hunting for change.
    const everScanned = t.lastScannedAtMs != null;
    let novelty: number;
    if (!everScanned) novelty = 1;
    else if (rescan) {
      const days = nowMs > 0 ? (nowMs - t.lastScannedAtMs!) / 86_400_000 : 0;
      novelty = 0.3 + 0.7 * satur(days, 21); // staler = likelier to have flipped
    } else {
      novelty = 0.1; // re-checking a fresh address outside a rescan wastes budget
    }

    // Substance we'd gain IF we learn something: a base value plus the strongest
    // real predictor — GRADED proximity to known new-fiber (fiber builds
    // contiguously, so a neighbor of a live home is very likely live, and many
    // live neighbors are stronger evidence than one) — plus any field signal.
    const ev9 = neighborEvidence(t.lat, t.lng);
    let substance = 0.45;
    substance += 0.40 * satur(ev9.score, 1); // 1 same-cell neighbor ≈ +0.20, dense block → +0.36
    // FRONTIER BONUS — the build EDGE is where new fiber appears next. An address
    // whose own cell has no verified fiber but whose ring does sits exactly on
    // that edge: checking it maps where the build is heading, while an address
    // deep inside a lit block mostly re-confirms what the map already shows.
    // Sized below the ring discount so same-block adjacency still outranks the
    // edge at everyday densities (the crossover is ~12+ known points, where a
    // saturated block's interior genuinely is less informative than its edge).
    if (ev9.center === 0 && ev9.score > 0) substance += 0.04;
    if (typeof t.opportunityScore === "number") substance += 0.15 * clamp01(t.opportunityScore);
    // In a rescan, a known-live address is worth watching for churn.
    if (rescan && everScanned && t.lastIsNewFiber) substance += 0.05;

    // Spread: decays with within-cell rank so budget maps the city rather than
    // saturating one street. Also gated by novelty so it can't resurrect a
    // freshly-scanned block.
    const spread = 0.10 * Math.exp(-withinCellRank[i] / 3);

    const ev = novelty * (substance + spread);
    return { id: t.id, ev: round(clamp01(ev), 4), seq: 0 };
  });

  // Rank by EV desc; deterministic tie-break by id so a resumed run re-derives
  // the exact same order.
  scored.sort((a, b) => b.ev - a.ev || a.id - b.id);
  return scored.map((s, i) => ({ ...s, seq: i }));
}

function satur(v: number, k: number): number { return v <= 0 ? 0 : v / (v + k); }
function clamp01(n: number): number { return Math.max(0, Math.min(1, isFinite(n) ? n : 0)); }
function round(n: number, dp: number): number { const f = Math.pow(10, dp); return Math.round(n * f) / f; }
