// ── Which confirmed 2026 door does a rep knock first? ────────────────────────
//
// Pure and deterministic (nowMs injected), so the ordering can be pinned by
// tests rather than argued about. Deliberately separate from
// server/leadRanking.ts, which ranks the confirmed-fresh scanner output on
// signals this pipeline does not have (cluster yield, new-build radar) and
// lacks the ones it does (proven build quarter, verification decay).
//
// The weights are named so they read as sales decisions. Two are worth calling
// out because they are the ones people are surprised by:
//
//   VERIFICATION_FRESHNESS  A confirmed build we last checked in March is not
//     as good a door as one checked last week. Serviceability regresses -
//     someone else sells them, the address gets re-plumbed - and the decay
//     here is what keeps stale confirmations from sitting at the top of the
//     list forever.
//
//   OUTREACH_PENALTY  Previous outreach REDUCES rank rather than removing the
//     door. A no-answer yesterday is a bad door today and a fine door in three
//     weeks, so this is a decay, not a filter. A permanent block (do-not-knock)
//     is handled far upstream in classification, never here.

export interface BuildRankSignals {
  /** Classifier confidence in the serviceability verdict. */
  confidence: "high" | "medium" | "low" | "none";
  /** When this address FIRST classified as a confirmed 2026 build. */
  firstConfirmedAtMs?: number | null;
  /** Most recent conclusive verification of any kind. */
  lastVerifiedAtMs?: number | null;
  /** Confirmed 2026 builds within PROXIMITY_RADIUS_M, excluding this one. */
  nearbyConfirmedCount?: number;
  /** Contact data present on the linked lead. */
  hasPhone?: boolean;
  hasEmail?: boolean;
  hasOwnerName?: boolean;
  /** Knocks logged at this door. */
  knockCount?: number;
  /** Most recent knock, whatever the outcome. */
  lastKnockedAtMs?: number | null;
  /** A proven quarter is a stronger story at the door than an interval. */
  quarterProven?: boolean;
  /**
   * How hot the door's census block is, 0..1 - the share of its premises
   * Kinetic newly lit between the two most recent filings.
   *
   * This is the ONLY signal that discriminates between candidate doors. A
   * likely_2026 door has no confirmation date, no verification and no
   * confirmed neighbours, so every other term is zero and the list would be
   * arbitrary. Block build intensity is the real evidence we hold about it:
   * a block where Kinetic just lit 40% of the premises is a street crew
   * working right now, and the unserved remainder is where 2026 lands.
   */
  buildFrontStrength?: number;
  nowMs?: number;
}

export const BUILD_RANK_WEIGHTS = {
  /** Confidence in the serviceability verdict - the largest single term,
   *  because knocking a door that turns out not to be serviceable is the most
   *  expensive mistake in the whole workflow. */
  CONFIDENCE_MAX: 35,
  /** Recency of the 2026 confirmation. A build confirmed this week is a
   *  household that has not been pitched by anyone yet. */
  RECENCY_MAX: 25,
  /** Half-life of that recency bonus, in days. */
  RECENCY_HALF_LIFE_DAYS: 30,
  /** How recently we verified serviceability still holds. */
  FRESHNESS_MAX: 15,
  /** Confirmed neighbours - a lit street is a route, not a single stop. */
  PROXIMITY_MAX: 12,
  /** Neighbour count at which proximity saturates. */
  PROXIMITY_CAP: 8,
  /** Reachable households can be worked by phone as well as on foot. */
  CONTACT_MAX: 8,
  /** A provable quarter is a concrete opener at the door. */
  QUARTER_PROVEN_BONUS: 5,
  /** Share of the block Kinetic just lit. Sized to outweigh contact quality
   *  but stay under confirmation and recency: a hot block is the best reason
   *  to knock a CANDIDATE, and never a reason to outrank a confirmed build. */
  BUILD_FRONT_MAX: 18,
  /** Maximum subtracted for recent outreach. */
  OUTREACH_PENALTY_MAX: 20,
  /** Days after which a previous knock stops counting against the door. */
  OUTREACH_COOLDOWN_DAYS: 21,
} as const;

/** Radius for the "other confirmed builds nearby" signal, in metres. Matches
 *  server/leadRanking.ts DENSITY_RADIUS_M so two lists never disagree about
 *  what counts as the same street. */
export const PROXIMITY_RADIUS_M = 800;

const CONFIDENCE_FACTOR: Record<BuildRankSignals["confidence"], number> = {
  high: 1, medium: 0.6, low: 0.25, none: 0,
};

const DAY_MS = 86_400_000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export interface BuildRankResult {
  score: number;
  components: Record<string, number>;
  explanation: string[];
}

