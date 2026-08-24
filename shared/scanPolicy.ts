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

/**
 * Kinds that ALWAYS re-verify an address: a rep's own action, a change-detection
 * recheck, and the coming-soon watch lane. They are exempt from both the dedup
 * window and the once-only law.
 *
 * This is the single source of truth. `dedupSkipSecondsForRun` (server/scanEngine)
 * derives its zero from here, and the claim guard asks this directly rather than
 * inferring exemption from "the dedup window happens to be zero" - which coupled
 * the operator's scanning law to an unrelated tuning knob
 * (SCAN_DEDUP_RECHECK_HOURS=0 silently disabled once-only).
 */
/**
 * Kinds ALLOWED to buy a door that already has a conclusive answer.
 *
 * An ALLOWLIST, deliberately. This was thirteen substring tests, and substrings
 * hand out exemptions by accident: `state-monitor` matched "monitor" and was
 * silently permitted to re-buy answered doors - measured at 2,388 queued
 * targets of which 2,213 already had an answer. `fresh_flip_recheck` matched
 * "recheck". Nothing validated a kind, and createScanRun accepts any string, so
 * every future producer inherited the same trap by naming.
 *
 * The operator's rule is narrow: an address is bought once, and re-bought only
 * when the provider itself said to come back. So:
 *
 *  - REP ACTIONS. A person tapped this door. Always re-verify - that is what
 *    the tap is for, and it is one check, not a producer.
 *  - THE PROMISE LANE. The carrier stated a future turn-on date or a
 *    qual-extended build. Collecting on that is the one sanctioned re-purchase.
 *  - FRONTIER. A different carrier: a Kinetic answer says nothing about
 *    Frontier serviceability, so this is a first check, not a re-check.
 *
 * Everything else - including every bulk producer, every sweep tier, the
 * nightly refresh, flip rechecks and the confirm tier - is bound by the law.
 * Unknown kinds are NOT exempt: a new producer has to ask for the exemption in
 * writing rather than acquire it by choosing a name.
 *
 * SCAN_RECHECK_EXEMPT_KINDS adds kinds without a deploy, for the case where an
 * operator needs one lane opened in a hurry.
 */
// "rescan" is here because it is an operator pressing Rescan on a market, not a
// producer running on a timer. A person choosing to spend is exactly the case
// the law is not meant to block.
const REP_ACTION_KINDS = new Set(["manual", "target_ids", "lasso", "field", "area", "bbox", "rescan"]);
const PROMISE_KINDS = new Set([
  "coming_soon_watch",
  "coming_soon_watch_yield",
  "fresh_sweep_coming_soon_watch",
]);

export function isRecheckExemptKind(
  kind: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = String(kind ?? "").trim().toLowerCase();
  if (!v) return false;
  if (REP_ACTION_KINDS.has(v) || PROMISE_KINDS.has(v)) return true;
  // A rep run may carry a suffix (manual_2026..., lasso_7f3a). Anchored to the
  // START, so "state-monitor" can never win the way it did under substrings.
  for (const k of REP_ACTION_KINDS) if (v.startsWith(`${k}_`) || v.startsWith(`${k}-`)) return true;
  // Frontier is a different provider, so this is a first check for that carrier.
  if (v === "frontier" || v.startsWith("frontier_") || v.startsWith("frontier-")) return true;
  const extra = String(env.SCAN_RECHECK_EXEMPT_KINDS ?? "")
    .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return extra.includes(v);
}

