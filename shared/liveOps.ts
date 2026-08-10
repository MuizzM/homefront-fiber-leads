// ── Live field operations - the shared contract ──────────────────────────────
//
// Every constant a rep's phone, the ingest route and the dashboard all have to
// agree on lives here, because the three of them disagreeing is the failure
// mode this feature is most exposed to. A phone that sends on a cadence the
// server rejects burns battery for nothing; a dashboard that calls a fix
// "live" on a threshold the server never promised shows a supervisor a
// position that is not true any more.
//
// The naming follows the split `knock_log` already draws and `shared/geoVerify`
// enforces: what the DEVICE reported (`capturedAt`, `accuracyM`) is never
// conflated with what the SERVER observed (`receivedAt`). Freshness is measured
// against the device clock because that is when the rep was actually there, and
// clock skew is clamped rather than trusted.

/** Where a rep is in their working day. Not a location claim - see FRESHNESS. */
export const REP_STATUSES = [
  "offline",
  "online",
  "active",
  "knocking",
  "traveling",
  "appointment",
  "break",
  "inactive",
  "location_unavailable",
] as const;
export type RepStatus = (typeof REP_STATUSES)[number];

/**
 * How much to trust the position, kept STRICTLY separate from status.
 *
 * Folding these together is the mistake the brief calls out: a rep can be
 * genuinely `knocking` while their last fix is twenty minutes old, and drawing
 * that pin as though it were current is how a supervisor drives to the wrong
 * street. Status answers "what are they doing", freshness answers "do we know
 * where", and the UI must render both.
 */
export const LOCATION_FRESHNESS = ["live", "recent", "stale", "none"] as const;
export type LocationFreshness = (typeof LOCATION_FRESHNESS)[number];

export const FRESHNESS_LIVE_MS = 2 * 60_000;
export const FRESHNESS_RECENT_MS = 10 * 60_000;

/** Org tracking policy. `off` is the shipped default - see the privacy doc. */
export const FIELD_LOCATION_MODES = ["off", "default_on", "locked_on"] as const;
export type FieldLocationMode = (typeof FIELD_LOCATION_MODES)[number];

/** Coarse device bucket for the presence table. Deliberately NOT a fingerprint. */
export const DEVICE_KINDS = ["phone", "tablet", "desktop", "unknown"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const CONNECTION_STATES = ["online", "degraded", "offline"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Where a stored point came from. Knock fixes are already collected; reusing
 *  them means a rep who is knocking steadily needs fewer dedicated pings. */
export const LOCATION_SOURCES = ["ping", "knock"] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

/**
 * Bump when the disclosure TEXT changes in a way a rep should re-read.
 * Acknowledgement is stored against the version, so a reworded disclosure
 * re-prompts instead of silently inheriting consent to different words.
 */
export const FIELD_LOCATION_DISCLOSURE_VERSION = "2026-08-10.1";

// ── Cadence and filtering ────────────────────────────────────────────────────
// The brief's rule is "do not write a GPS point every second". These are the
// numbers that make that true, and they are shared so the server's backstop
// enforces exactly what the client promises rather than an approximation.

/** Sampling cadence, chosen by what the rep is doing rather than a fixed tick. */
export const PING_INTERVAL_MOVING_MS = 60_000;
export const PING_INTERVAL_STATIONARY_MS = 180_000;
/** A backgrounded tab still belongs to a clocked-in rep, so it keeps a slow
 *  heartbeat rather than going dark - but at a fifth of the moving rate. */
export const PING_INTERVAL_HIDDEN_MS = 300_000;

/** Movement below this is noise: GPS jitter parked in a driveway, not travel. */
export const MIN_MOVEMENT_M = 25;
/** ...but a stationary rep still reports this often, so "no news" stays
 *  distinguishable from "phone died". Together these two are the dedupe rule. */
export const MAX_SILENCE_MS = 5 * 60_000;

/** A fix vaguer than this is worse than no fix - it would draw a pin on the
 *  wrong block. Accepted only after ACCURACY_GRACE_MS of nothing better, and
 *  then flagged so the UI can widen the uncertainty instead of lying. */
export const MAX_ACCURACY_M = 100;
export const ACCURACY_GRACE_MS = 10 * 60_000;

/** Status thresholds. */
export const KNOCKING_WINDOW_MS = 10 * 60_000;
export const INACTIVE_AFTER_MS = 20 * 60_000;
export const PRESENCE_OFFLINE_AFTER_MS = 5 * 60_000;
/** ~4.5 mph. Above walking pace between two fixes reads as driving between
 *  streets rather than working a block. */
export const TRAVELING_SPEED_MPS = 2;

/** Server-side ingest backstop: a client that ignores every rule above still
 *  cannot write more often than this. Half the moving cadence, so a legitimate
 *  retry after a dropped response is never rejected. */
export const MIN_INGEST_GAP_MS = 30_000;

// ── Read caps ────────────────────────────────────────────────────────────────
// No endpoint may load a rep's whole history. These bound the three reads.

export const DOOR_ACTIVITY_ROW_CAP = 500;
export const TRACK_HISTORY_ROW_CAP = 1_000;
/** Live state is bounded by headcount, not history, but a runaway roster still
 *  should not serialise unbounded. */
export const LIVE_STATE_ROW_CAP = 2_000;

/** A supervisor viewing the board writes ONE audit row per this window, not one
 *  per poll. Without coalescing, a 10s refresh files 360 rows an hour per
 *  viewer and the audit trail becomes unreadable - which is the same as absent. */
export const VIEW_AUDIT_COALESCE_MS = 15 * 60_000;

/** Default precise-point retention. Overridable per tenant; floor-clamped in
 *  the prune job so a misconfiguration cannot mean "keep forever". */
export const DEFAULT_RETENTION_DAYS = 7;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 90;

// ── Wire shapes ──────────────────────────────────────────────────────────────

/** One rep's current state, as the dashboard receives it. */
export interface RepLiveState {
  repId: number;
  repName: string;
  teamLeadName: string | null;
  managerName: string | null;
  status: RepStatus;
  statusSince: string | null;
  freshness: LocationFreshness;
  /** Null whenever freshness is "none" - an unknown position is never a zero. */
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  /** Device clock, clamped. The age the UI must render next to the position. */
  capturedAt: string | null;
  clockedInAt: string | null;
  territoryId: number | null;
  territoryName: string | null;
  outsideTerritory: boolean;
  lastKnockAt: string | null;
  doorsToday: number;
  interestedToday: number;
  appointmentsToday: number;
  salesToday: number;
}

/** One row of the presence table. Carries no session token, IP, user agent or
 *  device identifier - see the privacy doc for why each was excluded. */
export interface PresenceRow {
  userId: number;
  repId: number | null;
  name: string;
  role: string;
  lastSeenAt: string | null;
  sessionStartedAt: string | null;
  appArea: string | null;
  deviceKind: DeviceKind;
  connection: ConnectionState;
  clockedIn: boolean;
  clockedInAt: string | null;
}
