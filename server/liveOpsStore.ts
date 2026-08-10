// ── Live field operations - the write and read paths ─────────────────────────
//
// Every rule that decides whether a rep's position may be recorded lives in
// ONE function here (`trackingGate`), and every write goes through ONE function
// (`ingestFix`). That is deliberate: the existing POST /api/location-pings
// checks tenancy and scope but never asks whether the rep is on shift, whether
// the org switched collection on, or whether the rep has ever been shown a
// disclosure - and a second write path is how those checks get forgotten again.
//
// The gate fails CLOSED on every uncertainty. An unreadable policy row, a
// missing consent row, a tenant that cannot be resolved: all of them mean "do
// not record". The cost of failing closed is a supervisor seeing an empty map;
// the cost of failing open is collecting an employee's movements without
// permission, which is not a bug you can fix after the fact.

import { rawDb } from "./db";
import { storage } from "./storage";
import { orgTimezone } from "./mileageStore";
import { polygonCovers } from "@shared/geo";
import { territoryHeldByAny } from "@shared/territory";
import {
  clampCapturedAt,
  deriveRepStatus,
  isPresentablePosition,
  locationFreshness,
  shouldAcceptFix,
  speedBetween,
  tsMs,
  type FixCandidate,
} from "@shared/repStatus";
import {
  DEFAULT_RETENTION_DAYS,
  FIELD_LOCATION_DISCLOSURE_VERSION,
  LIVE_STATE_ROW_CAP,
  LOCATION_SOURCES,
  MAX_RETENTION_DAYS,
  MIN_INGEST_GAP_MS,
  MIN_RETENTION_DAYS,
  TRACK_HISTORY_ROW_CAP,
  type FieldLocationMode,
  type LocationSource,
  type PresenceRow,
  type RepLiveState,
} from "@shared/liveOps";

// ── Policy ───────────────────────────────────────────────────────────────────

export interface FieldLocationPolicy {
  tenantId: number;
  mode: FieldLocationMode;
  retentionDays: number;
  disclosureVersion: string;
  allowRepPause: boolean;
}

/** The shipped default: collection OFF. An org turns it on deliberately. */
function defaultPolicy(tenantId: number): FieldLocationPolicy {
  return {
    tenantId,
    mode: "off",
    retentionDays: DEFAULT_RETENTION_DAYS,
    disclosureVersion: FIELD_LOCATION_DISCLOSURE_VERSION,
    allowRepPause: true,
  };
}

export function getFieldLocationPolicy(tenantId: number | null | undefined): FieldLocationPolicy {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid)) return defaultPolicy(0);
  try {
    const row = rawDb
      .prepare(
        `SELECT tenant_id AS tenantId, mode, retention_days AS retentionDays,
                disclosure_version AS disclosureVersion, allow_rep_pause AS allowRepPause
           FROM field_location_policy WHERE tenant_id = ?`,
      )
      .get(tid) as any;
    if (!row) return defaultPolicy(tid);
    return {
      tenantId: tid,
      mode: (row.mode ?? "off") as FieldLocationMode,
      retentionDays: clampRetention(row.retentionDays),
      disclosureVersion: row.disclosureVersion || FIELD_LOCATION_DISCLOSURE_VERSION,
      allowRepPause: Number(row.allowRepPause ?? 1) === 1,
    };
  } catch {
    // An unreadable policy is not permission. Fall back to off.
    return defaultPolicy(tid);
  }
}

export function clampRetention(days: unknown): number {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, n));
}

