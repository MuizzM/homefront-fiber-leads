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

// ── ONCE-ONLY: an answered door is never bought twice ────────────────────────
// Operator law (2026-08-22): "don't scan again if we scanned and found nothing;
// we should never scan the same address twice."
//
// The evidence says this is not merely a preference, it is the correct economics.
// Measured on the production-shaped copy, NC Kinetic:
//   * 55,503 checks were spent re-scanning addresses that already had a
//     conclusive answer (17,167 targets carry scan_count >= 2, up to 9 each);
//   * those re-scans produced ZERO new Kinetic fiber. Every one of the 25
//     addresses in all recorded history that went conclusive-negative and later
//     came back fiber was a FRONTIER door in Durham, on the separate carrier
//     path (scan_targets.first_seen_live_at is set on exactly 2 NC Kinetic rows);
//   * meanwhile 311,933 NC Kinetic doors have never been checked even once.
// So a re-check is not competing with nothing - it is competing with a door we
// have never touched, and losing. Until the unscanned pool for a market is
// exhausted, re-buying an answered door is strictly the worse trade.
//
// The caveat, stated honestly: our whole scan history is a 12-day window in July
// 2026. A copper-to-fiber flip takes months, so "zero flips" is partly a short
// window, not proof flips never happen. The rule is justified by opportunity
// cost, which holds regardless. When a market runs out of unscanned inventory,
// revisit it - and see the coming ledger below for the one sanctioned exception.
//
// ONE exception: an address the provider itself says will be serviceable LATER
// goes on the coming ledger and is re-bought exactly once at its due date
// (shared/futureService.ts). That is not a blind re-scan; it is collecting on a
// stated promise.
//
// A rep's own action (manual check, lasso, tap-a-house, an explicit recheck run)
// is never blocked: those kinds pass skipSec=0 and bypass this guard entirely.

/** `last_scanned_at IS NOT NULL` means a real provider answer landed: the engine
 *  requeues blocked/failed checks BEFORE recordScanTargetResult, so a transport
 *  failure never stamps it (server/scanEngine.ts, the `result.blocked ||
 *  checkFailed` branch returns before applyCheck). Safe to treat as terminal. */
export function answeredSql(alias: string): string {
  return `${alias}.last_scanned_at IS NOT NULL`;
}

/** Off switch for the law, so an operator can restore window-based re-scanning
 *  without a code change. Default on. */
export function onceOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.SCAN_ONCE_ONLY ?? "on").trim().toLowerCase() !== "off";
}
