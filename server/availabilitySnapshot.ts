import { rawDb } from "./db";
import { evaluateSingleCompetitor } from "@shared/competitiveEligibility";

// ── The ONE availability_snapshots writer ────────────────────────────────────
// Manual Check, Field Map, discovery, city, nightly, cluster, and Coming Soon
// scans ALL record attempts through recordAvailabilitySnapshot(). No other code
// may INSERT into availability_snapshots. `checked_at` is stored as canonical
// epoch milliseconds (checked_at_epoch, the ONLY column used for chronological
// ordering) plus a derived UTC ISO string (checked_at) for display/compat — so a
// mixed text format can never be reintroduced (the DB trigger also rejects any
// row whose checked_at_epoch is not an integer).

export interface AvailabilitySnapshotInput {
  tenantId: number;
  scanTargetId: number;
  runId?: string | null;
  /** Event time as epoch ms, Date, or ISO/SQLite string. Defaults to now. */
  checkedAt?: number | string | Date | null;
  conclusive: boolean;
  fiberAvailable?: boolean | null;
  fiberStatus?: string | null;
  maxDownloadMbps?: number | null;
  serviceStatus?: string | null;
  householdSegmentType?: string | null;
  billingStatus?: string | null;
  customerSegment?: string | null;
  customerConfidence?: string | null;
  customerSignals?: string[] | string | null;
  transitionStatus: string;
  fresh?: boolean;
  apiSource?: string | null;
  evidenceHash: string;
  fiberCheckId?: number | null;
  error?: string | null;
  blocked?: boolean;
  latencyMs?: number | null;
  /** Competitor intel from the provider payload — drives the competitive
   * eligibility decision persisted alongside the snapshot. */
  competitorName?: string | null;
  competitorTech?: string | null;
  competitorSpeedMbps?: number | null;
  /** Crash-idempotent write keyed on (tenant,run,target). */
  orIgnore?: boolean;
}

/** Normalize a Date | epoch ms | ISO/SQLite string into canonical epoch ms. */
export function toEpochMs(value: number | string | Date | null | undefined): number {
  if (value == null) return Date.now();
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : Date.now();
  if (value instanceof Date) { const t = value.getTime(); return Number.isFinite(t) ? t : Date.now(); }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : Date.now();
}

const COLS = `(tenant_id,scan_target_id,run_id,checked_at,checked_at_epoch,conclusive,fiber_available,fiber_status,
  max_download_mbps,service_status,household_segment_type,billing_status,customer_segment,customer_confidence,
  customer_signals,transition_status,fresh,api_source,evidence_hash,fiber_check_id,error,blocked,latency_ms,
  competitor_name,competitor_tech,competitive_decision,competitive_version)`;
const VALUES = `(@tenant_id,@scan_target_id,@run_id,@checked_at,@checked_at_epoch,@conclusive,@fiber_available,@fiber_status,
  @max_download_mbps,@service_status,@household_segment_type,@billing_status,@customer_segment,@customer_confidence,
  @customer_signals,@transition_status,@fresh,@api_source,@evidence_hash,@fiber_check_id,@error,@blocked,@latency_ms,
  @competitor_name,@competitor_tech,@competitive_decision,@competitive_version)`;

let _insert: any = null;
let _insertIgnore: any = null;
function stmts() {
  if (!_insert) {
    _insert = rawDb.prepare(`INSERT INTO availability_snapshots ${COLS} VALUES ${VALUES}`);
    _insertIgnore = rawDb.prepare(`INSERT OR IGNORE INTO availability_snapshots ${COLS} VALUES ${VALUES}`);
  }
  return { insert: _insert, insertIgnore: _insertIgnore };
}