export function setFieldLocationPolicy(
  tenantId: number,
  patch: Partial<Pick<FieldLocationPolicy, "mode" | "retentionDays" | "allowRepPause">>,
  actorUserId: number | null,
): FieldLocationPolicy {
  const current = getFieldLocationPolicy(tenantId);
  const next: FieldLocationPolicy = {
    ...current,
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.retentionDays != null ? { retentionDays: clampRetention(patch.retentionDays) } : {}),
    ...(patch.allowRepPause != null ? { allowRepPause: !!patch.allowRepPause } : {}),
  };
  rawDb
    .prepare(
      `INSERT INTO field_location_policy
         (tenant_id, mode, retention_days, disclosure_version, allow_rep_pause, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(tenant_id) DO UPDATE SET
         mode = excluded.mode,
         retention_days = excluded.retention_days,
         disclosure_version = excluded.disclosure_version,
         allow_rep_pause = excluded.allow_rep_pause,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(
      tenantId, next.mode, next.retentionDays,
      FIELD_LOCATION_DISCLOSURE_VERSION, next.allowRepPause ? 1 : 0, actorUserId ?? null,
    );
  return next;
}

// ── Consent ──────────────────────────────────────────────────────────────────

export interface FieldLocationConsent {
  userId: number;
  disclosureVersion: string | null;
  acknowledgedAt: string | null;
  pausedAt: string | null;
  revokedAt: string | null;
}

export function getFieldLocationConsent(userId: number): FieldLocationConsent | null {
  try {
    const row = rawDb
      .prepare(
        `SELECT user_id AS userId, disclosure_version AS disclosureVersion,
                acknowledged_at AS acknowledgedAt, paused_at AS pausedAt, revoked_at AS revokedAt
           FROM field_location_consent WHERE user_id = ?`,
      )
      .get(userId) as any;
    return row ?? null;
  } catch {
    return null;
  }
}

/** The rep has read the current disclosure. Clears any prior revocation, since
 *  acknowledging again is an affirmative act. */
export function acknowledgeDisclosure(userId: number, tenantId: number | null): FieldLocationConsent {
  rawDb
    .prepare(
      `INSERT INTO field_location_consent
         (user_id, tenant_id, disclosure_version, acknowledged_at, revoked_at, updated_at)
       VALUES (?,?,?,datetime('now'),NULL,datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         disclosure_version = excluded.disclosure_version,
         acknowledged_at = excluded.acknowledged_at,
         revoked_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(userId, tenantId ?? null, FIELD_LOCATION_DISCLOSURE_VERSION);
  return getFieldLocationConsent(userId) as FieldLocationConsent;
}

/** The rep's own pause. Honoured only where org policy allows it - the route
 *  checks that; the gate honours whatever is stored. */
export function setTrackingPause(userId: number, paused: boolean, reason?: string | null): void {
  rawDb
    .prepare(
      `UPDATE field_location_consent
          SET paused_at = ?, paused_reason = ?, updated_at = datetime('now')
        WHERE user_id = ?`,
    )
    .run(paused ? new Date().toISOString() : null, paused ? (reason ?? null) : null, userId);
}

export type GateReason =
  | "ok"
  | "policy-off"
  | "no-tenant"
  | "not-disclosed"
  | "disclosure-outdated"
  | "revoked"
  | "paused"
  | "not-clocked-in";

export interface GateResult { allowed: boolean; reason: GateReason }

/**
 * May this rep's position be recorded right now?
 *
 * Pure, so it can be exhaustively tested without a database, and so the client
 * can be shown the same reason it would be refused for rather than failing
 * silently. Order matters only for which reason is reported; any single failure
 * is enough to refuse.
 */
export function trackingGate(input: {
  policy: FieldLocationPolicy;
  consent: FieldLocationConsent | null;
  clockedIn: boolean;
}): GateResult {
  const { policy, consent, clockedIn } = input;

  if (policy.mode === "off") return { allowed: false, reason: "policy-off" };

  // Disclosure is required even when the org default is ON. "Default on" means
  // the rep does not have to opt in; it does not mean they are not told.
  if (!consent?.acknowledgedAt) return { allowed: false, reason: "not-disclosed" };
  if (consent.disclosureVersion !== FIELD_LOCATION_DISCLOSURE_VERSION) {
    return { allowed: false, reason: "disclosure-outdated" };
  }
  if (consent.revokedAt) return { allowed: false, reason: "revoked" };

  // A pause survives `locked_on`: locking stops a rep DISABLING tracking for the
  // shift, not stepping away for a documented break. Policy controls whether the
  // pause control is offered at all.
  if (consent.pausedAt) return { allowed: false, reason: "paused" };

  // The hard boundary. Off-shift movement is never collected - not filtered on
  // read, never written.
  if (!clockedIn) return { allowed: false, reason: "not-clocked-in" };

  return { allowed: true, reason: "ok" };
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export interface IngestInput {
  repId: number;
  userId: number;
  tenantId: number | null;
  lat: number;
  lng: number;
  accuracyM?: number | null;
  capturedAt?: string | null;
  heading?: number | null;
  source?: LocationSource;
  /** The device said it cannot supply a fix. Recorded as status, not position. */
  locationDenied?: boolean;
  nowMs?: number;
}

export interface IngestResult {
  stored: boolean;
  reason: GateReason | "insignificant" | "too-vague" | "out-of-order" | "rate-limited" | "accepted";
  lowConfidence?: boolean;
}

/**
 * The single write path for a rep's position.
 *
 * Reads the previous fix and then writes, so the transaction is `.immediate()`:
 * a deferred BEGIN would take its snapshot on the read and fail
 * SQLITE_BUSY_SNAPSHOT the instant another connection commits, which
 * busy_timeout does not cover (see tests/unit/deferred-read-write-transactions).
 */
export function ingestFix(input: IngestInput): IngestResult {
  const nowMs = input.nowMs ?? Date.now();
  const policy = getFieldLocationPolicy(input.tenantId);
  const consent = getFieldLocationConsent(input.userId);
  const session = storage.getActiveClockSession(input.repId);
  const gate = trackingGate({ policy, consent, clockedIn: !!session });
  if (!gate.allowed) return { stored: false, reason: gate.reason };

  const source: LocationSource = LOCATION_SOURCES.includes(input.source as LocationSource)
    ? (input.source as LocationSource)
    : "ping";

  const capturedMs = clampCapturedAt(tsMs(input.capturedAt ?? null) ?? nowMs, nowMs) ?? nowMs;
  const next: FixCandidate = {
    lat: input.lat, lng: input.lng,
    accuracyM: input.accuracyM ?? null,
    capturedAtMs: capturedMs,
  };

  const prevRow = rawDb
    .prepare(
      `SELECT lat, lng, accuracy_m AS accuracyM, captured_at AS capturedAt, received_at AS receivedAt
         FROM rep_location_state WHERE rep_id = ?`,
    )
    .get(input.repId) as any;

  const prev: FixCandidate | null = prevRow?.lat != null
    ? {
        lat: prevRow.lat, lng: prevRow.lng,
        accuracyM: prevRow.accuracyM ?? null,
        capturedAtMs: tsMs(prevRow.capturedAt) ?? 0,
      }
    : null;

  // Server-side backstop. A client ignoring every cadence rule still cannot
  // write more often than this, regardless of how far it claims to have moved.
  const lastReceived = tsMs(prevRow?.receivedAt ?? null);
  if (lastReceived != null && nowMs - lastReceived < MIN_INGEST_GAP_MS) {
    return { stored: false, reason: "rate-limited" };
  }

  const decision = shouldAcceptFix(prev, next, { lastGoodAccuracyAtMs: prev?.capturedAtMs ?? null });
  if (!decision.accept) {
    return { stored: false, reason: decision.reason as IngestResult["reason"] };
  }

  const speed = speedBetween(prev, next);
  const territory = resolveTerritory(input.repId, input.tenantId, input.lat, input.lng);
  const lastKnockAt = latestKnockAt(input.repId);
  const status = deriveRepStatus({
    nowMs,
    clockedInAtMs: tsMs(session?.clockedIn ?? null),
    pausedAtMs: tsMs(consent?.pausedAt ?? null),
    lastSeenAtMs: nowMs,
    lastKnockAtMs: tsMs(lastKnockAt),
    capturedAtMs: capturedMs,
    speedMps: speed,
    movedM: null,
    appointmentActive: false,
    locationDenied: !!input.locationDenied,
    trackingPermitted: true,
  });

  const capturedIso = new Date(capturedMs).toISOString();
  const tx = rawDb.transaction(() => {
    rawDb
      .prepare(
        `INSERT INTO location_pings
           (rep_id, user_id, tenant_id, lat, lng, accuracy, ping_at, captured_at,
            source, clock_session_id, speed_mps, heading, low_confidence)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.repId, input.userId, input.tenantId ?? null,
        input.lat, input.lng, input.accuracyM ?? null,
        new Date(nowMs).toISOString(), capturedIso,
        source, session?.id ?? null, speed, input.heading ?? null,
        decision.lowConfidence ? 1 : 0,
      );

    rawDb
      .prepare(
        `INSERT INTO rep_location_state
           (rep_id, tenant_id, user_id, lat, lng, accuracy_m, heading, speed_mps,
            low_confidence, captured_at, received_at, status, status_since,
            clock_session_id, territory_id, outside_territory, last_knock_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
         ON CONFLICT(rep_id) DO UPDATE SET
           tenant_id = excluded.tenant_id, user_id = excluded.user_id,
           lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m,
           heading = excluded.heading, speed_mps = excluded.speed_mps,
           low_confidence = excluded.low_confidence,
           captured_at = excluded.captured_at, received_at = excluded.received_at,
           status = excluded.status, status_since = excluded.status_since,
           clock_session_id = excluded.clock_session_id,
           territory_id = excluded.territory_id,
           outside_territory = excluded.outside_territory,
           last_knock_at = excluded.last_knock_at, updated_at = datetime('now')`,
      )
      .run(
        input.repId, input.tenantId ?? null, input.userId,
        input.lat, input.lng, input.accuracyM ?? null, input.heading ?? null, speed,
        decision.lowConfidence ? 1 : 0, capturedIso, new Date(nowMs).toISOString(),
        status.status, status.sinceMs ? new Date(status.sinceMs).toISOString() : null,
        session?.id ?? null, territory.territoryId, territory.outside ? 1 : 0, lastKnockAt,
      );
  });
  tx.immediate();

  return { stored: true, reason: "accepted", lowConfidence: decision.lowConfidence };
}

/**
 * Stop tracking the moment the shift ends.
 *
 * The live row is dropped rather than marked, so nothing downstream can render
 * an off-shift rep at their last known position. History keeps whatever was
 * lawfully recorded during the shift and ages out on the retention window.
 */
export function clearLiveStateForRep(repId: number): void {
  try {
    rawDb.prepare(`DELETE FROM rep_location_state WHERE rep_id = ?`).run(repId);
  } catch { /* nothing to clear */ }
}

function latestKnockAt(repId: number): string | null {
  try {
    const row = rawDb
      .prepare(`SELECT MAX(knocked_at) AS at FROM knock_log WHERE rep_id = ?`)
      .get(repId) as any;
    return row?.at ?? null;
  } catch { return null; }
}

/** Which of the rep's assigned areas contains this point, and are they outside
 *  every one of them. Bbox-free: a rep holds at most a handful of areas. */
function resolveTerritory(
  repId: number, tenantId: number | null, lat: number, lng: number,
): { territoryId: number | null; outside: boolean } {
  try {
    const rows = rawDb
      .prepare(
        `SELECT id, polygon, rep_id AS repId, assignee_ids AS assigneeIds
           FROM territories
          WHERE (tenant_id = ? OR ? IS NULL) AND status NOT IN ('archived','draft')`,
      )
      .all(tenantId ?? null, tenantId ?? null) as any[];

    // territoryHeldByAny already encodes the multi-assignee rule AND the legacy
    // fallback: a null assignee_ids means "old row, trust rep_id". Re-deriving
    // that here is how the two drift apart.
    const mine = rows.filter((t) => territoryHeldByAny(t, [repId]));
    if (mine.length === 0) return { territoryId: null, outside: false }; // unassigned: not "outside"

    for (const t of mine) {
      let ring: [number, number][] = [];
      try { ring = JSON.parse(t.polygon ?? "[]"); } catch { continue; }
      if (ring.length < 3) continue;
      if (polygonCovers(lat, lng, ring)) return { territoryId: Number(t.id), outside: false };
    }
    return { territoryId: null, outside: true };
  } catch {
    return { territoryId: null, outside: false };
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** `rep_id IN (...)` for a scope array, or an always-true predicate for null. */
function scopeClause(scope: number[] | null, column: string): { sql: string; args: number[] } {
  if (scope === null) return { sql: "1=1", args: [] };
  if (scope.length === 0) return { sql: "1=0", args: [] };
  return { sql: `${column} IN (${scope.map(() => "?").join(",")})`, args: scope };
}

/** Midnight today in the org's timezone, as an ISO instant. */
export function startOfOrgDay(tenantId: number | null, nowMs = Date.now()): string {
  const tz = orgTimezone(Number(tenantId) || 0);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  // Offset for that date in that zone, so the boundary lands on local midnight.
  const guess = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const asLocal = new Date(guess.toLocaleString("en-US", { timeZone: tz }));
  const offsetMs = asLocal.getTime() - guess.getTime();
  return new Date(guess.getTime() - offsetMs).toISOString();
}

/**
 * Every rep the caller may see, with their current state.
 *
 * Bounded by headcount rather than history: one indexed read of
 * rep_location_state joined to the roster, plus one grouped count over today's
 * knocks. No endpoint here walks the ping trail.
 */
export function getLiveStates(
  tenantId: number | null,
  scope: number[] | null,
  nowMs = Date.now(),
): RepLiveState[] {
  const s = scopeClause(scope, "tm.id");
  const rows = rawDb
    .prepare(
      `SELECT tm.id AS repId, tm.name AS repName,
              lead.name AS teamLeadName, mgr.name AS managerName,
              st.lat, st.lng, st.accuracy_m AS accuracyM, st.captured_at AS capturedAt,
              st.status, st.status_since AS statusSince, st.territory_id AS territoryId,
              st.outside_territory AS outsideTerritory, st.last_knock_at AS lastKnockAt,
              st.speed_mps AS speedMps, st.low_confidence AS lowConfidence,
              cs.clocked_in AS clockedInAt,
              t.name AS territoryName
         FROM team_members tm
         LEFT JOIN rep_location_state st ON st.rep_id = tm.id
         LEFT JOIN team_members lead ON lead.id = tm.reports_to_id
         LEFT JOIN team_members mgr ON mgr.id = lead.reports_to_id
         LEFT JOIN territories t ON t.id = st.territory_id
         LEFT JOIN clock_sessions cs
                ON cs.rep_id = tm.id AND cs.clocked_out IS NULL
        WHERE (tm.tenant_id = ? OR ? IS NULL) AND tm.active = 1 AND ${s.sql}
        ORDER BY tm.name
        LIMIT ?`,
    )
    .all(tenantId ?? null, tenantId ?? null, ...s.args, LIVE_STATE_ROW_CAP) as any[];

  const repIds = rows.map((r) => Number(r.repId));
  const counts = todayCounts(tenantId, repIds, nowMs);

  return rows.map((r) => {
    const capturedMs = tsMs(r.capturedAt);
    const freshness = locationFreshness(capturedMs, nowMs);
    const present = isPresentablePosition(freshness);
    const c = counts.get(Number(r.repId)) ?? { doors: 0, interested: 0, appointments: 0, sales: 0 };

    // Recompute status at READ time. A row written 40 minutes ago said
    // "knocking", and that was true then; it is not true now. Storing a status
    // and serving it unexamined is how a dashboard goes quietly stale.
    const status = deriveRepStatus({
      nowMs,
      clockedInAtMs: tsMs(r.clockedInAt),
      pausedAtMs: null,
      lastSeenAtMs: capturedMs,
      lastKnockAtMs: tsMs(r.lastKnockAt),
      capturedAtMs: capturedMs,
      speedMps: r.speedMps ?? null,
      movedM: null,
      appointmentActive: false,
      locationDenied: false,
      trackingPermitted: capturedMs != null,
    });

    return {
      repId: Number(r.repId),
      repName: r.repName,
      teamLeadName: r.teamLeadName ?? null,
      managerName: r.managerName ?? null,
      status: status.status,
      statusSince: status.sinceMs ? new Date(status.sinceMs).toISOString() : null,
      freshness,
      // A position we do not trust is not returned as one. The client cannot
      // draw a confident pin from data it never receives.
      lat: present ? (r.lat ?? null) : null,
      lng: present ? (r.lng ?? null) : null,
      accuracyM: present ? (r.accuracyM ?? null) : null,
      capturedAt: r.capturedAt ?? null,
      clockedInAt: r.clockedInAt ?? null,
      territoryId: r.territoryId ?? null,
      territoryName: r.territoryName ?? null,
      outsideTerritory: Number(r.outsideTerritory ?? 0) === 1,
      lastKnockAt: r.lastKnockAt ?? null,
      doorsToday: c.doors,
      interestedToday: c.interested,
      appointmentsToday: c.appointments,
      salesToday: c.sales,
    };
  });
}

interface DayCounts { doors: number; interested: number; appointments: number; sales: number }

/** Today's progress per rep, in the org's timezone. One grouped query. */
export function todayCounts(
  tenantId: number | null, repIds: number[], nowMs = Date.now(),
): Map<number, DayCounts> {
  const out = new Map<number, DayCounts>();
  if (repIds.length === 0) return out;
  const since = startOfOrgDay(tenantId, nowMs);
  try {
    const rows = rawDb
      .prepare(
        `SELECT rep_id AS repId,
                COUNT(*) AS doors,
                SUM(CASE WHEN outcome = 'interested' THEN 1 ELSE 0 END) AS interested,
                SUM(CASE WHEN outcome IN ('callback','follow_up') THEN 1 ELSE 0 END) AS appointments,
                SUM(CASE WHEN outcome = 'sold' THEN 1 ELSE 0 END) AS sales
           FROM knock_log
          WHERE knocked_at >= ? AND superseded = 0
            AND rep_id IN (${repIds.map(() => "?").join(",")})
          GROUP BY rep_id`,
      )
      .all(since, ...repIds) as any[];
    for (const r of rows) {
      out.set(Number(r.repId), {
        doors: Number(r.doors ?? 0),
        interested: Number(r.interested ?? 0),
        appointments: Number(r.appointments ?? 0),
        sales: Number(r.sales ?? 0),
      });
    }
  } catch { /* counts are decoration; an empty map is a safe answer */ }
  return out;
}

/** Who is in the app right now, for the caller's scope. */
export function getPresenceRows(tenantId: number | null, scope: number[] | null): PresenceRow[] {
  const s = scopeClause(scope, "tm.id");
  try {
    const rows = rawDb
      .prepare(
        `SELECT u.id AS userId, tm.id AS repId, u.name AS name, u.role AS role,
                p.last_seen_at AS lastSeenAt, p.session_started_at AS sessionStartedAt,
                p.app_area AS appArea, p.device_kind AS deviceKind, p.connection AS connection,
                cs.clocked_in AS clockedInAt
           FROM users u
           LEFT JOIN team_members tm ON tm.id = u.team_member_id
           LEFT JOIN user_presence p ON p.user_id = u.id
           LEFT JOIN clock_sessions cs ON cs.rep_id = tm.id AND cs.clocked_out IS NULL
          WHERE (u.tenant_id = ? OR ? IS NULL) AND u.active = 1 AND ${s.sql}
          ORDER BY u.name
          LIMIT ?`,
      )
      .all(tenantId ?? null, tenantId ?? null, ...s.args, LIVE_STATE_ROW_CAP) as any[];
    return rows.map((r) => ({
      userId: Number(r.userId),
      repId: r.repId == null ? null : Number(r.repId),
      name: r.name,
      role: r.role,
      lastSeenAt: r.lastSeenAt ?? null,
      sessionStartedAt: r.sessionStartedAt ?? null,
      appArea: r.appArea ?? null,
      deviceKind: r.deviceKind ?? "unknown",
      connection: r.connection ?? "offline",
      clockedIn: !!r.clockedInAt,
      clockedInAt: r.clockedInAt ?? null,
    }));
  } catch {
    return [];
  }
}

/** A heartbeat from the app. Carries nothing that identifies a device. */
export function recordPresence(input: {
  userId: number; tenantId: number | null; appArea?: string | null;
  deviceKind?: string | null; connection?: string | null; appVersion?: string | null;
  sessionStartedAt?: string | null;
}): void {
  try {
    rawDb
      .prepare(
        `INSERT INTO user_presence
           (user_id, tenant_id, last_seen_at, session_started_at, app_area, device_kind, connection, app_version, updated_at)
         VALUES (?,?,datetime('now'),?,?,?,?,?,datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           last_seen_at = excluded.last_seen_at,
           session_started_at = COALESCE(user_presence.session_started_at, excluded.session_started_at),
           app_area = excluded.app_area,
           device_kind = excluded.device_kind,
           connection = excluded.connection,
           app_version = excluded.app_version,
           updated_at = datetime('now')`,
      )
      .run(
        input.userId, input.tenantId ?? null, input.sessionStartedAt ?? new Date().toISOString(),
        input.appArea ?? null, input.deviceKind ?? "unknown",
        input.connection ?? "online", input.appVersion ?? null,
      );
  } catch { /* presence is best-effort; never block a request on it */ }
}

/** A bounded slice of one rep's trail. Paged and capped - never the whole
 *  history. Callers must audit; this function does not, so that the audit row
 *  records the ROUTE's context (actor, request id, ip) rather than a store call. */
export function getTrackHistory(
  repId: number, fromIso: string, toIso: string, limit = TRACK_HISTORY_ROW_CAP,
): Array<{ lat: number; lng: number; accuracyM: number | null; capturedAt: string; lowConfidence: boolean }> {
  const cap = Math.min(TRACK_HISTORY_ROW_CAP, Math.max(1, Math.floor(limit)));
  try {
    const rows = rawDb
      .prepare(
        `SELECT lat, lng, accuracy AS accuracyM,
                COALESCE(captured_at, ping_at) AS capturedAt,
                low_confidence AS lowConfidence
           FROM location_pings
          WHERE rep_id = ? AND COALESCE(captured_at, ping_at) BETWEEN ? AND ?
          ORDER BY COALESCE(captured_at, ping_at) ASC
          LIMIT ?`,
      )
      .all(repId, fromIso, toIso, cap) as any[];
    return rows.map((r) => ({
      lat: r.lat, lng: r.lng,
      accuracyM: r.accuracyM ?? null,
      capturedAt: r.capturedAt,
      lowConfidence: Number(r.lowConfidence ?? 0) === 1,
    }));
  } catch {
    return [];
  }
}
