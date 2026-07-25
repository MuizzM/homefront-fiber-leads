// ── scanPolicy — one place for the pool re-probe economics ────────────────────
// A pooled address that Kinetic keeps returning INCONCLUSIVE (no availability
// signal — typically a Mapbox-grid over-capture that isn't in Kinetic's address
// catalog, or a deterministic AddressNeedsFix) costs a real proxy probe every time
// it's re-checked and yields nothing. Left alone it stays `last_scanned_at IS NULL`
// forever, so the nightly re-scan and every manual sweep re-probe it in perpetuity.
//
// After this many inconclusive probes with NO conclusive answer in between, the row
// is "exhausted" and drops OUT of the never-scanned re-probe rotation. It stays
// distinguishable from a genuine Kinetic answer (last_scanned_at is still NULL, not
// stamped) and can be re-opened deliberately (a manual --retry-exhausted run, or a
// conclusive answer that resets the counter). This is a per-address circuit breaker,
// the item-level twin of the scheduler's run-level hard-backoff breaker.
//
// Kept deliberately small: a genuinely transient failure (a one-off timeout/5xx)
// almost never recurs 3 separate runs in a row on the same address, so the breaker
// only trips on the deterministic "Kinetic doesn't know this address" case.
export const INCONCLUSIVE_GIVEUP = 3;

// ── ESCALATING PARK WINDOW (2026-07-24 — the top measured waste) ─────────────
// Measured in production: 285,723 addresses (37% of the never-scanned pool) are
// parked address_not_found. Under a FLAT 14-day quiet window they ALL age back
// in together, every producer re-enqueues them, and each burns one real proxy
// check before being re-parked — forever. Two hours of live queue data:
// 333,187 parked-skips vs 9,320 genuine dedup-skips, and 170,777 enqueues to
// produce 1,836 checks (93:1). It is the churn that floods the single writer,
// grows the WAL, and starves Concord's real never-scanned backlog.
//
// Fix: the quiet window DOUBLES per park generation (a re-park counts as one
// generation), so an address Kinetic keeps rejecting backs off 14 → 28 → 56 →
// 112 days instead of returning fortnightly. Past the cap it is terminal: it
// stops re-entering the rotation and is routed to address repair/review, which
// is where a genuinely fixable variant gets corrected rather than retried.
export const ANF_PARK_MAX_GENERATIONS = 3;

/** Park generation from the raw attempt counter (0 = first park). */
export function anfParkGeneration(attempts: number): number {
  return Math.max(0, Math.floor(attempts) - INCONCLUSIVE_GIVEUP);
}

/** Effective quiet days for an address at this attempt count: base × 2^gen. */
export function anfQuietDaysFor(attempts: number, baseDays: number): number {
  return baseDays * Math.pow(2, Math.min(anfParkGeneration(attempts), ANF_PARK_MAX_GENERATIONS));
}

/**
 * The ONE SQL predicate for "this address is parked address_not_found right
 * now" — escalating window, evaluated per row. Both the selectors (which must
 * not enqueue parked rows) and the claim layer (which skips them) build from
 * this, so the two can never drift apart again.
 * `a` is the table alias (e.g. "s" or "st").
 */
export function anfParkedSql(a: string, baseDays: number): string {
  return `(${a}.last_scanned_at IS NULL
    AND ${a}.inconclusive_attempts >= ${INCONCLUSIVE_GIVEUP}
    AND ${a}.last_inconclusive_at IS NOT NULL
    AND (
      -- terminal: past the generation cap it never re-enters the rotation
      ${a}.inconclusive_attempts >= ${INCONCLUSIVE_GIVEUP + ANF_PARK_MAX_GENERATIONS + 1}
      OR ${a}.last_inconclusive_at > datetime('now', '-' ||
           (${baseDays} * (1 << MIN(MAX(${a}.inconclusive_attempts - ${INCONCLUSIVE_GIVEUP}, 0), ${ANF_PARK_MAX_GENERATIONS}))) || ' days')
    ))`;
}


// ── PROVEN-CAPACITY ESTIMATE (spiral fix, 2026-07-25) ───────────────────────
// Sizing dispatch from the INSTANTANEOUS last hour is self-reinforcing
// downward: a dip (a release window, a 403 storm) shrinks the cap, the smaller
// queue yields fewer checks, and the next hour is smaller still. Observed in
// production: `keepwarm.throughput_capped requested=45000 capped=500
// checkedLastHour=34` with throughput collapsed from 3,376/hr to 43/hr and no
// path back on its own.
//
// Capacity is therefore the BEST recent evidence, never the worst: the last
// hour, the 24-hour average, and a floor the system has already demonstrated.
// A dip can slow dispatch but can never strangle it.
export const MIN_ASSUMED_HOURLY_CHECKS = 3000;

export function provenHourlyCapacity(
  checkedLastHour: number,
  checkedLast24h: number,
  floor: number = MIN_ASSUMED_HOURLY_CHECKS,
): number {
  const dayAverage = Math.round((Number(checkedLast24h) || 0) / 24);
  return Math.max(Number(checkedLastHour) || 0, dayAverage, Math.max(1, floor));
}
