// ── Scan economics — verification budget as capital ───────────────────────────
// The scarce resource in this product is NOT addresses (we have a 62k-address
// pool already harvested and geocoded). It is VERIFICATION BUDGET: every Kinetic
// availability check routes through the Decodo residential proxy and is billed
// per GB of bandwidth. Two past billing incidents (123K, then 1.16M requests)
// make this the one number an operator must see BEFORE spending. So a scan is
// defined by a budget — a hard cap on the number of proxy checks — and the cost
// is estimated up front and MEASURED as it runs.
//
// Pure module: no proxy, no DB, no env reads. The server passes in the rate.

// Measured on the live Kinetic v2 address/search path through the residential
// proxy: request (headers + small JSON body) + the full address response JSON
// (address object + competitor + uqual + broadband) ≈ this many bytes billed
// per check, TLS/handshake amortized over a warm keep-alive socket. This is an
// ESTIMATE used only for the up-front number; runs record actual bytes when the
// response carries content-length, so displayed cost converges on truth.
export const DEFAULT_BYTES_PER_CHECK = 12_000; // ~12 KB/check

// Decodo residential is billed per GB; the exact rate is plan-specific, so it
// lives in env (SCAN_USD_PER_GB). This default is a conservative mid-plan rate
// used only when the operator hasn't configured one.
export const DEFAULT_USD_PER_GB = 3.0;

const BYTES_PER_GB = 1024 * 1024 * 1024;

export interface CostRate {
  bytesPerCheck?: number; // override the per-check byte estimate
  usdPerGb?: number;      // proxy $/GB
}

export interface CostEstimate {
  checks: number;         // number of Kinetic checks this scan will make
  estBytes: number;       // estimated proxy bytes billed
  estGb: number;          // same, in GB (for display)
  estUsd: number;         // estimated dollar cost
  bytesPerCheck: number;
  usdPerGb: number;
}

// Estimate the cost of verifying `checks` addresses. Deterministic — the same
// inputs always produce the same number the operator will be billed against.
export function estimateScanCost(checks: number, rate: CostRate = {}): CostEstimate {
  const bytesPerCheck = rate.bytesPerCheck ?? DEFAULT_BYTES_PER_CHECK;
  const usdPerGb = rate.usdPerGb ?? DEFAULT_USD_PER_GB;
  const n = Math.max(0, Math.floor(checks));
  const estBytes = n * bytesPerCheck;
  const estGb = estBytes / BYTES_PER_GB;
  const estUsd = estGb * usdPerGb;
  return {
    checks: n,
    estBytes,
    estGb: round(estGb, 4),
    estUsd: round(estUsd, 4),
    bytesPerCheck,
    usdPerGb,
  };
}

// Convert measured bytes back to a dollar figure — used to show the REAL cost of
// a completed run (est_bytes accumulated from actual responses).
export function bytesToUsd(bytes: number, rate: CostRate = {}): number {
  const usdPerGb = rate.usdPerGb ?? DEFAULT_USD_PER_GB;
  return round((bytes / BYTES_PER_GB) * usdPerGb, 4);
}

// A hard per-run ceiling so no single scan (or a fat-fingered budget) can spend
// unbounded money. The route clamps the operator's budget to this. 5,000 checks
// ≈ 60 MB ≈ ~$0.18 at the default rate — enough to verify a small city or the
// hottest slice of a big one, small enough to never be a billing event.
export const MAX_CHECKS_PER_RUN = 100_000; // unlimited-budget posture (was 5,000)

// Suggested budget tiers surfaced in the UI — named so an operator reasons in
// outcomes ("sample a market" vs "work a neighborhood"), not raw request counts.
export interface BudgetTier { key: string; label: string; checks: number; blurb: string }
export function budgetTiers(poolRemaining: number): BudgetTier[] {
  const tiers: BudgetTier[] = [
    { key: "sample", label: "Sample", checks: 250, blurb: "Read the market cheaply" },
    { key: "probe", label: "Probe", checks: 1_000, blurb: "Find the live pockets" },
    { key: "sweep", label: "Sweep", checks: 2_500, blurb: "Work a full neighborhood" },
    { key: "max", label: "Deep sweep", checks: MAX_CHECKS_PER_RUN, blurb: "Maximum single run" },
  ];
  // Never offer a tier larger than what's left to verify.
  return tiers
    .map(t => ({ ...t, checks: Math.min(t.checks, poolRemaining) }))
    .filter((t, i, arr) => t.checks > 0 && (i === 0 || t.checks > arr[i - 1].checks));
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