// ── BARREN GROUND: the dead-list, and why it is OFF ─────────────────────────
//
// The operator's rule: if a door came back with no fiber and no coming-soon
// promise, never pay for it again - and if the whole street reads that way,
// stop buying the street.
//
// The ADDRESS half is already law and already works (SCAN_ONCE_ONLY above): a
// conclusive answer stamps last_scanned_at and the door leaves the
// never-scanned rotation permanently. That is where the real waste was.
//
// The GROUND half - refusing to buy the UNSCANNED neighbours of proven-dead
// ground - was measured before being trusted, and it does not pay. Ordering
// every answered NC door by scan time and asking what each rule would have
// condemned, then weighting by the unscanned doors it would skip:
//
//   rule            doors skipped   of those, on ground that HAS fiber
//   street, min 3        7,845            1,352   17.2%
//   street, min 5        4,431              829   18.7%
//   street, min 8        2,290              755   33.0%
//   cell,   min 5       16,650            4,145   24.9%
//   cell,   min 8       10,911            3,341   30.6%
//   cell,   min 12       7,196            2,312   32.1%
//
// Between a sixth and a third of everything these rules skip sits on ground
// that fiber actually reaches. More evidence makes it WORSE, not better,
// because the units that survive a long all-dead prefix are the big ones, and
// the big ones are exactly where the unscanned doors are.
//
// The cell is the worse unit despite holding more evidence: 0.01 degrees is
// about a kilometre and crosses several streets, so it is not homogeneous. The
// street is tighter (17-19% against 25-32%), which makes the operator's own
// instinct the better of the two.
//
// Neither is worth it. The best case - street at min 3 - saves 7,845 of
// 311,847 never-scanned NC doors, about 2.5% of the scan or 48 minutes of a
// 32-hour run, in exchange for going blind to 1,352 doors on live fiber
// streets. The saving is rounding; the loss is inventory.
//
// So both default OFF, and the real answer to "do not waste checks" is not a
// dead-list at all: it is scanning in yield order. Doors in a cell that has
// already produced fiber convert at about 22.5%; doors with no nearby evidence
// at about 0.9%. Ordering the same 311,847 doors by that signal puts 42,427
// high-yield doors in the first 4.4 hours instead of spreading them over 32.
//
// The machinery stays because an operator may want it for a market they have
// deliberately written off, and because the numbers above should be re-derived
// rather than re-guessed. NOTHING HERE DELETES: these are selector predicates.
// A door keeps its row and its history and returns the moment real evidence
// arrives - an FCC vintage diff, a coming-soon promise, or a rep pressing
// Rescan, all already recheck-exempt above.
export const BARREN_CELL_MIN_DOORS = 8;
export const BARREN_STREET_MIN_DOORS = 5;

// Both OFF by default. See the measurements above: each skips more live fiber
// than it saves in checks.
export function barrenCellSkipEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.SCAN_SKIP_BARREN_CELLS ?? "off").trim().toLowerCase() === "on";
}
export function barrenStreetSkipEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.SCAN_SKIP_BARREN_STREETS ?? "off").trim().toLowerCase() === "on";
}

/** A door carries fiber evidence. One definition, used by both predicates. */
export const FIBER_EVIDENCE_SQL = `(
     %A%.last_fiber_status IN ('new_fiber','tenured_fiber','existing_fiber')
  OR %A%.last_fiber_available = 1
  OR %A%.last_is_new_fiber = 1 )`;

function fiberEvidence(alias: string): string {
  return FIBER_EVIDENCE_SQL.replace(/%A%/g, alias);
}

/**
 * SQL that is TRUE when this unscanned door sits on ground already proven dead.
 * Select with `AND NOT ${barrenGroundSql("s")}` to keep it out of a rotation.
 *
 * "Proven dead" means: enough answered doors in the same cell (or street), and
 * not one of them carried fiber, and none is on the coming-soon watchlist. The
 * coming-soon clause is what keeps a promised build alive - the operator's
 * exception is honoured at the GROUND level, not just per address.
 */
export function barrenGroundSql(
  alias: string,
  opts: { cells?: boolean; streets?: boolean; cellMin?: number; streetMin?: number } = {},
): string {
  const cells = opts.cells ?? true;
  const streets = opts.streets ?? false;
  const cellMin = opts.cellMin ?? BARREN_CELL_MIN_DOORS;
  const streetMin = opts.streetMin ?? BARREN_STREET_MIN_DOORS;
  const parts: string[] = [];
  if (cells) {
    parts.push(`(${alias}.cell_lat IS NOT NULL AND EXISTS (
      SELECT 1 FROM scan_targets b
       WHERE b.tenant_id = ${alias}.tenant_id
         AND b.cell_lat = ${alias}.cell_lat AND b.cell_lng = ${alias}.cell_lng
         AND b.last_scanned_at IS NOT NULL
       GROUP BY b.cell_lat, b.cell_lng
      HAVING COUNT(*) >= ${cellMin} AND SUM(CASE WHEN ${fiberEvidence("b")} THEN 1 ELSE 0 END) = 0))`);
  }
  if (streets) {
    parts.push(`(${alias}.street_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM scan_targets b
       WHERE b.tenant_id = ${alias}.tenant_id
         AND b.street_key = ${alias}.street_key AND b.city = ${alias}.city
         AND b.last_scanned_at IS NOT NULL
       GROUP BY b.street_key, b.city
      HAVING COUNT(*) >= ${streetMin} AND SUM(CASE WHEN ${fiberEvidence("b")} THEN 1 ELSE 0 END) = 0))`);
  }
  if (!parts.length) return "0";
  // A promised build is never barren, whatever the ground around it says.
  return `((${parts.join(" OR ")}) AND NOT EXISTS (
      SELECT 1 FROM coming_soon_watchlist w
       WHERE w.tenant_id = ${alias}.tenant_id AND w.scan_target_id = ${alias}.id))`;
}
