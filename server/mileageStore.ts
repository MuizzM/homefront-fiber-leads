// ── Mileage store — the durable side of shared/mileage.ts ───────────────────
//
// The decisions are pure and live in shared/mileage.ts. This file owns the
// rows, the timestamps, the tenant walls, and the two rules that only a
// database can actually enforce:
//
//   1. an APPROVED trip's numbers never change — the UPDATE path refuses, and a
//      correction becomes an append-only `mileage_adjustments` row (the same
//      shape `punch_corrections` uses for recorded time, for the same reason:
//      a manager fixing a mistake must leave the original visible);
//   2. a trip cannot be submitted twice into the same money — the reimbursement
//      is recomputed and FROZEN at approval, from the rate effective on the
//      trip date, so a later rate change cannot re-price an approved trip.
//
// ── THE MONEY IS GATED ──────────────────────────────────────────────────────
// `mileage.reimbursement_enabled` defaults to OFF for every org. With it off,
// trips are logged, reviewed, approved and exported — and nothing reaches a
// statement or a payout. This is deliberate: the contractor agreements in
// server/onboardingAgreementTemplates.ts currently state that no expense
// reimbursement is provided, so paying mileage against a rep who signed one
// would contradict their own agreement. The flag is the seam where an operator
// turns the money on AFTER re-issuing the agreement, and nothing before that
// point moves a cent.

import { rawDb } from "./db";
import { emit } from "./domainEventStore";
import { recordMileage } from "./earningsLedgerStore";
import {
  canMileageTransition, isMileageLocked, reimbursementCents, resolveRateForDate,
  findDuplicateTrips, validateTrip, isGpsPolicy,
  type MileageRate, type MileageStatus, type MileageSource, type TripFingerprint,
  type GpsPolicy,
} from "@shared/mileage";

const REIMBURSEMENT_FLAG = "mileage.reimbursement_enabled";
const GPS_POLICY_SETTING = "mileage.gps_policy";

