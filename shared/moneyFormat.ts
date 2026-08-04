// ── Money and clock formatting for the UI, and nothing else ─────────────────
//
// This module exists for a BUNDLE reason, not a tidiness one.
//
// `usd` was defined separately inside doorDrop.ts, momentumSpiff.ts,
// knockMilestones.ts and dailyUpside.ts. Every rep-facing card that wanted to
// print a dollar amount imported it from one of those — and an ES import pulls
// in the WHOLE module. So a card whose only job was rendering "$15" shipped the
// door-drop odds, the pity ceiling, the org spend caps and the milestone ladder
// to every phone in the field.
//
// Measured in the built bundle before this split:
//
//     oddsOneIn             present
//     pityAtDoors           present
//     maxCentsPerOrgPerDay  present
//
// No minifier fixes that. esbuild already mangles local identifiers, but
// CONSTANTS survive renaming: 45 is still 45 and 120 is still 120 whatever the
// variables around them are called. The only way to stop shipping a number is
// to stop importing the module that holds it.
//
// Distinct from shared/money.ts, which is exact-arithmetic (basis points,
// allocation, rounding policy) and belongs to the commission engine. This one
// only turns numbers into strings.
//
// PURE and dependency-free, deliberately: anything added here ships to every
// client, which is the exact problem it was created to solve.

/** Integer cents → "$15" / "$12.50" / "-$40".
 *
 *  Whole dollars drop the ".00" — a field card is read at arm's length in
 *  sunlight, and "$15" scans faster than "$15.00". */
export function usd(c: number): string {
  const v = Math.trunc(Number.isFinite(c) ? c : 0);
  const whole = Math.floor(Math.abs(v) / 100).toLocaleString("en-US");
  const rem = Math.abs(v) % 100;
  const body = rem === 0 ? `$${whole}` : `$${whole}.${String(rem).padStart(2, "0")}`;
  return v < 0 ? `-${body}` : body;
}

/** Milliseconds → "43 min" / "2h 10m". Empty string for no deadline.
 *
 *  Minutes below an hour on purpose: "63 min" reads as a clock running out,
 *  "1h 3m" reads as comfortable. */
export function countdownLabel(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The momentum offer's own countdown wording: "12m left" / "Under a minute" /
 *  "Expired". Kept distinct from countdownLabel because an offer measured in
 *  minutes reads differently from a campaign measured in hours — and moved here
 *  so the card rendering it stops importing the momentum ENGINE (scoring
 *  weights, anti-sandbagging floors, tier thresholds) to print one string. */
export function offerCountdownLabel(expiresAtMs: number, nowMs: number): string {
  const ms = Math.max(0, expiresAtMs - nowMs);
  if (ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "Under a minute";
  return `${mins}m left`;
}