export function recordAvailabilitySnapshot(s: AvailabilitySnapshotInput): number {
  const epoch = toEpochMs(s.checkedAt);
  const params = {
    tenant_id: s.tenantId,
    scan_target_id: s.scanTargetId,
    run_id: s.runId ?? null,
    checked_at: new Date(epoch).toISOString(),
    checked_at_epoch: epoch,
    conclusive: s.conclusive ? 1 : 0,
    fiber_available: s.fiberAvailable == null ? null : (s.fiberAvailable ? 1 : 0),
    fiber_status: s.fiberStatus ?? null,
    max_download_mbps: s.maxDownloadMbps ?? null,
    service_status: s.serviceStatus ?? null,
    household_segment_type: s.householdSegmentType ?? null,
    billing_status: s.billingStatus ?? null,
    customer_segment: s.customerSegment ?? "unknown",
    customer_confidence: s.customerConfidence ?? "low",
    customer_signals: Array.isArray(s.customerSignals) ? JSON.stringify(s.customerSignals) : (s.customerSignals ?? "[]"),
    transition_status: s.transitionStatus,
    fresh: s.fresh ? 1 : 0,
    api_source: s.apiSource ?? null,
    evidence_hash: s.evidenceHash,
    fiber_check_id: s.fiberCheckId ?? null,
    error: s.error ?? null,
    blocked: s.blocked ? 1 : 0,
    latency_ms: s.latencyMs == null ? null : Math.max(0, Math.round(s.latencyMs)),
    competitor_name: s.competitorName ?? null,
    competitor_tech: s.competitorTech ?? null,
    // Canonical eligibility decision, computed ONCE here (the storage choke
    // point) so projection/delivery/recheck all read the same verdict.
    competitive_decision: evaluateSingleCompetitor(s.competitorName, s.competitorTech, s.competitorSpeedMbps).decision,
    competitive_version: evaluateSingleCompetitor(s.competitorName, s.competitorTech, s.competitorSpeedMbps).version,
  };
  const { insert, insertIgnore } = stmts();
  const res = (s.orIgnore ? insertIgnore : insert).run(params);
  // The lifecycle + Coming-Soon watchlist advance HERE and only here — the one
  // choke point every conclusive result already passes through (see below). A
  // crash-replayed orIgnore write that inserted nothing advances nothing.
  if (res.changes > 0) applyConclusiveLifecycle(s, epoch);
  return Number(res.lastInsertRowid);
}

// ── Explicit address lifecycle (+ Coming-Soon watchlist bookkeeping) ─────────
// WHY THIS FILE: the two candidate homes for lifecycle writes were this writer
// and kineticObservation.persistKineticObservation. kineticObservation is only
// the LEGACY observation path — the budgeted scan engine (applyCheck →
// persistSnapshot) never goes through it, so a lifecycle written there would
// miss every discovery/city/nightly/watch run. Both paths DO funnel every
// record attempt through recordAvailabilitySnapshot (enforced by the comment
// contract at the top of this file), which also already carries exactly the
// fields the state machine needs (conclusive, fiberAvailable, segment, billing,
// transitionStatus). So the snapshot writer is the single choke point.
//
// HARD RULES:
//  - Only CONCLUSIVE results advance the lifecycle. A transport failure /
//    blocked / inconclusive attempt (conclusive=0 or fiberAvailable=null) is
//    retry history and never touches lifecycle_state.
//  - Out-of-order historical evidence (an imported snapshot whose checked_at is
//    OLDER than the last lifecycle write) never regresses the state.
//  - lifecycle_changed_at is epoch ms and means "last set OR re-affirmed by a
//    conclusive check"; AGED is applied by the watchlist tick when a
//    FRESH_LEAD/STILL_FRESH goes LIFECYCLE_AGED_DAYS without re-affirmation.

export type LifecycleState =
  | "UNAVAILABLE"
  | "COMING_SOON"
  | "NEWLY_LIT"
  | "FRESH_LEAD"
  | "STILL_FRESH"
  | "AGED";

const upper = (v: unknown) => String(v ?? "").trim().toUpperCase();

// Pre-launch segment markers — same signal set as isComingSoon() in
// kineticResponseParser.ts (segment/market-segment COMING SOON | FUTURE |
// PLANNED | PENDING). serviceStatus is deliberately NOT consulted here: the
// scan engine stores free-text notes in the snapshot's service_status column,
// which must never be pattern-matched into a classification.
const COMING_SOON_SEGMENT_RE = /COMING\s*SOON|FUTURE|PLANNED|PENDING/;

export interface LifecycleSignal {
  fiberAvailable: boolean;
  comingSoon: boolean;
  freshQualifying: boolean;
  transitionStatus: string;
}

