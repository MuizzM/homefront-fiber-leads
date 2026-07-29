// Exact money. One place, integer minor units, documented rounding.
//
// WHY THIS EXISTS, with the arithmetic that motivated it:
//
//   shared/commission.ts:52  round2((percentage / 100) * basis)
//   shared/commission.ts:41  round2 = (n) => Math.round(n * 100) / 100
//
// At 15% of $50.30:
//
//   (15 / 100) * 50.30              → 7.544999999999999   (exact decimal: 7.5450)
//   Math.round(7.544999999999999*100)/100 → 7.54
//
// The correct half-up cent value is 7.55. The rep is short a cent, silently,
// and no test catches it because the expected value was computed the same wrong
// way. It is not a rare boundary: 15% of $50.50, 12.5% of $64.60, 10% of $80.85
// and 10% of $83.35 all lose a cent identically. Summing floats compounds it —
// a thousand commissions of $150.10 total 150100.00000000282.
//
// The codebase already knows the answer. commissionPlanVersions.flatRateCents,
// commissionTiers.rateCents, commissionStatements.*Cents and rep_payouts
// .amount_cents are all integer cents with integer-first aggregation. This
// module is that discipline made reusable so the older lane can join it.
//
// RULES, stated once and enforced by tests:
//   * Money is a JS integer number of MINOR UNITS (cents). Never a float dollar.
//     Integers are exact in IEEE-754 up to 2^53, which is $90 trillion — beyond
//     any commission this system will hold. assertSafeMoney guards the edge.
//   * Rates are integer BASIS POINTS. 15% = 1500. 12.5% = 1250. Never a float
//     percentage, and never a 0–1 fraction: the schema already contains BOTH
//     conventions (commissionRates.percentage is 0–100, tenants.revenueSharePct
//     is 0–1), which is a 100x error waiting to happen. Basis points remove the
//     ambiguity because 1500 cannot be misread as either.
//   * Rounding is HALF-UP ON MAGNITUDE, applied once, at the point a fractional
//     minor unit would otherwise be stored. Half-up because that is what a
//     person checking the maths by hand expects; on magnitude so that a
//     chargeback of -$7.545 recovers 755, not 754 — a negative that rounds
//     toward zero silently under-recovers, which is a bug that favours whoever
//     owes money.

/** Money is always an integer count of minor units (cents for USD). */
export type Cents = number;
/** A rate as integer basis points: 1500 = 15%, 10000 = 100%. */
export type BasisPoints = number;

export const BASIS_POINTS_SCALE = 10_000;
/** 2^53 − 1. Beyond this, integer arithmetic stops being exact. */
export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {}

/** Throws unless `v` is an exact, safe integer count of minor units. */
export function assertSafeMoney(v: unknown, what = "amount"): asserts v is Cents {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new MoneyError(`${what} must be a finite number, got ${String(v)}`);
  }
  if (!Number.isInteger(v)) {
    throw new MoneyError(`${what} must be whole minor units (cents), got ${v}`);
  }
  if (!Number.isSafeInteger(v)) {
    throw new MoneyError(`${what} exceeds exact integer range: ${v}`);
  }
}

export function assertBasisPoints(v: unknown, what = "rate"): asserts v is BasisPoints {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new MoneyError(`${what} must be integer basis points, got ${String(v)}`);
  }
  if (v < 0) throw new MoneyError(`${what} must not be negative, got ${v}`);
}

/**
 * Half-up on magnitude. The ONLY rounding in this module, so there is exactly
 * one place to argue with.
 *
 * Math.round is deliberately not used: it rounds half toward +Infinity, so
 * -0.5 becomes -0 rather than -1. For a chargeback that means recovering less
 * than the policy states, in the house's favour, invisibly.
 */
