// ── Retroactive weekly commission tiering — PURE, integer-cents ───────────────
// The rep's TOTAL qualified sales in the commission week pick ONE tier, and that
// tier's rate applies RETROACTIVELY to every sale in the week:
//     grossCents = qualifiedSaleCount × tier.rateCents
// NOT progressive (7×$150 + 1×$200). All money is integer cents — never binary
// floating point. Server is authoritative; the client uses this only to preview.

export interface CommissionTier {
  id?: number | string;
  position: number;           // 0-based order (sorted by minimumSales)
  minimumSales: number;       // inclusive, whole number ≥ 1
  maximumSales: number | null; // inclusive; null == open-ended final tier
  rateCents: number;          // > 0, integer
  label: string;
}

// ── Tier validation ──────────────────────────────────────────────────────────
// Valid:   1–7, 8–12, 13–16, 17+     Invalid: overlap (7–12), gap (9–12),
//          bounded final (…10+ missing), max<min, non-integer, non-positive rate.
export interface TierValidation { ok: boolean; errors: string[]; normalized: CommissionTier[] }

function isWholeGteOne(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

export function validateTiers(input: CommissionTier[]): TierValidation {
  const errors: string[] = [];
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, errors: ["At least one tier is required."], normalized: [] };
  }
  // Sort by minimumSales (the canonical order) and re-position.
  const tiers = [...input]
    .sort((a, b) => a.minimumSales - b.minimumSales)
    .map((t, i) => ({ ...t, position: i }));

  if (tiers[0].minimumSales !== 1) errors.push("The first tier must start at 1 sale.");

  const seenMin = new Set<number>();
  tiers.forEach((t, i) => {
    const last = i === tiers.length - 1;
    if (!isWholeGteOne(t.minimumSales)) errors.push(`Tier ${i + 1}: minimum must be a whole number ≥ 1.`);
    if (seenMin.has(t.minimumSales)) errors.push(`Tier ${i + 1}: duplicate minimum (${t.minimumSales}).`);
    seenMin.add(t.minimumSales);
    if (!(typeof t.rateCents === "number" && Number.isInteger(t.rateCents) && t.rateCents > 0)) {
      errors.push(`Tier ${i + 1}: rate must be a positive whole number of cents.`);
    }
    if (last) {
      if (t.maximumSales !== null && t.maximumSales !== undefined) errors.push("The final tier must be open-ended (no maximum).");
    } else {
      if (t.maximumSales === null || t.maximumSales === undefined) errors.push(`Tier ${i + 1}: only the final tier may be open-ended.`);
      else if (!Number.isInteger(t.maximumSales)) errors.push(`Tier ${i + 1}: maximum must be a whole number.`);
      else if (t.maximumSales < t.minimumSales) errors.push(`Tier ${i + 1}: maximum (${t.maximumSales}) is below its minimum (${t.minimumSales}).`);
      else {
        const next = tiers[i + 1];
        if (next && next.minimumSales !== t.maximumSales + 1) {
          errors.push(`Tiers ${i + 1}-${i + 2} must be continuous: expected next minimum ${t.maximumSales + 1}, got ${next.minimumSales}.`);
        }
      }
    }
  });

  return { ok: errors.length === 0, errors, normalized: tiers };
}

// When adding a tier in a builder, suggest the next contiguous minimum.
export function suggestNextMinimum(previousMaximum: number | null | undefined): number | null {
  return typeof previousMaximum === "number" && Number.isFinite(previousMaximum) ? previousMaximum + 1 : null;
}

// ── O(log t) tier lookup — assumes VALID, sorted tiers ────────────────────────
export function findTierByBinarySearch(sortedTiers: CommissionTier[], count: number): CommissionTier | null {
  let lo = 0, hi = sortedTiers.length - 1, ans: CommissionTier | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = sortedTiers[mid];
    const max = t.maximumSales ?? Number.POSITIVE_INFINITY;
    if (count < t.minimumSales) hi = mid - 1;
    else if (count > max) lo = mid + 1;
    else { ans = t; break; }
  }
  return ans;
}

// ── Retroactive calculation (matches the spec signature/shape) ────────────────
export interface RetroResult {
  qualifiedSaleCount: number;
  tierId: number | string | null;
  tierLabel: string | null;
  rateCents: number;
  grossCommissionCents: number;
  nextTierId: number | string | null;
  nextTierMinimumSales: number | null;
  nextTierRateCents: number | null;
  salesUntilNextTier: number | null;
  nextTierProjectedCommissionCents: number | null;
}