/** Reduce one conclusive snapshot to the three lifecycle-relevant booleans. */
export function lifecycleSignalOf(s: {
  fiberAvailable?: boolean | null;
  fiberStatus?: string | null;
  householdSegmentType?: string | null;
  billingStatus?: string | null;
  transitionStatus: string;
}): LifecycleSignal {
  const seg = upper(s.householdSegmentType);
  const billing = upper(s.billingStatus);
  const available = s.fiberAvailable === true;
  const newFiber = seg === "NEW FIBER" || String(s.fiberStatus ?? "") === "new_fiber";
  return {
    fiberAvailable: available,
    // COMING_SOON = an explicit pre-launch segment, OR the existing scanner
    // rule (scanner.ts Live-Test classification + kinetic_addresses
    // is_coming_soon): NEW FIBER with an ACTIVE billing account.
    // Billing 'A' is ALSO an active account (live-verified Kinetic contract), same
    // pre-launch/coming-soon shape as 'Y'.
    comingSoon: COMING_SOON_SEGMENT_RE.test(seg) || (newFiber && (billing === "Y" || billing === "A")),
    // THE Fresh Lead rule, unchanged: NEW FIBER + billing N + fiber qualified.
    freshQualifying: available && newFiber && billing === "N",
    transitionStatus: String(s.transitionStatus ?? ""),
  };
}

/**
 * Pure state machine. Returns the next state, or null when this conclusive
 * answer makes no lifecycle claim (e.g. baseline available service) — the
 * stored state is then carried forward untouched.
 */
export function nextLifecycleState(
  prev: LifecycleState | null,
  sig: LifecycleSignal,
): LifecycleState | null {
  if (sig.freshQualifying) {
    // First confirmation is FRESH_LEAD; any later conclusive re-confirmation
    // (including one that revives an AGED lead) is STILL_FRESH.
    return prev === "FRESH_LEAD" || prev === "STILL_FRESH" || prev === "AGED"
      ? "STILL_FRESH"
      : "FRESH_LEAD";
  }
  if (sig.comingSoon) return "COMING_SOON";
  if (!sig.fiberAvailable) return "UNAVAILABLE";
  // Available but not lead-qualifying: a flip out of unavailable/coming-soon is
  // NEWLY_LIT (either the durable prev state says so, or — for targets that
  // predate lifecycle_state — the transition classifier already proved the flip
  // against the previous conclusive snapshot).
  if (prev === "UNAVAILABLE" || prev === "COMING_SOON" || sig.transitionStatus === "freshly_available") {
    return "NEWLY_LIT";
  }
  return null;
}

// Self-healing schema: prod gets these from storage.runMigrations(); replay
// harnesses and older DBs get them here so the money path can never crash on a
// missing column. Same DDL as the migration — idempotent either way.
let _lifecycleSchemaReady = false;
function ensureLifecycleSchema(): void {
  if (_lifecycleSchemaReady) return;
  for (const ddl of [
    `ALTER TABLE scan_targets ADD COLUMN lifecycle_state TEXT`,
    `ALTER TABLE scan_targets ADD COLUMN lifecycle_changed_at INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_scan_targets_lifecycle ON scan_targets(lifecycle_state, lifecycle_changed_at)`,
    `CREATE TABLE IF NOT EXISTS coming_soon_watchlist (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       tenant_id INTEGER NOT NULL,
       scan_target_id INTEGER NOT NULL UNIQUE,
       address_key TEXT NOT NULL,
       first_seen_at INTEGER NOT NULL,
       last_checked_at INTEGER,
       estimated_completion TEXT,
       source TEXT,
       confidence TEXT,
       cluster_id TEXT,
       status TEXT NOT NULL DEFAULT 'active',
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_coming_soon_watch_tenant ON coming_soon_watchlist(tenant_id, status, last_checked_at)`,
    `CREATE INDEX IF NOT EXISTS idx_coming_soon_watch_due ON coming_soon_watchlist(status, last_checked_at)`,
  ]) {
    try { rawDb.exec(ddl); } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!msg.includes("duplicate column") && !msg.includes("already exists")) throw e;
    }
  }
  _lifecycleSchemaReady = true;
}
/** Test hook: a new DATA_DIR in the same process must re-ensure the schema. */
export function __resetLifecycleSchemaCache(): void { _lifecycleSchemaReady = false; }

