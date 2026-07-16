import { rawDb } from "./db";

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
  customer_signals,transition_status,fresh,api_source,evidence_hash,fiber_check_id,error,blocked,latency_ms)`;
const VALUES = `(@tenant_id,@scan_target_id,@run_id,@checked_at,@checked_at_epoch,@conclusive,@fiber_available,@fiber_status,
  @max_download_mbps,@service_status,@household_segment_type,@billing_status,@customer_segment,@customer_confidence,
  @customer_signals,@transition_status,@fresh,@api_source,@evidence_hash,@fiber_check_id,@error,@blocked,@latency_ms)`;

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
  };
  const { insert, insertIgnore } = stmts();
  const res = (s.orIgnore ? insertIgnore : insert).run(params);
  return Number(res.lastInsertRowid);
}