export function calculateRetroactiveCommission(qualifiedSaleCount: number, sortedTiers: CommissionTier[]): RetroResult {
  if (!Number.isInteger(qualifiedSaleCount) || qualifiedSaleCount < 0) qualifiedSaleCount = Math.max(0, Math.trunc(qualifiedSaleCount || 0));

  if (qualifiedSaleCount === 0) {
    const first = sortedTiers[0] ?? null;
    return {
      qualifiedSaleCount: 0, tierId: null, tierLabel: null, rateCents: 0, grossCommissionCents: 0,
      nextTierId: first?.id ?? null, nextTierMinimumSales: first?.minimumSales ?? null,
      nextTierRateCents: first?.rateCents ?? null,
      salesUntilNextTier: first ? Math.max(1, first.minimumSales - 0) : null,
      nextTierProjectedCommissionCents: first ? first.minimumSales * first.rateCents : null,
    };
  }

  const tier = findTierByBinarySearch(sortedTiers, qualifiedSaleCount);
  if (!tier) {
    // Count below the first tier's minimum (defensive — valid tiers start at 1).
    const first = sortedTiers[0] ?? null;
    return {
      qualifiedSaleCount, tierId: null, tierLabel: null, rateCents: 0, grossCommissionCents: 0,
      nextTierId: first?.id ?? null, nextTierMinimumSales: first?.minimumSales ?? null,
      nextTierRateCents: first?.rateCents ?? null,
      salesUntilNextTier: first ? Math.max(0, first.minimumSales - qualifiedSaleCount) : null,
      nextTierProjectedCommissionCents: first ? first.minimumSales * first.rateCents : null,
    };
  }

  const idx = sortedTiers.indexOf(tier);
  const nextTier = idx >= 0 && idx < sortedTiers.length - 1 ? sortedTiers[idx + 1] : null;
  const grossCommissionCents = qualifiedSaleCount * tier.rateCents; // retroactive: one rate × all sales

  return {
    qualifiedSaleCount,
    tierId: tier.id ?? null,
    tierLabel: tier.label,
    rateCents: tier.rateCents,
    grossCommissionCents,
    nextTierId: nextTier?.id ?? null,
    nextTierMinimumSales: nextTier?.minimumSales ?? null,
    nextTierRateCents: nextTier?.rateCents ?? null,
    salesUntilNextTier: nextTier ? Math.max(0, nextTier.minimumSales - qualifiedSaleCount) : null,
    // Projected payout IF the rep reaches the next tier's minimum: min × rate.
    nextTierProjectedCommissionCents: nextTier ? nextTier.minimumSales * nextTier.rateCents : null,
  };
}

// ── Flat plan ─────────────────────────────────────────────────────────────────
export function calculateFlatCommission(qualifiedSaleCount: number, flatRateCents: number): number {
  const n = Math.max(0, Math.trunc(qualifiedSaleCount || 0));
  return n * Math.max(0, Math.trunc(flatRateCents || 0));
}

// ── Presentation helpers (still pure) ─────────────────────────────────────────
export function formatUsdCents(cents: number): string {
  const dollars = (cents || 0) / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: dollars % 1 === 0 ? 0 : 2 });
}

// The rep-facing "close N more" nudge, built from a RetroResult.
export function tierProgressMessage(r: RetroResult): string {
  if (r.qualifiedSaleCount === 0 && r.nextTierRateCents != null) {
    return `Close your first qualified sale to start earning ${formatUsdCents(r.nextTierRateCents)} per sale this week.`;
  }
  const base = `You have ${r.qualifiedSaleCount} qualified sale${r.qualifiedSaleCount === 1 ? "" : "s"} this week at ${formatUsdCents(r.rateCents)} per sale`;
  if (r.nextTierRateCents == null || r.salesUntilNextTier == null || r.nextTierProjectedCommissionCents == null) {
    return `${base} (top tier). Current commission: ${formatUsdCents(r.grossCommissionCents)}.`;
  }
  const more = r.salesUntilNextTier;
  return `${base}. Close ${more} more qualified sale${more === 1 ? "" : "s"} to reach ${formatUsdCents(r.nextTierRateCents)} per sale. At ${r.nextTierMinimumSales} qualified sales, your projected commission becomes ${formatUsdCents(r.nextTierProjectedCommissionCents)}.`;
}

// The spec's default plan (dollars → cents), for seeding / examples.
export const DEFAULT_RETRO_TIERS: CommissionTier[] = [
  { position: 0, minimumSales: 1,  maximumSales: 7,    rateCents: 15000, label: "1-7 sales" },
  { position: 1, minimumSales: 8,  maximumSales: 12,   rateCents: 20000, label: "8-12 sales" },
  { position: 2, minimumSales: 13, maximumSales: 16,   rateCents: 25000, label: "13-16 sales" },
  { position: 3, minimumSales: 17, maximumSales: null, rateCents: 30000, label: "17+ sales" },
];
