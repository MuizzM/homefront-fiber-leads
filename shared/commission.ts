// ── Commission engine — PURE and framework-free ───────────────────────────────
// The single source of truth for commission structures and their calculation.
// Imported by BOTH server/routes.ts (sale-time locking) and the client (preview
// in the structure editor), so a plan can never be scored two different ways.
//
// GOVERNANCE: the structure that scores a sale is the one IN EFFECT for that rep
// AT SALE TIME, and its id + version + calc type + amount are frozen onto the
// commission record. Editing a plan later never rewrites a booked commission —
// it publishes a new version; past sales keep the version they were sold under.

export type CalcType = "flat" | "percentage" | "tiered";

export interface Tier {
  // Applies when the sale's monthly value (or count basis) is ≥ minBasis.
  // Tiers are evaluated highest-minBasis-first; the first match wins.
  minBasis: number;
  amount: number;       // flat payout for this tier (dollars)
}

export interface CommissionStructure {
  id: number;
  name: string;
  calcType: CalcType;
  // flat: `flatAmount` dollars per sale.
  flatAmount: number;
  // percentage: `percentage` of the sale's `saleAmount` (0–100).
  percentage: number;
  // tiered: sorted-agnostic list; the engine picks the right band.
  tiers: Tier[];
  role: string | null;   // applies to a whole role (null = not role-scoped)
  repId: number | null;  // applies to one rep (wins over role)
  effectiveFrom: string; // ISO date "YYYY-MM-DD" — active on/after this day
  effectiveTo: string | null; // ISO date — active up to/including; null = open-ended
  version: number;       // bumped on every published edit
  isActive: boolean;
}

export interface CalcResult {
  amount: number;        // dollars, rounded to cents
  calcType: CalcType;
  tierMinBasis: number | null; // which tier matched (tiered only), else null
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Deterministic: same structure + same sale inputs → same payout, always.
// `saleAmount` is the deal's monthly/contract value; only percentage & tiered
// read it, so a flat plan ignores it entirely.
export function calcCommission(structure: CommissionStructure, saleAmount: number): CalcResult {
  const basis = Number.isFinite(saleAmount) && saleAmount > 0 ? saleAmount : 0;
  switch (structure.calcType) {
    case "percentage":
      return { amount: round2((structure.percentage / 100) * basis), calcType: "percentage", tierMinBasis: null };
    case "tiered": {
      // Highest qualifying band wins; below the lowest band pays 0.
      const bands = [...structure.tiers].sort((a, b) => b.minBasis - a.minBasis);
      const hit = bands.find(t => basis >= t.minBasis);
      return { amount: round2(hit?.amount ?? 0), calcType: "tiered", tierMinBasis: hit?.minBasis ?? null };
    }
    case "flat":
    default:
      return { amount: round2(structure.flatAmount), calcType: "flat", tierMinBasis: null };
  }
}

// Pick the structure in effect for a rep at a given date. Priority:
//   rep-specific  >  role-scoped  (a rep's own plan overrides their role plan)
// then, within that, the one whose window covers `saleDate` with the LATEST
// effectiveFrom (the most recently published plan wins a same-day overlap).
// Returns null when nothing covers the date — caller must not book a commission
// it can't explain. Callers should pass a date-sorted array for O(log n); this
// scans defensively but the set is tiny (plans per company), so it's O(n) here.
export function pickActiveStructure(
  structures: CommissionStructure[],
  repId: number,
  role: string | null,
  saleDate: string,
): CommissionStructure | null {
  const covers = (s: CommissionStructure): boolean =>
    s.isActive && s.effectiveFrom <= saleDate && (s.effectiveTo == null || s.effectiveTo >= saleDate);

  let best: CommissionStructure | null = null;
  const better = (cand: CommissionStructure, cur: CommissionStructure | null): boolean => {
    if (!cur) return true;
    // rep-specific beats role-scoped
    const candRep = cand.repId === repId, curRep = cur.repId === repId;
    if (candRep !== curRep) return candRep;
    // then latest effectiveFrom, then highest version (tie-break on republish)
    if (cand.effectiveFrom !== cur.effectiveFrom) return cand.effectiveFrom > cur.effectiveFrom;
    return cand.version > cur.version;
  };

  for (const s of structures) {
    if (!covers(s)) continue;
    if (s.repId != null && s.repId !== repId) continue;      // another rep's plan
    if (s.repId == null && s.role != null && s.role !== role) continue; // another role's plan
    if (better(s, best)) best = s;
  }
  return best;
}

// Human summary for the structure editor / audit line ("15% of MRC", "$120 flat").
export function describeStructure(s: Pick<CommissionStructure, "calcType" | "flatAmount" | "percentage" | "tiers">): string {
  switch (s.calcType) {
    case "percentage": return `${s.percentage}% of sale value`;
    case "tiered":     return `${s.tiers.length}-tier (${s.tiers.map(t => `≥$${t.minBasis}→$${t.amount}`).join(", ")})`;
    case "flat":
    default:           return `$${s.flatAmount} flat per sale`;
  }
}
