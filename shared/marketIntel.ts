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
  lastVerifiedAtMs: number | null; // freshness of pool verification (epoch ms)
  lastLeadAtMs?: number | null;    // most recent new-fiber lead created (epoch ms)
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

// Score a market. Higher = deploy here sooner. The score blends five forces,
// and the SUBSTANCE is real doors — the new-fiber leads already on the board.
//   opportunity   — unworked new-fiber DOORS on the board + projected hidden
//   freshness     — recently verified / newly-live, but only if opportunity exists
//   headroom      — low saturation, only meaningful when there ARE doors
//   proven demand — field history that converted (the learning signal)
//   discoverability — an unexplored pool is cheap upside, but never outranks doors
// Each force is bounded and explainable; nothing is a black box.
export function scoreMarket(m: MarketAggregate, nowMs: number): MarketCard {
  const poolSize = Math.max(0, m.poolSize);
  const saturation = m.leads > 0 ? clamp01(m.workedLeads / m.leads) : 0;

  // "Known" = we have real doors on the board OR we've paid to verify the pool.
  // A city with 1,063 new-fiber leads is NOT "never verified" — those leads came
  // from real provider checks. So coverage and freshness must count both.
  const known = m.leads > 0 || m.verified > 0;
  const coverage = poolSize > 0 ? clamp01((m.verified + m.leads) / poolSize) : (m.leads > 0 ? 1 : 0);

  // Freshness clock: the more recent of pool-verification and lead-creation.
  const lastKnownMs = maxNullable(m.lastVerifiedAtMs, m.lastLeadAtMs ?? null);
  const freshnessDays = lastKnownMs != null ? Math.max(0, (nowMs - lastKnownMs) / DAY_MS) : null;

  // ── THE SUBSTANCE: unworked new-fiber doors already verified + on the board ──
  // Leads in this product are all provider-verified new fiber; an UNWORKED lead
  // is a real, assignable, still-on-the-table opportunity. That is the number
  // the whole product exists to surface. On top of the confirmed doors, the
  // still-unverified pool likely hides more — at the rate we've observed if we
  // have one, otherwise a conservative prior — heavily discounted for being
  // unconfirmed so it never outranks a door we can actually knock today.
  const confirmedUnworked = Math.max(0, m.unworkedLeads);
  const unverified = Math.max(0, poolSize - m.verified);
  // Project hidden fiber ONLY over pool addresses we haven't already resolved —
  // subtracting the leads (which came from the pool) so we never double-count a
  // door we already found as also "hidden". The rate is what we've observed, or
  // (before any pool scan) the share of the pool that already became leads.
  const unresolvedPool = Math.max(0, unverified - m.leads);
  const observedHitRate = m.verified > 0 ? m.verifiedNewFiber / m.verified
    : (m.leads > 0 && poolSize > 0 ? clamp01(m.leads / poolSize) : 0);
  const projectedHidden = Math.round(observedHitRate * unresolvedPool * 0.4); // 60% haircut
  const estRemainingOpportunity = confirmedUnworked + projectedHidden;

  const reasons: string[] = [];

  // ── Force 1: opportunity substance (0..50) — the dominant force ─────────────
  const opportunity = 50 * satur(confirmedUnworked + projectedHidden * 0.5, 150);
  if (confirmedUnworked > 0) {
    reasons.push(`${confirmedUnworked.toLocaleString()} unworked new-fiber door${confirmedUnworked === 1 ? "" : "s"} on the board`);
  }

  // ── Force 2: freshness (0..18) — gated on opportunity existing ──────────────
  // A market with no opportunity gets NO freshness credit just for being
  // recently scanned (that fixed the "scanning an empty market raises it" bug).
  let freshness = 0;
  if (estRemainingOpportunity > 0) {
    if (m.newlyLive > 0) {
      freshness = 18;
      reasons.push(`${m.newlyLive} address${m.newlyLive === 1 ? "" : "es"} just went live`);
    } else if (freshnessDays != null) {
      freshness = 14 * Math.exp(-freshnessDays / 21);
      if (freshnessDays > 21) reasons.push(`${Math.round(freshnessDays)}d since last verified — re-scan for change`);
    }
  }

  // ── Force 3: headroom (0..14) — only when there are doors to work ───────────
  const headroom = m.leads > 0 ? 14 * (1 - saturation) : 0;
  if (m.leads > 0 && saturation >= 0.6) reasons.push(`${Math.round(saturation * 100)}% worked — saturating`);
  else if (m.leads >= 20 && saturation <= 0.15) reasons.push("barely touched — wide open");

  // ── Force 4: proven demand from the field (−8..+16) ─────────────────────────
  let proven = 0;
  const oc = m.outcome;
  const conversionRate = oc && oc.knocks > 0 ? oc.sales / oc.knocks : null;
  const contactRate = oc && oc.knocks > 0 ? oc.contacts / oc.knocks : null;
  if (oc && oc.knocks >= 20) {
    if (conversionRate! >= 0.12) { proven = 16; reasons.push(`proven: ${(conversionRate! * 100).toFixed(0)}% sold-per-knock in the field`); }
    else if (conversionRate! >= 0.05) { proven = 8; reasons.push(`converts: ${(conversionRate! * 100).toFixed(0)}% sold-per-knock`); }
    else if (conversionRate! < 0.02) { proven = -8; reasons.push("worked hard, low conversion — deprioritized"); }
  }

  // ── Force 5: discoverability (0..12) — unexplored upside, capped below doors ─
  // Only a market we know LITTLE about (few leads) earns this. Once a pool has
  // been substantially verified and yielded little, this collapses (the
  // empty-verified case): a scanned-out dead city is genuinely cold.
  const emptyVerified = m.verified >= 200 && m.verifiedNewFiber === 0 && confirmedUnworked === 0;
  const discover = emptyVerified ? 0
    : 12 * (1 - coverage) * satur(unverified, 3_000) * (m.leads > 200 ? 0.3 : 1);
  if (emptyVerified) reasons.push("scanned — no new fiber found here");
  else if (m.leads === 0 && unverified > 500) reasons.push(`unexplored — ${unverified.toLocaleString()} addresses to check`);

  const priority = clamp(0, 100, opportunity + freshness + headroom + proven + discover);

  // Confidence in the ASSESSMENT — driven by real operational evidence (doors on
  // the board, field knocks), NOT by how much proxy money we spent. Verified
  // checks alone can only ever earn "medium" (we know the addresses, but a scan
  // that found nothing is not high confidence in a recommendation). This keeps
  // "high confidence" honest: it means real doors or real fieldwork back it.
  const knocks = oc?.knocks ?? 0;
  const confidence: MarketCard["confidence"] =
    (m.leads >= 100 || knocks >= 40) ? "high"
    : (m.leads >= 15 || m.verified >= 300 || knocks >= 10) ? "medium"
    : "low";

  // If nothing to say, be honest rather than silent.
  if (reasons.length === 0) reasons.push(known ? "no opportunity found yet" : "unexplored market");

  const priorityBand: MarketCard["priorityBand"] =
    priority >= 60 ? "hot" : priority >= 38 ? "warm" : priority >= 18 ? "cool" : "cold";

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

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

// Saturating curve: value/(value+k) → 0..1, hits 0.5 at k. Diminishing returns.
function satur(value: number, k: number): number {
  if (value <= 0) return 0;
  return value / (value + k);
}
function clamp01(n: number): number { return clamp(0, 1, n); }
function clamp(lo: number, hi: number, n: number): number { return Math.max(lo, Math.min(hi, isFinite(n) ? n : lo)); }
function round(n: number, dp: number): number { const f = Math.pow(10, dp); return Math.round(n * f) / f; }
