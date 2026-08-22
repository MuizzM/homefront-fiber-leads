// ── Neighborhood sweep: the pure decisions ───────────────────────────────────
// The producer in server/neighborhoodSweep.ts gathers per-cell counts from
// scan_targets and hands them here. Everything that decides WHERE the next
// Kinetic check goes lives in this file so it can be unit-tested without a
// database: how a neighborhood cell is scored, whether it is probed, flooded,
// parked, or finished, which addresses make up a probe, in what order a flood
// runs, and how big a cycle may be.
//
// Evidence the rules rest on (2026-08-22, production-shaped copy, NC Kinetic):
//   * organic scans in a 0.01 degree cell that already held one NEW FIBER hit
//     came back NEW FIBER 22.5% of the time; in cells with no hit, 0.9% (25x);
//   * 264 of 403 hit streets were 100% NEW FIBER (streets are lit together);
//   * Charlotte and Statesville returned 0 live doors on 1,445 scans and hold
//     88k unscanned rows between them: sinks must be parked, not sampled.
//
// Vocabulary: a CELL is the existing ROUND(lat,2) x ROUND(lng,2) grid
// (~1.1 km x 0.9 km at NC latitude) that scan_targets already indexes.

export type CellPhase = "flood" | "probe" | "parked" | "complete";

export interface CellStats {
  cellLat: number;
  cellLng: number;
  city: string;
  state: string;
  /** Targets in the cell with a recorded provider answer. */
  scanned: number;
  /** Targets Kinetic flagged NEW FIBER (last_is_new_fiber=1). */
  hits: number;
  /** Targets with fiber available (new or tenured). */
  live: number;
  /** Never-scanned targets that are claimable (not parked as address_not_found). */
  unscanned: number;
  /** Negative verdicts old enough to be re-checked (flip watch). */
  staleNegatives: number;
  /** Hits that never became a lead (no converted_to_lead_id). */
  unlinkedGreens: number;
  /** Days since the most recent hit was scanned; null when the cell has none. */
  lastHitDays: number | null;
  /** Hits and scans summed over the 8 surrounding cells. */
  neighborHits: number;
  neighborScanned: number;
  /** Officially announced Kinetic build market (state_fiber_markets verified_expanding). */
  expanding: boolean;
  /** FCC-evidenced likely-2026 build addresses (kinetic_build_state) in the cell. */
  buildEvidence: number;
  /** Targets in COMING_SOON lifecycle. */
  comingSoon: number;
  /** Whether the cell's city is an auto_scan_eligible Kinetic market. */
  inFootprint: boolean;
  /** The cell was parked earlier and its park window has lapsed: one re-probe is due. */
  parkExpired?: boolean;
  /** City-level totals, for the empirical-Bayes prior and the city sink rule. */
  cityScanned: number;
  cityHits: number;
  cityLive: number;
}

export interface SweepPolicy {
  /** Empirical-Bayes prior strength: pseudo-scans at the prior rate. */
  priorScans: number;
  /** Tenant-wide NEW FIBER rate used when a city has too little evidence. */
  globalRate: number;
  /** A cell with this many scans and no live door is parked. */
  sinkCellMinScans: number;
  /** A city with this many scans below sinkCityMaxRate parks its cold cells. */
  sinkCityMinScans: number;
  sinkCityMaxRate: number;
  /** Addresses per cold-cell probe (one per street first). */
  probePerCell: number;
  /** Days a parked cell stays parked. */
  parkDays: number;
  /** Hits newer than this many days count as recent. */
  recentHitDays: number;
}

export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
  priorScans: 12,
  globalRate: 0.05,
  sinkCellMinScans: 15,
  sinkCityMinScans: 200,
  sinkCityMaxRate: 0.005,
  probePerCell: 12,
  parkDays: 45,
  recentHitDays: 30,
};

