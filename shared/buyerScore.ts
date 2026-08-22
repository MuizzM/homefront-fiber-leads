// ── Buyer score: will this household buy when we knock? ──────────────────────
// PURE and framework-free (like shared/doorPriority.ts). The single place that
// turns the facts the app already holds about a door into one number a rep can
// read at a glance, plus the sentences that explain it.
//
// It sits beside two older numbers and does not replace them:
//   - leads.lead_score (server/lead-scoring.ts, 0-100) answers "is fresh fiber
//     here" from the Kinetic scan;
//   - the Opportunity rank (server/leadRanking.ts) answers "how fresh" for the
//     confirmed-fresh pool that Today routes by.
// Both become INPUTS here (the fiber signal below reads the same segment and
// billing facts the lead score does, and the fresh stamp the ranker decays).
//
// THE MODEL IS A SUM WITH CAPS, ON PURPOSE. Every door starts at BASE. Each
// signal adds or subtracts at most its cap, and the reasons list carries the
// exact contributions, so the number is defensible to a rep who asks "why 8.4"
// and to a manager who asks "why not". A fitted model can replace the weights
// later without changing the contract: score, tier, reasons.
//
// Scale: 1.0 to 10.0, one decimal. Tiers: Likely 8.0 and up, Possible 5.0 to
// 7.9, Unlikely under 5. A door that is closed (sold, not interested and its
// disambiguations) or blocked (do not knock) gets NO score: it is removed from
// scoring rather than ranked low, so it can never be promoted by the number.
//
// Non-finite and negative inputs collapse to "unknown" rather than throwing. A
// wire payload is not a trusted number.

import { isActiveBilling } from "./billingStatus";

export const BUYER_BASE = 5.0;
export const BUYER_MIN = 1.0;
export const BUYER_MAX = 10.0;

/** The most each signal may add (positive caps) or remove (negative floors). */
export const BUYER_CAPS = {
  /** Kinetic serviceability: fresh fiber with nobody signed up is the crown jewel. */
  FIBER_MAX: 2.0,
  /** Bonus inside the fiber cap when the door was field-verified fresh recently. */
  FIBER_FRESH_BONUS: 0.4,
  FIBER_FRESH_DAYS: 90,
  /** No fiber to sell yet (copper, no service). */
  FIBER_NONE: -1.5,
  /** Owner-occupied and settled: parcel enrichment (is_homeowner, years_at_address). */
  HOMEOWNER_MAX: 1.2,
  /** Renter likely (is_homeowner explicitly false). */
  RENTER: -0.8,
  /** Current provider is cable, DSL, wireless or satellite: a switch motive. */
  COMPETITOR_MAX: 0.8,
  /** Current provider is already fiber. */
  COMPETITOR_FIBER: -0.4,
  /** Sold doors within NEIGHBOR_RADIUS_M in the last NEIGHBOR_DAYS. */
  NEIGHBOR_EACH: 0.5,
  NEIGHBOR_MAX: 1.0,
  /** Knock history at this door. */
  INTERESTED: 1.0,
  FOLLOW_UP: 0.8,
  NOT_HOME_EACH: -0.3,
  NOT_HOME_FLOOR: -0.9,
} as const;

export const NEIGHBOR_RADIUS_M = 150;
export const NEIGHBOR_DAYS = 90;

export type BuyerTier = "likely" | "possible" | "unlikely" | "none";

export const BUYER_TIER_LABEL: Record<BuyerTier, string> = {
  likely: "Likely",
  possible: "Possible",
  unlikely: "Unlikely",
  none: "No score yet",
};

export function buyerTier(score: number | null | undefined): BuyerTier {
  if (score == null || !Number.isFinite(score)) return "none";
  if (score >= 8) return "likely";
  if (score >= 5) return "possible";
  return "unlikely";
}

/** One line of the "why" list. `delta` is signed and already capped. */
export interface BuyerScoreReason {
  key: string;
  label: string;
  delta: number;
}

export interface BuyerKnockSummary {
  /** Non-superseded knocks with outcome not_home. */
  notHome: number;
  /** Any non-superseded knock with outcome interested. */
  interested: number;
  /** callback or go_back knocks. */
  followUp: number;
  total: number;
}

export interface BuyerScoreInput {
  leadStatus: string;
  lastOutcome?: string | null;
  doNotKnock?: boolean | number | null;
  householdSegmentType?: string | null;
  billingStatus?: string | null;
  fiberStatus?: string | null;
  isNewFiber?: boolean | number | null;
  techType?: string | null;
  maxDownloadMbps?: number | null;
  freshConfirmedAt?: string | null;
  competitorName?: string | null;
  competitorTech?: string | null;
  isHomeowner?: boolean | number | null;
  yearsAtAddress?: number | null;
  knocks?: BuyerKnockSummary | null;
  /** Sold doors within NEIGHBOR_RADIUS_M in the same tenant, last NEIGHBOR_DAYS. */
  neighborSales?: number | null;
  /** Injected clock (ms) so the fresh-fiber window is testable. */
  nowMs: number;
}

