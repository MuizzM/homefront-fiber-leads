// ── Market intelligence — turn accumulated data into a "where to launch" score ─
// A market (a city we've harvested addresses for) becomes an opportunity card.
// Pure functions over aggregates the server computes from the pool + leads +
// knocks + field outcomes. No DB, no proxy — every number is explainable and the
// scoring is unit-tested. The goal: a manager compares markets and knows where
// to send people, and WHY, without reading a spreadsheet.

export interface MarketAggregate {
  city: string;
  state: string;
  poolSize: number;          // harvested addresses we could verify
  verified: number;          // addresses ever Kinetic-checked (pool.scan_count>0)
  verifiedNewFiber: number;  // verified NEW FIBER + billing N (real opportunity)
  newlyLive: number;         // provable unavailable->live flips (freshest signal)
  leads: number;             // leads on the board in this city
  unworkedLeads: number;     // leads with zero knocks (opportunity still on the table)
  workedLeads: number;       // leads with >=1 knock
  soldLeads: number;         // converted
  lastVerifiedAtMs: number | null; // freshness of our knowledge (epoch ms)
  // Field-outcome memory (the learning loop). null = never deployed here.
  outcome?: {
    knocks: number;
    contacts: number;
    sales: number;
    lastDeployedAtMs: number | null;
  } | null;
}

export interface MarketCard extends MarketAggregate {
  // Derived, all in [0,1] unless noted.
  coverage: number;          // verified / poolSize — how much we actually know
  saturation: number;        // workedLeads / max(leads,1) — how worked-over it is
  freshnessDays: number | null; // days since last verification (null = never)
  estRemainingOpportunity: number; // projected unworked new-fiber still to find
  contactRate: number | null;      // field: contacts/knocks (null if no history)
  conversionRate: number | null;   // field: sales/knocks (null if no history)
  priority: number;          // 0..100 — the headline "go here next" score
  priorityBand: "hot" | "warm" | "cool" | "cold";
  confidence: "high" | "medium" | "low"; // how much evidence backs the score
  reasons: string[];         // human explanation of the score (top drivers)
}

const DAY_MS = 86_400_000;