export function scoreBuildLead(signals: BuildRankSignals): BuildRankResult {
  const now = signals.nowMs ?? Date.now();
  const w = BUILD_RANK_WEIGHTS;
  const explanation: string[] = [];

  const confidence = w.CONFIDENCE_MAX * CONFIDENCE_FACTOR[signals.confidence];

  // Exponential decay, not a step: a 29-day-old confirmation should not
  // outrank a 31-day-old one by a cliff.
  let recency = 0;
  if (signals.firstConfirmedAtMs != null) {
    const ageDays = Math.max(0, (now - signals.firstConfirmedAtMs) / DAY_MS);
    recency = w.RECENCY_MAX * Math.pow(0.5, ageDays / w.RECENCY_HALF_LIFE_DAYS);
    if (ageDays <= 14) explanation.push("Confirmed within the last two weeks");
  }

  let freshness = 0;
  if (signals.lastVerifiedAtMs != null) {
    const ageDays = Math.max(0, (now - signals.lastVerifiedAtMs) / DAY_MS);
    freshness = ageDays <= 7 ? w.FRESHNESS_MAX
      : ageDays <= 30 ? w.FRESHNESS_MAX * 0.7
      : ageDays <= 90 ? w.FRESHNESS_MAX * 0.35
      : 0;
    if (ageDays > 90) explanation.push("Serviceability not re-verified in over 90 days");
  } else {
    explanation.push("Never verified");
  }

  const neighbours = Math.max(0, signals.nearbyConfirmedCount ?? 0);
  const proximity = w.PROXIMITY_MAX * clamp01(neighbours / w.PROXIMITY_CAP);
  if (neighbours >= w.PROXIMITY_CAP) explanation.push(`${neighbours} confirmed builds within ${PROXIMITY_RADIUS_M}m`);

  // Contact channels are additive but capped: a phone number is most of the
  // value, and a third channel adds little.
  const channels = (signals.hasPhone ? 2 : 0) + (signals.hasEmail ? 1 : 0) + (signals.hasOwnerName ? 1 : 0);
  const contact = w.CONTACT_MAX * clamp01(channels / 4);

  const quarter = signals.quarterProven ? w.QUARTER_PROVEN_BONUS : 0;

  const buildFront = w.BUILD_FRONT_MAX * clamp01(signals.buildFrontStrength ?? 0);
  if ((signals.buildFrontStrength ?? 0) >= 0.25) {
    explanation.push(`Kinetic newly lit ${Math.round((signals.buildFrontStrength ?? 0) * 100)}% of this block`);
  }

  // Outreach decays back to zero over the cooldown, so a door worked three
  // weeks ago competes on its merits again.
  let outreach = 0;
  const knocks = Math.max(0, signals.knockCount ?? 0);
  if (knocks > 0) {
    const sinceDays = signals.lastKnockedAtMs == null
      ? w.OUTREACH_COOLDOWN_DAYS
      : Math.max(0, (now - signals.lastKnockedAtMs) / DAY_MS);
    const remaining = clamp01(1 - sinceDays / w.OUTREACH_COOLDOWN_DAYS);
    outreach = -w.OUTREACH_PENALTY_MAX * remaining * clamp01(knocks / 3);
    if (outreach < 0) explanation.push(`Knocked ${knocks} time${knocks === 1 ? "" : "s"} recently`);
  }

  const components = { confidence, recency, freshness, proximity, contact, quarter, buildFront, outreach };
  const raw = Object.values(components).reduce((a, b) => a + b, 0);
  return {
    score: Math.max(0, Math.round(raw)),
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    explanation,
  };
}

export interface RankableBuild extends BuildRankSignals {
  id: number;
  lat?: number | null;
  lng?: number | null;
}

/**
 * Rank a pool, highest first. Ties break on id so the order is stable across
 * requests - a list that reshuffles between refreshes is one reps stop
 * trusting.
 */
export function rankBuilds<T extends RankableBuild>(pool: readonly T[], nowMs?: number): Array<T & { score: number; explanation: string[] }> {
  return pool
    .map((item) => {
      const { score, explanation } = scoreBuildLead({ ...item, nowMs: nowMs ?? item.nowMs });
      return { ...item, score, explanation };
    })
    .sort((a, b) => (b.score - a.score) || (a.id - b.id));
}

// ── Territory grouping ───────────────────────────────────────────────────────

export interface GroupableDoor {
  id: number;
  lat: number;
  lng: number;
}

export interface DoorCluster {
  doors: number[];
  centroid: { lat: number; lng: number };
  /** Longest distance from the centroid to a member, in metres. */
  radiusM: number;
}

/** Metres per degree of latitude. Longitude is scaled by cos(lat) at the
 *  working latitude - across a single county that approximation is well under
 *  a metre of error, and it avoids a trig call per pair. */