export interface BuyerScoreResult {
  /** null when the door is removed from scoring (see `excluded`). */
  score: number | null;
  tier: BuyerTier;
  reasons: BuyerScoreReason[];
  /** Why there is no score, for the detail page and the job log. */
  excluded?: "do_not_knock" | "closed";
}

const CLOSED_STATUSES = new Set(["sold", "not_interested"]);

function truthy(v: boolean | number | null | undefined): boolean {
  return v === true || (typeof v === "number" && v !== 0);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clampCap(delta: number, cap: number): number {
  // A positive cap bounds from above; a negative cap bounds from below.
  return cap >= 0 ? Math.min(delta, cap) : Math.max(delta, cap);
}

function fiberSignal(input: BuyerScoreInput): BuyerScoreReason | null {
  const seg = String(input.householdSegmentType ?? "").trim().toUpperCase();
  const billing = String(input.billingStatus ?? "").trim().toUpperCase();
  const noSubscriber = billing === "N";
  const active = isActiveBilling(billing);
  const status = String(input.fiberStatus ?? "").toLowerCase();
  const mbps = typeof input.maxDownloadMbps === "number" && Number.isFinite(input.maxDownloadMbps) ? input.maxDownloadMbps : 0;
  const fiberHere = seg === "NEW FIBER" || seg === "TENURED" || truthy(input.isNewFiber)
    || status === "new_fiber" || status === "fiber" || status === "available"
    || String(input.techType ?? "").toUpperCase() === "FIBER" || mbps >= 300;
  const noFiber = status === "copper" || status === "no_service";

  let delta = 0;
  let label = "";
  if (seg === "NEW FIBER" && noSubscriber) { delta = 1.6; label = "Fresh fiber here, no subscriber yet"; }
  else if (seg === "NEW FIBER" && active) { delta = 0.6; label = "Fresh fiber here, a subscriber already"; }
  else if (seg === "TENURED" && noSubscriber) { delta = 1.0; label = "Fiber here for a while, nobody signed up"; }
  else if (seg === "TENURED" && active) { delta = -1.0; label = "Already on Kinetic fiber"; }
  else if (noFiber && !fiberHere) { delta = BUYER_CAPS.FIBER_NONE; label = "No fiber to sell here yet"; }
  else if (fiberHere) { delta = 0.6; label = "Fiber available"; }
  else return null;

  if (delta > 0 && input.freshConfirmedAt) {
    const t = Date.parse(input.freshConfirmedAt);
    if (Number.isFinite(t) && input.nowMs - t <= BUYER_CAPS.FIBER_FRESH_DAYS * 86_400_000 && input.nowMs - t >= 0) {
      delta += BUYER_CAPS.FIBER_FRESH_BONUS;
      label += ", verified lit recently";
    }
  }
  delta = delta > 0 ? clampCap(delta, BUYER_CAPS.FIBER_MAX) : Math.max(delta, BUYER_CAPS.FIBER_NONE);
  return { key: "fiber", label, delta: round1(delta) };
}

function homeownerSignal(input: BuyerScoreInput): BuyerScoreReason | null {
  const owner = input.isHomeowner;
  const years = typeof input.yearsAtAddress === "number" && Number.isFinite(input.yearsAtAddress) && input.yearsAtAddress >= 0
    ? Math.floor(input.yearsAtAddress) : null;
  if (owner === false || owner === 0) {
    return { key: "homeowner", label: "Renter likely", delta: BUYER_CAPS.RENTER };
  }
  if (!truthy(owner) && years == null) return null;
  let delta = 0;
  const parts: string[] = [];
  if (truthy(owner)) { delta += 0.6; parts.push("Homeowner"); }
  if (years != null) {
    if (years >= 3) { delta += 0.6; parts.push(`${years} yrs at this address`); }
    else if (years >= 1) { delta += 0.3; parts.push(`${years} yr${years === 1 ? "" : "s"} at this address`); }
    else { parts.push("Moved in this year"); }
  }
  if (delta === 0) return null;
  return { key: "homeowner", label: parts.join(", "), delta: round1(clampCap(delta, BUYER_CAPS.HOMEOWNER_MAX)) };
}

function competitorSignal(input: BuyerScoreInput): BuyerScoreReason | null {
  const name = String(input.competitorName ?? "").trim();
  const tech = String(input.competitorTech ?? "").trim().toLowerCase();
  if (!name && !tech) return null;
  const who = name || "a competitor";
  if (/fiber|ftt/.test(tech)) {
    return { key: "competitor", label: `On ${who} fiber today`, delta: BUYER_CAPS.COMPETITOR_FIBER };
  }
  if (/cable|coax|dsl|wireless|satellite|copper|fixed/.test(tech)) {
    const what = /cable|coax/.test(tech) ? "cable" : /dsl|copper/.test(tech) ? "DSL" : /satellite/.test(tech) ? "satellite" : "fixed wireless";
    return { key: "competitor", label: `On ${who} ${what} today`, delta: BUYER_CAPS.COMPETITOR_MAX };
  }
  return { key: "competitor", label: `On ${who} today`, delta: 0.3 };
}

function neighborSignal(input: BuyerScoreInput): BuyerScoreReason | null {
  const n = typeof input.neighborSales === "number" && Number.isFinite(input.neighborSales) ? Math.floor(input.neighborSales) : 0;
  if (n <= 0) return null;
  const delta = clampCap(n * BUYER_CAPS.NEIGHBOR_EACH, BUYER_CAPS.NEIGHBOR_MAX);
  const label = n === 1 ? `A neighbor bought in the last ${NEIGHBOR_DAYS} days` : `${n} neighbors bought in the last ${NEIGHBOR_DAYS} days`;
  return { key: "neighbors", label, delta: round1(delta) };
}

function knockSignals(input: BuyerScoreInput): BuyerScoreReason[] {
  const out: BuyerScoreReason[] = [];
  const k = input.knocks;
  const last = String(input.lastOutcome ?? "");
  const interested = (k?.interested ?? 0) > 0 || last === "interested" || input.leadStatus === "interested";
  const followUp = (k?.followUp ?? 0) > 0 || last === "callback" || last === "go_back" || input.leadStatus === "follow_up";
  if (interested) out.push({ key: "interested", label: "Said they were interested", delta: BUYER_CAPS.INTERESTED });
  else if (followUp) out.push({ key: "follow_up", label: "Asked us to come back", delta: BUYER_CAPS.FOLLOW_UP });
  const notHome = Math.max(0, Math.floor(k?.notHome ?? 0));
  if (notHome > 0) {
    const delta = clampCap(notHome * BUYER_CAPS.NOT_HOME_EACH, BUYER_CAPS.NOT_HOME_FLOOR);
    out.push({ key: "not_home", label: notHome === 1 ? "Knocked once, nobody home" : `Knocked ${notHome} times, nobody home`, delta: round1(delta) });
  }
  return out;
}

/**
 * Score one door. Deterministic for a given input and clock.
 *
 * The returned reasons always start with the base line so the list on the
 * detail page adds up to the score in front of the rep.
 */
export function scoreBuyer(input: BuyerScoreInput): BuyerScoreResult {
  if (truthy(input.doNotKnock)) return { score: null, tier: "none", reasons: [], excluded: "do_not_knock" };
  if (CLOSED_STATUSES.has(String(input.leadStatus ?? ""))) return { score: null, tier: "none", reasons: [], excluded: "closed" };

  const reasons: BuyerScoreReason[] = [{ key: "base", label: "Every door starts here", delta: BUYER_BASE }];
  const fiber = fiberSignal(input); if (fiber) reasons.push(fiber);
  const home = homeownerSignal(input); if (home) reasons.push(home);
  const comp = competitorSignal(input); if (comp) reasons.push(comp);
  const nb = neighborSignal(input); if (nb) reasons.push(nb);
  reasons.push(...knockSignals(input));

  const raw = reasons.reduce((sum, r) => sum + r.delta, 0);
  const score = round1(Math.min(BUYER_MAX, Math.max(BUYER_MIN, raw)));
  return { score, tier: buyerTier(score), reasons };
}

/** Parse the persisted reasons JSON defensively (a wire string is not trusted). */
export function parseBuyerReasons(raw: unknown): BuyerScoreReason[] {
  if (Array.isArray(raw)) return raw.filter(isReason);
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isReason) : [];
  } catch {
    return [];
  }
}

function isReason(r: unknown): r is BuyerScoreReason {
  return !!r && typeof r === "object"
    && typeof (r as BuyerScoreReason).key === "string"
    && typeof (r as BuyerScoreReason).label === "string"
    && typeof (r as BuyerScoreReason).delta === "number" && Number.isFinite((r as BuyerScoreReason).delta);
}

/** "+1.6" / "-0.5" / "5.0" with an ASCII hyphen, never a minus glyph. */
export function formatDelta(delta: number, { signed = true } = {}): string {
  const abs = Math.abs(delta).toFixed(1);
  if (!signed) return abs;
  return delta < 0 ? `-${abs}` : `+${abs}`;
}