// Score a market. Higher = deploy here sooner. The score blends five forces:
//   opportunity   — verified/known new-fiber still unworked (the substance)
//   freshness     — recently verified (or newly-live) beats stale knowledge
//   headroom      — low saturation; lots of doors nobody has knocked
//   proven demand — field history that converted (the learning signal)
//   discoverability — a big unverified pool means cheap upside if we look
// Each force is bounded and explainable; nothing is a black box.
export function scoreMarket(m: MarketAggregate, nowMs: number): MarketCard {
  const poolSize = Math.max(0, m.poolSize);
  const coverage = poolSize > 0 ? clamp01(m.verified / poolSize) : 0;
  const saturation = m.leads > 0 ? clamp01(m.workedLeads / m.leads) : 0;
  const freshnessDays = m.lastVerifiedAtMs != null
    ? Math.max(0, (nowMs - m.lastVerifiedAtMs) / DAY_MS)
    : null;

  // Estimate opportunity STILL on the table. Verified new-fiber that is unworked
  // is real. On top of that, the unverified pool likely hides more at the rate
  // we've observed so far (verifiedNewFiber / verified), discounted because we
  // haven't paid to confirm it. If we've verified nothing, we can't project a
  // rate, so unknown pool contributes only via the discoverability force below.
  const unworkedNewFiber = Math.max(0, m.verifiedNewFiber - approxWorked(m));
  const observedHitRate = m.verified > 0 ? m.verifiedNewFiber / m.verified : 0;
  const unverified = Math.max(0, poolSize - m.verified);
  const projectedHidden = observedHitRate * unverified * 0.5; // 50% haircut for uncertainty
  const estRemainingOpportunity = Math.round(unworkedNewFiber + projectedHidden);

  const reasons: string[] = [];

  // ── Force 1: opportunity substance (0..40) ──────────────────────────────────
  // Log-scaled so a market with 200 unworked new-fiber isn't 10x a market with
  // 20 — diminishing returns match how a team can only work so many doors.
  const opportunity = 40 * satur(estRemainingOpportunity, 120);
  if (estRemainingOpportunity > 0) {
    reasons.push(`${estRemainingOpportunity} est. unworked new-fiber ${m.verified > 0 ? "opportunities" : "(projected — unverified)"}`);
  }

  // ── Force 2: freshness (0..22) ──────────────────────────────────────────────
  // Newly-live flips are the money event — they dominate. Otherwise, recent
  // verification decays over ~21 days (fiber markets saturate on that scale).
  let freshness = 0;
  if (m.newlyLive > 0) {
    freshness = 22;
    reasons.push(`${m.newlyLive} address${m.newlyLive === 1 ? "" : "es"} just went live`);
  } else if (freshnessDays != null) {
    freshness = 18 * Math.exp(-freshnessDays / 21);
    if (freshnessDays <= 2) reasons.push("verified in the last 48h");
    else if (freshnessDays > 21) reasons.push(`knowledge is ${Math.round(freshnessDays)}d stale — re-verify`);
  } else {
    reasons.push("never verified — a scan would reveal it");
  }

  // ── Force 3: headroom / low saturation (0..18) ──────────────────────────────
  const headroom = 18 * (1 - saturation);
  if (saturation >= 0.6) reasons.push(`${Math.round(saturation * 100)}% worked — saturating`);
  else if (m.leads > 0 && saturation <= 0.15) reasons.push("barely touched");

  // ── Force 4: proven demand from the field (−6..+14) ─────────────────────────
  // The learning loop. A market that converted well earns a boost; one we worked
  // hard with nothing to show gets a penalty (stop sending people there).
  let proven = 0;
  const oc = m.outcome;
  const conversionRate = oc && oc.knocks > 0 ? oc.sales / oc.knocks : null;
  const contactRate = oc && oc.knocks > 0 ? oc.contacts / oc.knocks : null;
  if (oc && oc.knocks >= 20) {
    if (conversionRate! >= 0.12) { proven = 14; reasons.push(`proven: ${(conversionRate! * 100).toFixed(0)}% sold-per-knock in the field`); }
    else if (conversionRate! >= 0.05) { proven = 7; reasons.push(`converts: ${(conversionRate! * 100).toFixed(0)}% sold-per-knock`); }
    else if (conversionRate! < 0.02) { proven = -6; reasons.push("worked hard, low conversion — deprioritized"); }
  }

  // ── Force 5: discoverability of an unknown pool (0..12) ─────────────────────
  // A large pool we've barely verified is cheap upside — worth a look even with
  // no confirmed opportunity yet. Fades as coverage rises.
  const discover = 12 * (1 - coverage) * satur(unverified, 2_000);
  if (coverage < 0.05 && unverified > 500) reasons.push(`${unverified.toLocaleString()} addresses never checked`);

  const priority = clamp(0, 100, opportunity + freshness + headroom + proven + discover);

  // Confidence = how much evidence backs this. Verified checks and field knocks
  // both count; a card built on 5 checks and 0 knocks is a guess.
  const evidence = m.verified + (oc?.knocks ?? 0) * 3;
  const confidence: MarketCard["confidence"] =
    evidence >= 400 ? "high" : evidence >= 60 ? "medium" : "low";

  const priorityBand: MarketCard["priorityBand"] =
    priority >= 65 ? "hot" : priority >= 40 ? "warm" : priority >= 20 ? "cool" : "cold";

  return {
    ...m,
    coverage: round(coverage, 3),
    saturation: round(saturation, 3),
    freshnessDays: freshnessDays == null ? null : round(freshnessDays, 1),
    estRemainingOpportunity,
    contactRate: contactRate == null ? null : round(contactRate, 3),
    conversionRate: conversionRate == null ? null : round(conversionRate, 3),
    priority: Math.round(priority),
    priorityBand,
    confidence,
    reasons: reasons.slice(0, 4),
  };
}

// A crude "already worked" count for verified new-fiber: we don't track which
// verified target became which worked lead, so approximate worked new-fiber by
// the market's worked-lead share of its leads applied to verified new-fiber.
function approxWorked(m: MarketAggregate): number {
  if (m.leads <= 0) return 0;
  const workedShare = clamp01(m.workedLeads / m.leads);
  return Math.round(m.verifiedNewFiber * workedShare);
}

// Saturating curve: value/(value+k) → 0..1, hits 0.5 at k. Diminishing returns.
function satur(value: number, k: number): number {
  if (value <= 0) return 0;
  return value / (value + k);
}
function clamp01(n: number): number { return clamp(0, 1, n); }
function clamp(lo: number, hi: number, n: number): number { return Math.max(lo, Math.min(hi, isFinite(n) ? n : lo)); }
function round(n: number, dp: number): number { const f = Math.pow(10, dp); return Math.round(n * f) / f; }