const M_PER_DEG_LAT = 111_320;

export function haversineApproxM(a: GroupableDoor, b: GroupableDoor): number {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (a.lat - b.lat) * M_PER_DEG_LAT;
  const dLng = (a.lng - b.lng) * M_PER_DEG_LAT * Math.cos(midLat);
  return Math.hypot(dLat, dLng);
}

/**
 * Group doors into compact, walkable territories.
 *
 * Greedy nearest-neighbour growth from the densest unassigned door: pick a
 * seed, absorb the closest doors until the cluster hits maxDoors or the next
 * candidate is further than maxRadiusM, repeat. Deliberately not k-means -
 * k-means optimises for equal variance and happily produces a cluster
 * straddling a river with nothing in between, whereas a field territory has to
 * be a set of doors a person can actually walk between in a shift.
 *
 * Deterministic: seeds are chosen by neighbour count then id, so the same
 * input always produces the same territories.
 */
export function groupIntoTerritories(
  doors: readonly GroupableDoor[],
  opts: { maxDoors?: number; maxRadiusM?: number } = {},
): DoorCluster[] {
  const maxDoors = Math.max(1, opts.maxDoors ?? 120);
  const maxRadiusM = Math.max(50, opts.maxRadiusM ?? 1_200);
  const remaining = new Map(doors.map((d) => [d.id, d]));
  const clusters: DoorCluster[] = [];

  // Neighbour counts drive seed choice so growth starts in the dense core of a
  // subdivision rather than at an outlying door that would drag the radius out.
  const neighbourCount = new Map<number, number>();
  for (const door of doors) {
    let n = 0;
    for (const other of doors) {
      if (other.id !== door.id && haversineApproxM(door, other) <= maxRadiusM) n++;
    }
    neighbourCount.set(door.id, n);
  }

  while (remaining.size) {
    const seed = [...remaining.values()].sort(
      (a, b) => (neighbourCount.get(b.id)! - neighbourCount.get(a.id)!) || (a.id - b.id),
    )[0];
    remaining.delete(seed.id);

    const members: GroupableDoor[] = [seed];
    let sumLat = seed.lat, sumLng = seed.lng;

    while (members.length < maxDoors && remaining.size) {
      const centroid = { id: -1, lat: sumLat / members.length, lng: sumLng / members.length };
      let best: GroupableDoor | null = null;
      let bestDistance = Infinity;
      for (const candidate of remaining.values()) {
        const distance = haversineApproxM(centroid, candidate);
        if (distance < bestDistance || (distance === bestDistance && best && candidate.id < best.id)) {
          best = candidate; bestDistance = distance;
        }
      }
      if (!best || bestDistance > maxRadiusM) break;
      remaining.delete(best.id);
      members.push(best);
      sumLat += best.lat; sumLng += best.lng;
    }

    const centroid = { lat: sumLat / members.length, lng: sumLng / members.length };
    const radiusM = members.reduce(
      (max, m) => Math.max(max, haversineApproxM({ id: -1, ...centroid }, m)), 0,
    );
    clusters.push({
      doors: members.map((m) => m.id).sort((a, b) => a - b),
      centroid: { lat: Math.round(centroid.lat * 1e6) / 1e6, lng: Math.round(centroid.lng * 1e6) / 1e6 },
      radiusM: Math.round(radiusM),
    });
  }
  return clusters;
}

/**
 * Order one territory's doors into a walking route: nearest-neighbour from the
 * door closest to the centroid, which for a residential street grid lands
 * within a few percent of optimal and costs O(n^2) instead of being NP-hard.
 */
export function routeOrder(doors: readonly GroupableDoor[]): number[] {
  if (doors.length <= 2) return doors.map((d) => d.id);
  const centroid = {
    id: -1,
    lat: doors.reduce((s, d) => s + d.lat, 0) / doors.length,
    lng: doors.reduce((s, d) => s + d.lng, 0) / doors.length,
  };
  const remaining = new Map(doors.map((d) => [d.id, d]));
  let current = [...remaining.values()].sort(
    (a, b) => (haversineApproxM(centroid, a) - haversineApproxM(centroid, b)) || (a.id - b.id),
  )[0];
  remaining.delete(current.id);

  const order = [current.id];
  while (remaining.size) {
    let best: GroupableDoor | null = null;
    let bestDistance = Infinity;
    for (const candidate of remaining.values()) {
      const distance = haversineApproxM(current, candidate);
      if (distance < bestDistance || (distance === bestDistance && best && candidate.id < best.id)) {
        best = candidate; bestDistance = distance;
      }
    }
    current = best!;
    remaining.delete(current.id);
    order.push(current.id);
  }
  return order;
}