export interface CellDecision {
  phase: CellPhase;
  /** Ranking key: expected NEW FIBER hits per check, shaped by recency and work. */
  score: number;
  /** The raw expected hit rate before recency/work shaping (0..1). */
  expectedRate: number;
  /** Machine-readable reasons, stable strings for logs and the UI. */
  reasons: string[];
  parkedReason?: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Empirical-Bayes smoothed hit rate: observed hits blended with a prior. */
export function smoothedRate(hits: number, scanned: number, prior: number, priorScans: number): number {
  const a = Math.max(1, priorScans);
  return clamp01((hits + a * prior) / (scanned + a));
}

/**
 * Decide what the sweep should do with a cell and how urgently. Pure.
 *
 * Order of the rules matters:
 *   1. nothing to do -> complete (no unscanned, no due negatives, no greens);
 *   2. a cell that has produced a hit is flooded, always (the 25x rule), and
 *      ranked by its smoothed hit rate plus how recently it hit;
 *   3. a cell that has been probed enough with nothing live is parked, as is
 *      every cold cell in a proven sink city, unless official build evidence
 *      says otherwise;
 *   4. everything else is probed, ranked by the city prior, neighbor
 *      spillover, and official evidence.
 */
export function decideCell(c: CellStats, policy: SweepPolicy = DEFAULT_SWEEP_POLICY): CellDecision {
  const reasons: string[] = [];
  const work = c.unscanned + c.staleNegatives + c.unlinkedGreens;
  if (work <= 0) return { phase: "complete", score: 0, expectedRate: 0, reasons: ["no_work"] };

  const cityRate = smoothedRate(c.cityHits, c.cityScanned, policy.globalRate, policy.priorScans * 4);
  const hasEvidence = c.expanding || c.buildEvidence > 0 || c.comingSoon > 0;

  // Rule 2: a hit anywhere in the cell makes it a flood.
  if (c.hits > 0) {
    const own = smoothedRate(c.hits, c.scanned, cityRate, policy.priorScans);
    const spill = 0.5 * smoothedRate(c.neighborHits, c.neighborScanned, 0, policy.priorScans);
    const expectedRate = clamp01(own + spill);
    reasons.push("hit_in_cell");
    if (c.neighborHits > 0) reasons.push("neighbor_hits");
    const recency = c.lastHitDays != null && c.lastHitDays <= policy.recentHitDays ? 1.25
      : c.lastHitDays != null && c.lastHitDays <= policy.recentHitDays * 3 ? 1.0 : 0.85;
    if (recency > 1) reasons.push("recent_hit");
    if (c.unlinkedGreens > 0) reasons.push("unlinked_greens");
    return { phase: "flood", score: shape(expectedRate, recency, work), expectedRate, reasons };
  }

  // Rule 3: sinks. An expired park window earns exactly one re-probe: the
  // probe's answers then re-decide the cell (and re-park it for another
  // window if nothing changed), so a sink is re-verified every parkDays.
  const skipSinks = hasEvidence || !!c.parkExpired;
  if (c.parkExpired) reasons.push("park_expired");
  if (c.scanned >= policy.sinkCellMinScans && c.live === 0 && !skipSinks) {
    reasons.push("cell_no_fiber");
    return { phase: "parked", score: 0, expectedRate: 0, reasons, parkedReason: "cell_no_fiber" };
  }
  const citySink = c.cityScanned >= policy.sinkCityMinScans
    && c.cityHits / Math.max(1, c.cityScanned) < policy.sinkCityMaxRate
    && c.cityLive === 0;
  if (citySink && !skipSinks) {
    reasons.push("city_sink");
    return { phase: "parked", score: 0, expectedRate: 0, reasons, parkedReason: "city_sink" };
  }
  if (!c.inFootprint && !skipSinks) {
    reasons.push("outside_footprint");
    return { phase: "parked", score: 0, expectedRate: 0, reasons, parkedReason: "outside_footprint" };
  }

  // Rule 4: probe, ranked by prior + spillover + evidence.
  const prior = c.scanned > 0 ? smoothedRate(0, c.scanned, cityRate, policy.priorScans) : cityRate;
  const spill = 0.5 * smoothedRate(c.neighborHits, c.neighborScanned, 0, policy.priorScans);
  let evidence = 0;
  if (c.expanding) { evidence += 0.06; reasons.push("announced_build"); }
  if (c.buildEvidence > 0) { evidence += Math.min(0.1, 0.02 * c.buildEvidence); reasons.push("fcc_build_evidence"); }
  if (c.comingSoon > 0) { evidence += 0.08; reasons.push("coming_soon"); }
  if (c.neighborHits > 0) reasons.push("neighbor_hits");
  if (c.live > 0) reasons.push("tenured_fiber_present");
  const expectedRate = clamp01(prior + spill + evidence);
  reasons.push(c.scanned === 0 ? "cold" : "probed_no_hit");
  return { phase: "probe", score: shape(expectedRate, 1, work), expectedRate, reasons };
}

/** Expected rate shaped by recency and by how much work the cell offers: a
 *  cell with 300 doors outranks a cell with 3 at the same rate. The work
 *  factor spans [0.8, 1.0], so a better rate can only be overtaken by a
 *  bigger cell when the rates are within 25% of each other. */
export const WORK_FACTOR_MIN = 0.8;
function shape(expectedRate: number, recency: number, work: number): number {
  const workFactor = WORK_FACTOR_MIN + (1 - WORK_FACTOR_MIN) * Math.min(1, work / 100);
  return expectedRate * recency * workFactor;
}

export interface ProbeCandidate {
  id: number;
  streetKey: string;
  houseNumber: number | null;
}

/**
 * Pick a probe for a cold cell: one address per street first (largest streets
 * first, the middle house of each), then a second pass over the largest
 * streets. Streets are lit together, so one good answer per street is the
 * cheapest way to learn whether the neighborhood is worth flooding. Pure and
 * deterministic.
 */
export function selectProbe(candidates: ProbeCandidate[], size: number): number[] {
  if (size <= 0 || candidates.length === 0) return [];
  const byStreet = new Map<string, ProbeCandidate[]>();
  for (const c of candidates) {
    const key = c.streetKey || `__nostreet_${c.id}`;
    const arr = byStreet.get(key);
    if (arr) arr.push(c); else byStreet.set(key, [c]);
  }
  const streets = [...byStreet.values()].map((rows) => {
    rows.sort((a, b) => (a.houseNumber ?? Infinity) - (b.houseNumber ?? Infinity) || a.id - b.id);
    return rows;
  }).sort((a, b) => b.length - a.length || a[0].id - b[0].id);

  if (size >= candidates.length) return streets.flat().map((c) => c.id);
  const chosen: number[] = [];
  const taken = new Set<number>();
  // Pass 1: the middle house of every street, largest streets first.
  for (const rows of streets) {
    if (chosen.length >= size) break;
    const mid = rows[Math.floor(rows.length / 2)];
    chosen.push(mid.id); taken.add(mid.id);
  }
  // Pass 2+: walk the quartiles of the largest streets until the probe is full.
  const fractions = [0.25, 0.75, 0.1, 0.9, 0.5];
  for (const f of fractions) {
    if (chosen.length >= size) break;
    for (const rows of streets) {
      if (chosen.length >= size) break;
      const pick = rows[Math.min(rows.length - 1, Math.floor(rows.length * f))];
      if (!taken.has(pick.id)) { chosen.push(pick.id); taken.add(pick.id); }
    }
  }
  // Last pass: anything still unpicked, in street order.
  for (const rows of streets) for (const c of rows) {
    if (chosen.length >= size) return chosen;
    if (!taken.has(c.id)) { chosen.push(c.id); taken.add(c.id); }
  }
  return chosen;
}

/** Leading house number of an address, or null when it has none. */
export function houseNumberOf(address: string | null | undefined): number | null {
  const m = String(address ?? "").trim().match(/^(\d{1,6})/);
  return m ? Number(m[1]) : null;
}

/**
 * Flood order: street by street, house numbers ascending, so a rep who opens
 * the map while the run is half way sees whole streets finished rather than a
 * sprinkle. Pure.
 */
export function orderFlood<T extends { id: number; streetKey: string; houseNumber: number | null }>(rows: T[]): T[] {
  const street = (r: { streetKey: string }) => r.streetKey || null;
  return [...rows].sort((a, b) => {
    const sa = street(a), sb = street(b);
    if (sa !== sb) {
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sa < sb ? -1 : 1;
    }
    return ((a.houseNumber ?? Infinity) - (b.houseNumber ?? Infinity)) || a.id - b.id;
  });
}

export interface CycleBudgetInput {
  /** Provider checks completed per minute over the recent window. */
  drainPerMinute: number;
  intervalMinutes: number;
  /** Rows this producer already has queued or in flight. */
  pending: number;
  floor: number;
  cap: number;
  /** How far ahead of the measured drain to enqueue (1.5 = half a cycle spare). */
  oversubscribe: number;
}

export interface CycleBudget {
  budget: number;
  /** Set when the cycle should enqueue nothing. */
  skip?: "backlog_warm";
}

/**
 * Size a cycle to what the consumer can actually drain, so the queue stays
 * short and the ranking stays responsive: a probe hit must turn into a flood
 * on the next cycle, not after a day of stale backlog. Pure.
 */
export function cycleBudget(i: CycleBudgetInput): CycleBudget {
  const want = Math.round(Math.max(0, i.drainPerMinute) * Math.max(1, i.intervalMinutes) * Math.max(1, i.oversubscribe));
  const budget = Math.max(0, Math.min(i.cap, Math.max(i.floor, want)));
  if (i.pending >= budget * 2) return { budget: 0, skip: "backlog_warm" };
  return { budget: Math.max(0, budget - Math.max(0, i.pending)) };
}

/** Stable key for a cell, used in run ids and maps. */
export function cellKey(cellLat: number, cellLng: number): string {
  return `${Math.round(cellLat * 100)}_${Math.round(cellLng * 100)}`;
}

/** The eight neighbors of a cell on the ROUND(.,2) grid. */
export function neighborKeys(cellLat: number, cellLng: number): string[] {
  const la = Math.round(cellLat * 100), lo = Math.round(cellLng * 100);
  const out: string[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dy === 0 && dx === 0) continue;
    out.push(`${la + dy}_${lo + dx}`);
  }
  return out;
}