export function ensureMileageSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS mileage_trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      rep_id INTEGER NOT NULL,               -- team_members.id (who gets paid)
      user_id INTEGER,                       -- users.id (who logged it)
      trip_date TEXT NOT NULL,               -- YYYY-MM-DD, org-local
      start_location TEXT,
      end_location TEXT,
      start_latitude REAL,
      start_longitude REAL,
      end_latitude REAL,
      end_longitude REAL,
      -- Integer hundredths of a mile. Never a float: a report has to re-sum to
      -- its own total, and 0.1 + 0.2 does not.
      miles_hundredths INTEGER NOT NULL DEFAULT 0,
      distance_method TEXT NOT NULL DEFAULT 'MANUAL',  -- ROUTED|STRAIGHT_LINE|MANUAL
      purpose TEXT,
      customer_or_lead_id INTEGER,
      territory_id INTEGER,
      vehicle_id INTEGER,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'MANUAL',  -- MANUAL|GPS|IMPORT
      status TEXT NOT NULL DEFAULT 'DRAFT',
      -- FROZEN AT APPROVAL, from the rate effective on trip_date. Null until
      -- then, so a pending trip never displays a number an org has not agreed to.
      rate_millicents_per_mile INTEGER,
      reimbursement_cents INTEGER,
      rate_id INTEGER,
      -- GPS flow: an open trip has started_at set and ended_at null.
      started_at TEXT,
      ended_at TEXT,
      submitted_at TEXT,
      approved_by INTEGER,
      approved_at TEXT,
      rejected_by INTEGER,
      rejected_at TEXT,
      rejection_reason TEXT,
      paid_at TEXT,
      -- The rep acknowledged a duplicate warning for this trip. Recorded rather
      -- than enforced: a same route twice in a day is legitimate, and refusing
      -- it teaches people to fudge the address.
      duplicate_ack INTEGER NOT NULL DEFAULT 0,
      -- Per-tenant idempotency for the offline queue, exactly like knock_log's
      -- client_id: a retried flush returns the existing trip.
      client_id TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mileage_rep_date
      ON mileage_trips(tenant_id, rep_id, trip_date, status);
    CREATE INDEX IF NOT EXISTS idx_mileage_queue
      ON mileage_trips(tenant_id, status, trip_date);
    CREATE INDEX IF NOT EXISTS idx_mileage_territory
      ON mileage_trips(tenant_id, territory_id, trip_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mileage_client_id
      ON mileage_trips(tenant_id, client_id) WHERE client_id IS NOT NULL;
    -- At most ONE open GPS trip per rep. Two "start trip" taps racing would
    -- otherwise both succeed and the rep would end the wrong one.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mileage_one_open
      ON mileage_trips(tenant_id, rep_id) WHERE ended_at IS NULL AND started_at IS NOT NULL AND deleted_at IS NULL;

    -- Append-only corrections against a LOCKED trip. Signed miles and signed
    -- cents so a correction can go either way.
    CREATE TABLE IF NOT EXISTS mileage_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      trip_id INTEGER NOT NULL,
      rep_id INTEGER NOT NULL,
      miles_hundredths_delta INTEGER NOT NULL DEFAULT 0,
      cents_delta INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      actor_user_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mileage_adj_trip ON mileage_adjustments(tenant_id, trip_id);
    CREATE INDEX IF NOT EXISTS idx_mileage_adj_rep ON mileage_adjustments(tenant_id, rep_id, created_at);

    -- Effective-dated org rates. NEVER edited — a new figure is a new row.
    CREATE TABLE IF NOT EXISTS mileage_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      rate_millicents_per_mile INTEGER NOT NULL,
      effective_from TEXT NOT NULL,          -- YYYY-MM-DD, inclusive
      note TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mileage_rate_from
      ON mileage_rates(tenant_id, effective_from);

    -- Location consent. Two flags because they are two consents: agreeing to
    -- have a trip measured is not agreeing to be followed all day.
    CREATE TABLE IF NOT EXISTS mileage_location_consent (
      user_id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      disclosure_accepted_at TEXT,
      disclosure_version TEXT,
      background_opt_in INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      -- An admin has pinned this worker's setting. A pin FREEZES; it never
      -- grants — see applyConsentLock in shared/mileage.ts.
      admin_locked INTEGER NOT NULL DEFAULT 0,
      locked_by INTEGER,
      locked_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mileage_vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      rep_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      make TEXT, model TEXT, year INTEGER, plate_last4 TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mileage_vehicles_rep ON mileage_vehicles(tenant_id, rep_id, active);
  `);

  // The admin-lock columns arrive as guarded ALTERs for databases that already
  // have the consent table from before locking existed.
  for (const [name, type] of [
    ["admin_locked", "INTEGER NOT NULL DEFAULT 0"],
    ["locked_by", "INTEGER"],
    ["locked_at", "TEXT"],
  ] as const) {
    try { rawDb.exec(`ALTER TABLE mileage_location_consent ADD COLUMN ${name} ${type}`); }
    catch (e: any) { if (!/duplicate column/i.test(e?.message ?? "")) throw e; }
  }

  // Corrections are evidence. Editing or deleting one would defeat the entire
  // point of routing post-approval changes through this table.
  rawDb.exec(`
    CREATE TRIGGER IF NOT EXISTS mileage_adjustments_no_update
      BEFORE UPDATE ON mileage_adjustments
      BEGIN SELECT RAISE(ABORT, 'mileage_adjustments is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS mileage_adjustments_no_delete
      BEFORE DELETE ON mileage_adjustments
      BEGIN SELECT RAISE(ABORT, 'mileage_adjustments is append-only'); END;
    -- A rate row is a historical fact about what an org agreed to pay. Changing
    -- one silently re-prices every report that cited it.
    CREATE TRIGGER IF NOT EXISTS mileage_rates_no_update
      BEFORE UPDATE ON mileage_rates
      BEGIN SELECT RAISE(ABORT, 'mileage_rates is append-only; add a new effective-dated row'); END;
  `);
}
ensureMileageSchema();

// ── Types ───────────────────────────────────────────────────────────────────

export interface MileageTrip {
  id: number;
  tenantId: number;
  repId: number;
  userId: number | null;
  tripDate: string;
  startLocation: string | null;
  endLocation: string | null;
  startLatitude: number | null;
  startLongitude: number | null;
  endLatitude: number | null;
  endLongitude: number | null;
  milesHundredths: number;
  distanceMethod: string;
  purpose: string | null;
  customerOrLeadId: number | null;
  territoryId: number | null;
  vehicleId: number | null;
  notes: string | null;
  source: MileageSource;
  status: MileageStatus;
  rateMilliCentsPerMile: number | null;
  reimbursementCents: number | null;
  startedAt: string | null;
  endedAt: string | null;
  submittedAt: string | null;
  approvedBy: number | null;
  approvedAt: string | null;
  rejectedBy: number | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  paidAt: string | null;
  duplicateAck: boolean;
  clientId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Net of append-only adjustments — what the trip is actually worth now. */
  adjustmentCents: number;
  adjustmentMilesHundredths: number;
}

function mapTrip(r: any): MileageTrip | null {
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenant_id, repId: r.rep_id, userId: r.user_id ?? null,
    tripDate: r.trip_date,
    startLocation: r.start_location ?? null, endLocation: r.end_location ?? null,
    startLatitude: r.start_latitude ?? null, startLongitude: r.start_longitude ?? null,
    endLatitude: r.end_latitude ?? null, endLongitude: r.end_longitude ?? null,
    milesHundredths: r.miles_hundredths ?? 0,
    distanceMethod: r.distance_method ?? "MANUAL",
    purpose: r.purpose ?? null,
    customerOrLeadId: r.customer_or_lead_id ?? null,
    territoryId: r.territory_id ?? null,
    vehicleId: r.vehicle_id ?? null,
    notes: r.notes ?? null,
    source: (r.source ?? "MANUAL") as MileageSource,
    status: (r.status ?? "DRAFT") as MileageStatus,
    rateMilliCentsPerMile: r.rate_millicents_per_mile ?? null,
    reimbursementCents: r.reimbursement_cents ?? null,
    startedAt: r.started_at ?? null, endedAt: r.ended_at ?? null,
    submittedAt: r.submitted_at ?? null,
    approvedBy: r.approved_by ?? null, approvedAt: r.approved_at ?? null,
    rejectedBy: r.rejected_by ?? null, rejectedAt: r.rejected_at ?? null,
    rejectionReason: r.rejection_reason ?? null,
    paidAt: r.paid_at ?? null,
    duplicateAck: !!r.duplicate_ack,
    clientId: r.client_id ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    adjustmentCents: r.adjustment_cents ?? 0,
    adjustmentMilesHundredths: r.adjustment_miles ?? 0,
  };
}

/** Every read joins the adjustment totals so no caller can accidentally show a
 *  pre-correction number. */
const TRIP_SELECT = `
  SELECT t.*,
    COALESCE((SELECT SUM(cents_delta) FROM mileage_adjustments a WHERE a.trip_id = t.id), 0) AS adjustment_cents,
    COALESCE((SELECT SUM(miles_hundredths_delta) FROM mileage_adjustments a WHERE a.trip_id = t.id), 0) AS adjustment_miles
  FROM mileage_trips t`;

// ── Org configuration ───────────────────────────────────────────────────────

/** Is mileage MONEY switched on for this org? Off by default, everywhere. */
export function reimbursementEnabled(tenantId: number): boolean {
  const row = rawDb.prepare(
    `SELECT value FROM app_settings WHERE tenant_id = ? AND key = ? LIMIT 1`,
  ).get(tenantId, REIMBURSEMENT_FLAG) as { value: string } | undefined;
  return row?.value === "1";
}

export function setReimbursementEnabled(tenantId: number, on: boolean, nowIso: string): void {
  rawDb.prepare(
    `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(tenantId, REIMBURSEMENT_FLAG, on ? "1" : "0", nowIso);
}

export function listRates(tenantId: number): MileageRate[] {
  const rows = rawDb.prepare(
    `SELECT id, tenant_id, rate_millicents_per_mile, effective_from, note
       FROM mileage_rates WHERE tenant_id = ? ORDER BY effective_from DESC, id DESC`,
  ).all(tenantId) as any[];
  return rows.map(r => ({
    id: r.id, tenantId: r.tenant_id,
    rateMilliCentsPerMile: r.rate_millicents_per_mile,
    effectiveFrom: r.effective_from, note: r.note ?? null,
  }));
}

/**
 * Add a rate effective from a date. Same-date re-entry REPLACES that date's row
 * (delete + insert, since the table refuses UPDATE) so a typo caught the same
 * afternoon is fixable — but a rate on a DIFFERENT date is always a new row and
 * never touches history.
 */
export function addRate(p: {
  tenantId: number; rateMilliCentsPerMile: number; effectiveFrom: string;
  note?: string | null; createdBy?: number | null; nowIso: string;
}): MileageRate {
  const tx = rawDb.transaction(() => {
    rawDb.prepare(`DELETE FROM mileage_rates WHERE tenant_id = ? AND effective_from = ?`)
      .run(p.tenantId, p.effectiveFrom);
    rawDb.prepare(
      `INSERT INTO mileage_rates (tenant_id, rate_millicents_per_mile, effective_from, note, created_by, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(p.tenantId, Math.trunc(p.rateMilliCentsPerMile), p.effectiveFrom, p.note ?? null, p.createdBy ?? null, p.nowIso);
  });
  tx();
  return listRates(p.tenantId).find(r => r.effectiveFrom === p.effectiveFrom)!;
}

/** The rate that governs a trip on this date, or null when none is configured. */
export function rateForDate(tenantId: number, tripDate: string): MileageRate | null {
  return resolveRateForDate(listRates(tenantId), tripDate);
}

// ── Consent ─────────────────────────────────────────────────────────────────

export function getConsent(tenantId: number, userId: number) {
  const r = rawDb.prepare(
    `SELECT * FROM mileage_location_consent WHERE user_id = ? AND tenant_id = ?`,
  ).get(userId, tenantId) as any;
  return {
    disclosureAcceptedAt: r && !r.revoked_at ? (r.disclosure_accepted_at ?? null) : null,
    disclosureVersion: r?.disclosure_version ?? null,
    backgroundOptIn: !!r && !r.revoked_at && !!r.background_opt_in,
    revokedAt: r?.revoked_at ?? null,
    adminLocked: !!r?.admin_locked,
    lockedAt: r?.locked_at ?? null,
  };
}

// ── The org-level GPS switch ────────────────────────────────────────────────

/** REP_CHOICE unless an admin has locked GPS off for the whole org. */
export function getGpsPolicy(tenantId: number): GpsPolicy {
  const row = rawDb.prepare(
    `SELECT value FROM app_settings WHERE tenant_id = ? AND key = ? LIMIT 1`,
  ).get(tenantId, GPS_POLICY_SETTING) as { value: string } | undefined;
  return isGpsPolicy(row?.value) ? row!.value as GpsPolicy : "REP_CHOICE";
}

export function setGpsPolicy(tenantId: number, policy: GpsPolicy, nowIso: string): void {
  if (!isGpsPolicy(policy)) throw new Error("MILEAGE_INVALID_GPS_POLICY");
  rawDb.prepare(
    `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(tenantId, GPS_POLICY_SETTING, policy, nowIso);
}

/**
 * Pin or release ONE worker's tracking setting.
 *
 * Locking never turns tracking on. A worker who has not accepted the disclosure
 * stays off, locked at off — an administrator cannot consent on someone else's
 * behalf, and a lock that could would make the disclosure they were shown false.
 */
export function setConsentLock(p: {
  tenantId: number; userId: number; locked: boolean; actorUserId: number; nowIso: string;
}): void {
  const existing = rawDb.prepare(
    `SELECT 1 FROM mileage_location_consent WHERE user_id = ? AND tenant_id = ?`,
  ).get(p.userId, p.tenantId);
  if (!existing) {
    // Locking someone who has never answered the disclosure creates the row at
    // OFF — pinned, and pinned off.
    rawDb.prepare(
      `INSERT INTO mileage_location_consent
         (user_id, tenant_id, disclosure_accepted_at, background_opt_in, admin_locked, locked_by, locked_at, updated_at)
       VALUES (?,?,NULL,0,?,?,?,?)`,
    ).run(p.userId, p.tenantId, p.locked ? 1 : 0, p.locked ? p.actorUserId : null, p.locked ? p.nowIso : null, p.nowIso);
    return;
  }
  rawDb.prepare(
    `UPDATE mileage_location_consent
        SET admin_locked = ?, locked_by = ?, locked_at = ?, updated_at = ?
      WHERE user_id = ? AND tenant_id = ?`,
  ).run(
    p.locked ? 1 : 0, p.locked ? p.actorUserId : null, p.locked ? p.nowIso : null,
    p.nowIso, p.userId, p.tenantId,
  );
}

/** Record consent. Revoking clears BOTH flags — a worker withdrawing permission
 *  must not be left with background sampling still notionally allowed. */
export function setConsent(p: {
  tenantId: number; userId: number; accepted: boolean;
  backgroundOptIn: boolean; version: string; nowIso: string;
}): void {
  // A pinned setting, or an org that has switched GPS off, is not the worker's
  // to change. Checked here rather than only at the route so no future caller
  // can write past the lock.
  const current = getConsent(p.tenantId, p.userId);
  if (current.adminLocked) throw new Error("MILEAGE_CONSENT_LOCKED");
  if (getGpsPolicy(p.tenantId) === "LOCKED_OFF" && p.accepted) {
    throw new Error("MILEAGE_GPS_LOCKED_OFF");
  }
  rawDb.prepare(
    `INSERT INTO mileage_location_consent
       (user_id, tenant_id, disclosure_accepted_at, disclosure_version, background_opt_in, revoked_at, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       disclosure_accepted_at = excluded.disclosure_accepted_at,
       disclosure_version = excluded.disclosure_version,
       background_opt_in = excluded.background_opt_in,
       revoked_at = excluded.revoked_at,
       updated_at = excluded.updated_at`,
  ).run(
    p.userId, p.tenantId,
    p.accepted ? p.nowIso : null, p.accepted ? p.version : null,
    p.accepted && p.backgroundOptIn ? 1 : 0,
    p.accepted ? null : p.nowIso,
    p.nowIso,
  );
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function getTrip(tenantId: number, id: number): MileageTrip | null {
  return mapTrip(rawDb.prepare(
    `${TRIP_SELECT} WHERE t.tenant_id = ? AND t.id = ? AND t.deleted_at IS NULL`,
  ).get(tenantId, id));
}

export interface TripQuery {
  repIds?: number[] | null;
  status?: MileageStatus | null;
  from?: string | null;
  to?: string | null;
  territoryId?: number | null;
  limit?: number;
  offset?: number;
}

export function listTrips(tenantId: number, q: TripQuery = {}): MileageTrip[] {
  const where: string[] = ["t.tenant_id = ?", "t.deleted_at IS NULL"];
  const params: any[] = [tenantId];

  // An EMPTY scope means "no reps in scope" and must return nothing — not
  // "unscoped". Getting this backwards is how a rep sees the whole org.
  if (q.repIds) {
    if (q.repIds.length === 0) return [];
    where.push(`t.rep_id IN (${q.repIds.map(() => "?").join(",")})`);
    params.push(...q.repIds);
  }
  if (q.status) { where.push("t.status = ?"); params.push(q.status); }
  if (q.from) { where.push("t.trip_date >= ?"); params.push(q.from); }
  if (q.to) { where.push("t.trip_date <= ?"); params.push(q.to); }
  if (q.territoryId != null) { where.push("t.territory_id = ?"); params.push(q.territoryId); }

  const limit = Math.max(1, Math.min(5000, q.limit ?? 200));
  const offset = Math.max(0, q.offset ?? 0);
  const rows = rawDb.prepare(
    `${TRIP_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY t.trip_date DESC, t.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset);
  return rows.map(mapTrip).filter((t): t is MileageTrip => t != null);
}

/** The rep's currently-open GPS trip, if any. */
export function openTripFor(tenantId: number, repId: number): MileageTrip | null {
  return mapTrip(rawDb.prepare(
    `${TRIP_SELECT} WHERE t.tenant_id = ? AND t.rep_id = ?
       AND t.started_at IS NOT NULL AND t.ended_at IS NULL AND t.deleted_at IS NULL`,
  ).get(tenantId, repId));
}

/** Same-day trips for the duplicate check — deliberately excludes rejected and
 *  deleted rows, which are not competing claims. */
export function sameDayFingerprints(tenantId: number, repId: number, tripDate: string): TripFingerprint[] {
  const rows = rawDb.prepare(
    `SELECT id, trip_date, start_location, end_location,
            start_latitude, start_longitude, end_latitude, end_longitude, miles_hundredths
       FROM mileage_trips
      WHERE tenant_id = ? AND rep_id = ? AND trip_date = ?
        AND status != 'REJECTED' AND deleted_at IS NULL`,
  ).all(tenantId, repId, tripDate) as any[];
  return rows.map(r => ({
    id: r.id, tripDate: r.trip_date,
    startLocation: r.start_location, endLocation: r.end_location,
    startLat: r.start_latitude, startLng: r.start_longitude,
    endLat: r.end_latitude, endLng: r.end_longitude,
    milesHundredths: r.miles_hundredths,
  }));
}

export function duplicatesFor(tenantId: number, repId: number, candidate: TripFingerprint): TripFingerprint[] {
  return findDuplicateTrips(candidate, sameDayFingerprints(tenantId, repId, candidate.tripDate));
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface CreateTripInput {
  tenantId: number; repId: number; userId?: number | null;
  tripDate: string;
  startLocation?: string | null; endLocation?: string | null;
  startLatitude?: number | null; startLongitude?: number | null;
  endLatitude?: number | null; endLongitude?: number | null;
  milesHundredths: number;
  distanceMethod?: string;
  purpose?: string | null;
  customerOrLeadId?: number | null;
  territoryId?: number | null;
  vehicleId?: number | null;
  notes?: string | null;
  source?: MileageSource;
  clientId?: string | null;
  duplicateAck?: boolean;
  startedAt?: string | null;
  status?: MileageStatus;
  nowIso: string;
  todayIso: string;
}

export function createTrip(input: CreateTripInput): MileageTrip {
  const source = input.source ?? "MANUAL";

  // A GPS trip is created OPEN — it has no distance and no end yet, so the
  // shared validator (which requires both) would reject something perfectly
  // valid. Open trips are validated when they end.
  const isOpenGps = !!input.startedAt && input.milesHundredths === 0;
  if (!isOpenGps) {
    const problems = validateTrip({
      tripDate: input.tripDate,
      startLocation: input.startLocation ?? null,
      endLocation: input.endLocation ?? null,
      milesHundredths: input.milesHundredths,
      purpose: input.purpose ?? null,
      source,
    }, input.todayIso);
    if (problems.length > 0) throw new Error(`INVALID_TRIP:${problems.join("; ")}`);
  }

  // Offline replay: the same clientId returns the existing trip rather than a
  // second one, matching knock_log's idempotency contract.
  if (input.clientId) {
    const existing = mapTrip(rawDb.prepare(
      `${TRIP_SELECT} WHERE t.tenant_id = ? AND t.client_id = ?`,
    ).get(input.tenantId, input.clientId));
    if (existing) return existing;
  }

  const info = rawDb.prepare(
    `INSERT INTO mileage_trips
       (tenant_id, rep_id, user_id, trip_date, start_location, end_location,
        start_latitude, start_longitude, end_latitude, end_longitude,
        miles_hundredths, distance_method, purpose, customer_or_lead_id, territory_id,
        vehicle_id, notes, source, status, started_at, duplicate_ack, client_id,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.tenantId, input.repId, input.userId ?? null, input.tripDate,
    input.startLocation ?? null, input.endLocation ?? null,
    input.startLatitude ?? null, input.startLongitude ?? null,
    input.endLatitude ?? null, input.endLongitude ?? null,
    Math.trunc(input.milesHundredths || 0), input.distanceMethod ?? "MANUAL",
    input.purpose ?? null, input.customerOrLeadId ?? null, input.territoryId ?? null,
    input.vehicleId ?? null, input.notes ?? null, source,
    input.status ?? "DRAFT", input.startedAt ?? null,
    input.duplicateAck ? 1 : 0, input.clientId ?? null,
    input.nowIso, input.nowIso,
  );
  return getTrip(input.tenantId, Number(info.lastInsertRowid))!;
}

export interface PatchTripInput {
  startLocation?: string | null; endLocation?: string | null;
  milesHundredths?: number;
  purpose?: string | null;
  customerOrLeadId?: number | null;
  territoryId?: number | null;
  vehicleId?: number | null;
  notes?: string | null;
  duplicateAck?: boolean;
}

/**
 * Edit an UNLOCKED trip. An APPROVED or PAID trip throws `MILEAGE_LOCKED` —
 * the caller's recourse is `addAdjustment`, which leaves the original intact.
 */
export function patchTrip(
  tenantId: number, id: number, patch: PatchTripInput, nowIso: string,
): MileageTrip {
  const trip = getTrip(tenantId, id);
  if (!trip) throw new Error("MILEAGE_TRIP_NOT_FOUND");
  if (isMileageLocked(trip.status)) throw new Error("MILEAGE_LOCKED");

  const sets: string[] = [];
  const params: any[] = [];
  const set = (col: string, v: any) => { sets.push(`${col} = ?`); params.push(v); };

  if (patch.startLocation !== undefined) set("start_location", patch.startLocation);
  if (patch.endLocation !== undefined) set("end_location", patch.endLocation);
  if (patch.milesHundredths !== undefined) set("miles_hundredths", Math.trunc(patch.milesHundredths));
  if (patch.purpose !== undefined) set("purpose", patch.purpose);
  if (patch.customerOrLeadId !== undefined) set("customer_or_lead_id", patch.customerOrLeadId);
  if (patch.territoryId !== undefined) set("territory_id", patch.territoryId);
  if (patch.vehicleId !== undefined) set("vehicle_id", patch.vehicleId);
  if (patch.notes !== undefined) set("notes", patch.notes);
  if (patch.duplicateAck !== undefined) set("duplicate_ack", patch.duplicateAck ? 1 : 0);
  if (sets.length === 0) return trip;

  set("updated_at", nowIso);
  rawDb.prepare(
    `UPDATE mileage_trips SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`,
  ).run(...params, tenantId, id);
  return getTrip(tenantId, id)!;
}

/** End an open GPS trip: stamp the endpoint and the resolved distance. */
export function endTrip(p: {
  tenantId: number; id: number;
  endLatitude?: number | null; endLongitude?: number | null;
  endLocation?: string | null;
  milesHundredths: number; distanceMethod: string;
  nowIso: string;
}): MileageTrip {
  const trip = getTrip(p.tenantId, p.id);
  if (!trip) throw new Error("MILEAGE_TRIP_NOT_FOUND");
  if (isMileageLocked(trip.status)) throw new Error("MILEAGE_LOCKED");
  if (!trip.startedAt) throw new Error("MILEAGE_TRIP_NOT_OPEN");
  if (trip.endedAt) throw new Error("MILEAGE_TRIP_ALREADY_ENDED");

  rawDb.prepare(
    `UPDATE mileage_trips
        SET ended_at = ?, end_latitude = ?, end_longitude = ?, end_location = COALESCE(?, end_location),
            miles_hundredths = ?, distance_method = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?`,
  ).run(
    p.nowIso, p.endLatitude ?? null, p.endLongitude ?? null, p.endLocation ?? null,
    Math.trunc(p.milesHundredths), p.distanceMethod, p.nowIso, p.tenantId, p.id,
  );
  return getTrip(p.tenantId, p.id)!;
}

/**
 * Move a trip through the status machine.
 *
 * Approval is where money is FROZEN: the rate effective on the trip DATE (not
 * today) is resolved once and written onto the row alongside the computed
 * cents. A later rate change therefore cannot re-price an approved trip, which
 * is the same historical-accuracy rule the commission statements enforce.
 *
 * Every transition runs inside a transaction with its domain event, so a trip
 * can never be approved without the event that may pay it — or vice versa.
 */
export function transitionTrip(p: {
  tenantId: number; id: number; to: MileageStatus;
  actorUserId?: number | null; reason?: string | null;
  nowIso: string;
  /** Attempt number, so a resubmission after a rejection is a distinct event. */
  submitAttempt?: number;
}): MileageTrip {
  const trip = getTrip(p.tenantId, p.id);
  if (!trip) throw new Error("MILEAGE_TRIP_NOT_FOUND");
  if (!canMileageTransition(trip.status, p.to)) {
    throw new Error(`MILEAGE_BAD_TRANSITION:${trip.status}->${p.to}`);
  }
  if (p.to === "SUBMITTED" && trip.milesHundredths <= 0) {
    throw new Error("MILEAGE_NO_DISTANCE");
  }

  const tx = rawDb.transaction(() => {
    if (p.to === "SUBMITTED") {
      rawDb.prepare(
        `UPDATE mileage_trips SET status = 'SUBMITTED', submitted_at = ?,
           rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      ).run(p.nowIso, p.nowIso, p.tenantId, p.id);

      emit({
        tenantId: p.tenantId, type: "MILEAGE_SUBMITTED",
        subjectType: "mileage_trip", subjectId: p.id, subjectRepId: trip.repId,
        actorUserId: p.actorUserId ?? null, occurredAt: p.nowIso,
        payload: { milesHundredths: trip.milesHundredths, tripDate: trip.tripDate },
        // A resubmission after a rejection is a NEW fact, so the key carries the
        // attempt. Without it the second submission would silently collapse into
        // the first and never reach the approval queue's event consumers.
        dedupeKey: `MILEAGE_SUBMITTED:trip:${p.id}:attempt:${p.submitAttempt ?? 1}`,
      }, p.nowIso);

    } else if (p.to === "APPROVED") {
      const rate = rateForDate(p.tenantId, trip.tripDate);
      const cents = rate ? reimbursementCents(trip.milesHundredths, rate.rateMilliCentsPerMile) : 0;
      rawDb.prepare(
        `UPDATE mileage_trips
            SET status = 'APPROVED', approved_by = ?, approved_at = ?,
                rate_millicents_per_mile = ?, rate_id = ?, reimbursement_cents = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
      ).run(
        p.actorUserId ?? null, p.nowIso,
        rate?.rateMilliCentsPerMile ?? null, rate?.id ?? null, cents, p.nowIso,
        p.tenantId, p.id,
      );

      // The earnings ledger OWNS mileage money, so the row is written here, in
      // the same transaction as the approval — a trip cannot be approved
      // without its earning, or carry an earning it never got approved for.
      // A zero-value trip (org reimbursement off, or no rate) writes nothing.
      recordMileage({
        tenantId: p.tenantId, repId: trip.repId, tripId: p.id,
        reimbursementCents: reimbursementEnabled(p.tenantId) ? cents : 0,
        milesHundredths: trip.milesHundredths, tripDate: trip.tripDate,
        rateMilliCentsPerMile: rate?.rateMilliCentsPerMile ?? null, nowIso: p.nowIso,
      });

      emit({
        tenantId: p.tenantId, type: "MILEAGE_APPROVED",
        subjectType: "mileage_trip", subjectId: p.id, subjectRepId: trip.repId,
        actorUserId: p.actorUserId ?? null, occurredAt: p.nowIso,
        payload: {
          milesHundredths: trip.milesHundredths,
          reimbursementCents: cents,
          rateMilliCentsPerMile: rate?.rateMilliCentsPerMile ?? null,
          tripDate: trip.tripDate,
          // Recorded on the event so a consumer can tell "approved but the org
          // pays nothing yet" from "approved and payable" without re-reading
          // the flag at consumption time, when it may have changed.
          reimbursementEnabled: reimbursementEnabled(p.tenantId),
        },
      }, p.nowIso);

    } else if (p.to === "REJECTED") {
      rawDb.prepare(
        `UPDATE mileage_trips SET status = 'REJECTED', rejected_by = ?, rejected_at = ?,
           rejection_reason = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
      ).run(p.actorUserId ?? null, p.nowIso, p.reason ?? null, p.nowIso, p.tenantId, p.id);

    } else if (p.to === "PAID") {
      rawDb.prepare(
        `UPDATE mileage_trips SET status = 'PAID', paid_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
      ).run(p.nowIso, p.nowIso, p.tenantId, p.id);

    } else if (p.to === "DRAFT") {
      rawDb.prepare(
        `UPDATE mileage_trips SET status = 'DRAFT', submitted_at = NULL, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
      ).run(p.nowIso, p.tenantId, p.id);
    }
  });
  tx();
  return getTrip(p.tenantId, p.id)!;
}

/**
 * Correct a LOCKED trip without editing it. The delta lands in the append-only
 * adjustments table and every read folds it in.
 *
 * Refuses a zero adjustment: a correction that changes nothing is either a
 * mistake or an attempt to attach a note to a frozen row, and neither should
 * quietly become a ledger entry.
 */
export function addAdjustment(p: {
  tenantId: number; tripId: number;
  milesHundredthsDelta?: number; centsDelta?: number;
  reason: string; actorUserId?: number | null; nowIso: string;
}): MileageTrip {
  const trip = getTrip(p.tenantId, p.tripId);
  if (!trip) throw new Error("MILEAGE_TRIP_NOT_FOUND");
  if (!String(p.reason ?? "").trim()) throw new Error("MILEAGE_ADJUSTMENT_REASON_REQUIRED");

  const miles = Math.trunc(p.milesHundredthsDelta ?? 0);
  let cents = Math.trunc(p.centsDelta ?? 0);

  // A miles-only correction derives its own money from the rate FROZEN on the
  // trip, never from today's rate — the trip was priced once and stays priced.
  if (cents === 0 && miles !== 0 && trip.rateMilliCentsPerMile) {
    cents = reimbursementCents(miles, trip.rateMilliCentsPerMile);
  }
  if (miles === 0 && cents === 0) throw new Error("MILEAGE_ADJUSTMENT_EMPTY");

  rawDb.prepare(
    `INSERT INTO mileage_adjustments
       (tenant_id, trip_id, rep_id, miles_hundredths_delta, cents_delta, reason, actor_user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(p.tenantId, p.tripId, trip.repId, miles, cents, p.reason.trim(), p.actorUserId ?? null, p.nowIso);

  return getTrip(p.tenantId, p.tripId)!;
}

export function listAdjustments(tenantId: number, tripId: number) {
  return rawDb.prepare(
    `SELECT id, miles_hundredths_delta AS milesHundredthsDelta, cents_delta AS centsDelta,
            reason, actor_user_id AS actorUserId, created_at AS createdAt
       FROM mileage_adjustments WHERE tenant_id = ? AND trip_id = ? ORDER BY id ASC`,
  ).all(tenantId, tripId);
}

/** Soft-delete an unlocked trip. A locked trip is never removed — it is money
 *  history — and the caller gets `MILEAGE_LOCKED` instead. */
export function softDeleteTrip(tenantId: number, id: number, nowIso: string): void {
  const trip = getTrip(tenantId, id);
  if (!trip) throw new Error("MILEAGE_TRIP_NOT_FOUND");
  if (isMileageLocked(trip.status)) throw new Error("MILEAGE_LOCKED");
  rawDb.prepare(
    `UPDATE mileage_trips SET deleted_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
  ).run(nowIso, nowIso, tenantId, id);
}

// ── Aggregates ──────────────────────────────────────────────────────────────

/**
 * Approved, unpaid mileage for a rep inside a period — the number the earnings
 * ledger and the statement read.
 *
 * Returns zero when the org has reimbursement switched off, so no caller has to
 * remember the flag and none of them can disagree about it.
 */
export function payableMileageCents(
  tenantId: number, repId: number, fromDate: string, toDate: string,
): { cents: number; milesHundredths: number; tripCount: number } {
  if (!reimbursementEnabled(tenantId)) return { cents: 0, milesHundredths: 0, tripCount: 0 };
  const row = rawDb.prepare(
    `SELECT
       COALESCE(SUM(t.reimbursement_cents), 0)
         + COALESCE(SUM((SELECT COALESCE(SUM(cents_delta),0) FROM mileage_adjustments a WHERE a.trip_id = t.id)), 0) AS cents,
       COALESCE(SUM(t.miles_hundredths), 0)
         + COALESCE(SUM((SELECT COALESCE(SUM(miles_hundredths_delta),0) FROM mileage_adjustments a WHERE a.trip_id = t.id)), 0) AS miles,
       COUNT(*) AS n
     FROM mileage_trips t
     WHERE t.tenant_id = ? AND t.rep_id = ? AND t.status = 'APPROVED'
       AND t.deleted_at IS NULL AND t.trip_date >= ? AND t.trip_date <= ?`,
  ).get(tenantId, repId, fromDate, toDate) as any;
  return { cents: row?.cents ?? 0, milesHundredths: row?.miles ?? 0, tripCount: row?.n ?? 0 };
}

// ── Vehicles ────────────────────────────────────────────────────────────────

export function listVehicles(tenantId: number, repId: number) {
  return rawDb.prepare(
    `SELECT id, label, make, model, year, plate_last4 AS plateLast4, active
       FROM mileage_vehicles WHERE tenant_id = ? AND rep_id = ? AND active = 1 ORDER BY id ASC`,
  ).all(tenantId, repId);
}

export function addVehicle(p: {
  tenantId: number; repId: number; label: string;
  make?: string | null; model?: string | null; year?: number | null;
  plateLast4?: string | null; nowIso: string;
}) {
  const info = rawDb.prepare(
    `INSERT INTO mileage_vehicles (tenant_id, rep_id, label, make, model, year, plate_last4, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(p.tenantId, p.repId, p.label, p.make ?? null, p.model ?? null, p.year ?? null, p.plateLast4 ?? null, p.nowIso);
  return rawDb.prepare(
    `SELECT id, label, make, model, year, plate_last4 AS plateLast4, active
       FROM mileage_vehicles WHERE id = ?`,
  ).get(Number(info.lastInsertRowid));
}

/** The org's commission timezone — the same clock the workweek uses, so a
 *  mileage "today" is the rep's today and not UTC's. Read the way every other
 *  store here reads it (see doorDropStore), since storage has no tenant getter. */
export function orgTimezone(tenantId: number): string {
  try {
    const row = rawDb.prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`).get(tenantId) as any;
    return row?.tz || "America/New_York";
  } catch { return "America/New_York"; }
}

/** Org-wide outstanding mileage liability — the admin dashboard figure. */
export function orgMileageLiability(tenantId: number): { approvedCents: number; pendingTripCount: number } {
  const approved = rawDb.prepare(
    `SELECT COALESCE(SUM(reimbursement_cents), 0) AS c FROM mileage_trips
      WHERE tenant_id = ? AND status = 'APPROVED' AND deleted_at IS NULL`,
  ).get(tenantId) as any;
  const pending = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM mileage_trips
      WHERE tenant_id = ? AND status = 'SUBMITTED' AND deleted_at IS NULL`,
  ).get(tenantId) as any;
  return { approvedCents: approved?.c ?? 0, pendingTripCount: pending?.n ?? 0 };
}