// Informational dedup/debug key for watchlist rows. The REAL dedup key is the
// UNIQUE scan_target_id; this stays a simple local canonicalization on purpose —
// importing scanner.ts's normalizeKineticAddressKey here would drag the whole
// live provider transport (queues, coordinator) into the snapshot writer's
// import graph.
function watchAddressKey(address: string, city: string, state: string, zip: string): string {
  const part = (v: string) => upper(v).replace(/[^A-Z0-9#]+/g, " ").trim().replace(/\s+/g, " ");
  return [part(address), part(city), part(state), String(zip ?? "").match(/\d{5}/)?.[0] ?? ""].join("|");
}

function applyConclusiveLifecycle(s: AvailabilitySnapshotInput, epoch: number): void {
  // NEVER from a transport failure / inconclusive check: those carry no
  // serviceability signal (conclusive=0, fiberAvailable=null by construction in
  // both writers).
  if (!s.conclusive || s.fiberAvailable == null) return;
  try {
    ensureLifecycleSchema();
    const target = rawDb.prepare(
      `SELECT id, address, city, state, zip, source, lifecycle_state, lifecycle_changed_at
         FROM scan_targets WHERE id = ?`,
    ).get(s.scanTargetId) as {
      id: number; address: string; city: string; state: string; zip: string | null;
      source: string | null; lifecycle_state: LifecycleState | null; lifecycle_changed_at: number | null;
    } | undefined;
    if (!target) return;
    // Out-of-order historical evidence (e.g. a backfilled legacy baseline older
    // than the last lifecycle write) never regresses the current state.
    if (target.lifecycle_changed_at != null && epoch < target.lifecycle_changed_at) return;

    const sig = lifecycleSignalOf(s);
    const next = nextLifecycleState(target.lifecycle_state ?? null, sig);
    if (next) {
      // Same-state writes still bump lifecycle_changed_at: reaching one of the
      // four definite branches IS a re-affirmation (this is what keeps a
      // re-confirmed STILL_FRESH from aging). The carry-forward branch (null)
      // deliberately does not — e.g. a billing flip to active service neither
      // re-affirms nor clears FRESH_LEAD, so it ages out on schedule.
      rawDb.prepare(`UPDATE scan_targets SET lifecycle_state=?, lifecycle_changed_at=? WHERE id=?`)
        .run(next, epoch, target.id);
    }

    // ── Coming-Soon watchlist bookkeeping (same conclusive-only guarantees) ──
    if (sig.comingSoon) {
      rawDb.prepare(
        `INSERT INTO coming_soon_watchlist
           (tenant_id, scan_target_id, address_key, first_seen_at, last_checked_at,
            estimated_completion, source, confidence, cluster_id, status, created_at, updated_at)
         VALUES (@tenant, @target, @key, @now, @now, NULL, @source, @confidence, NULL, 'active', @now, @now)
         ON CONFLICT(scan_target_id) DO UPDATE SET
           last_checked_at = @now,
           updated_at      = @now,          -- updated_at = last coming-soon AFFIRMATION (drives expiry)
           status          = 'active',      -- a re-observed coming-soon revives an expired/promoted watch
           confidence      = @confidence,
           source          = COALESCE(coming_soon_watchlist.source, @source)`,
      ).run({
        tenant: Number(s.tenantId),
        target: target.id,
        key: watchAddressKey(target.address, target.city, target.state, target.zip ?? ""),
        now: epoch,
        // Provenance of the ADDRESS (scan_targets.source, e.g. 'new_build' from
        // the radar) — the watch cadence keys off it. estimated_completion stays
        // NULL here: the provider Search response carries no completion date;
        // the watchlist tick backfills it from kinetic_addresses when the
        // radar/inventory actually knows one.
        source: target.source ?? s.apiSource ?? "scan",
        // Explicit pre-launch segment > inferred (NEW FIBER + active billing).
        confidence: COMING_SOON_SEGMENT_RE.test(upper(s.householdSegmentType)) ? "high" : "medium",
      });
    } else {
      // Any other conclusive answer on a watched address refreshes the recheck
      // clock; a conclusive LIVE answer promotes the watch. Lead creation +
      // cluster fan-out stay owned by the projector/expansion — not duplicated.
      rawDb.prepare(
        `UPDATE coming_soon_watchlist SET last_checked_at=? WHERE scan_target_id=? AND status='active'`,
      ).run(epoch, target.id);
      if (sig.fiberAvailable) {
        rawDb.prepare(
          `UPDATE coming_soon_watchlist SET status='promoted', updated_at=? WHERE scan_target_id=? AND status='active'`,
        ).run(epoch, target.id);
      }
    }
  } catch (error: any) {
    // Lifecycle bookkeeping must never break the snapshot write (the money
    // path). Loud, but non-fatal.
    console.warn(
      `[lifecycle] update failed for target ${s.scanTargetId}: ${String(error?.message ?? error)}`,
    );
  }
}