function roundHalfUpMagnitude(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Apply a basis-point rate to an amount, rounding once at the end.
 *
 * The intermediate `cents * bp` is computed in integers before the single
 * division, so the fractional part is exact rather than an accumulated float
 * error. This is the pattern shared/payoutCosts.ts already uses.
 */
export function applyRate(cents: Cents, bp: BasisPoints): Cents {
  assertSafeMoney(cents);
  assertBasisPoints(bp);
  const product = cents * bp;
  if (!Number.isSafeInteger(product)) {
    throw new MoneyError(`rate application overflows exact range: ${cents} × ${bp}`);
  }
  return roundHalfUpMagnitude(product / BASIS_POINTS_SCALE);
}

/** Sum, exactly. Integer addition cannot drift the way float addition does. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) {
    assertSafeMoney(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError("sum exceeds exact integer range");
  }
  return total;
}

/**
 * Split `cents` into `weights.length` shares in proportion to `weights`,
 * guaranteeing the shares sum EXACTLY back to `cents`.
 *
 * Largest-remainder: floor every share, then hand the leftover minor units out
 * one at a time to the largest fractional remainders, ties broken by index so
 * the result is deterministic and reproducible in an audit.
 *
 * Rounding each share independently is the obvious approach and it is wrong:
 * three equal shares of 100 would each round to 33 and lose a cent, or each
 * round to 34 and invent one. Neither is acceptable when the total is somebody's
 * pay.
 */
export function allocate(cents: Cents, weights: readonly number[]): Cents[] {
  assertSafeMoney(cents);
  if (!weights.length) throw new MoneyError("allocate needs at least one weight");
  for (const w of weights) {
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0) {
      throw new MoneyError(`weights must be finite and non-negative, got ${String(w)}`);
    }
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) throw new MoneyError("weights must not sum to zero");

  const sign = cents < 0 ? -1 : 1;
  const magnitude = Math.abs(cents);

  const exact = weights.map((w) => (magnitude * w) / totalWeight);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = magnitude - floors.reduce((a, b) => a + b, 0);

  // Largest fractional part first; index breaks ties so the outcome is stable.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = floors.slice();
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    out[order[k].i] += 1;
  }
  return out.map((v) => v * sign);
}

/**
 * Parse a human/legacy dollar value into exact cents.
 *
 * Accepts a string (preferred — no float ever exists) or a number (tolerated for
 * migrating existing `real` columns, and rounded half-up on magnitude exactly
 * once). "$1,234.56" and " 1234.56 " both work; anything else throws rather than
 * silently becoming NaN or 0, because a money field that quietly reads zero is
 * how a rep gets paid nothing.
 */
export function parseToCents(input: string | number): Cents {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new MoneyError(`cannot parse ${input} as money`);
    return roundHalfUpMagnitude(input * 100);
  }
  const cleaned = String(input).trim().replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new MoneyError(`cannot parse ${JSON.stringify(input)} as money`);
  }
  const negative = cleaned.startsWith("-");
  const [whole, frac = ""] = cleaned.replace("-", "").split(".");
  // Pad/truncate to exactly 2 decimals, rounding the third digit half-up.
  const cents =
    Number(whole) * 100 +
    Number((frac + "00").slice(0, 2)) +
    (Number(frac[2] ?? "0") >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`${input} exceeds exact integer range`);
  return negative ? -cents : cents;
}

/** Display only. Never feed the result back into arithmetic. */
export function formatCents(cents: Cents, currency = "USD"): string {
  assertSafeMoney(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const symbol = currency === "USD" ? "$" : "";
  return `${sign}${symbol}${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, "0")}`;
}

/** 1500 → "15%", 1250 → "12.5%". Display only. */
export function formatBasisPoints(bp: BasisPoints): string {
  assertBasisPoints(bp);
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0$/, "")}%`;
}

/** Percent (0–100) → basis points. For migrating commissionRates.percentage. */
export function percentToBasisPoints(percent: number): BasisPoints {
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    throw new MoneyError(`cannot convert ${String(percent)} to basis points`);
  }
  return roundHalfUpMagnitude(percent * 100);
}

/** Fraction (0–1) → basis points. For migrating tenants.revenueSharePct.
 *  Deliberately a SEPARATE function from percentToBasisPoints: the schema holds
 *  both conventions in adjacent tables, and one shared helper would make the
 *  100x mix-up a matter of which argument someone passed. */
export function fractionToBasisPoints(fraction: number): BasisPoints {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
    throw new MoneyError(`cannot convert ${String(fraction)} to basis points`);
  }
  return roundHalfUpMagnitude(fraction * BASIS_POINTS_SCALE);
}
