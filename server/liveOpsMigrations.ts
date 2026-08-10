// ── Live field operations - schema ───────────────────────────────────────────
//
// Five concerns, and the split between them is deliberate.
//
// HISTORY vs LIVE STATE
//   `location_pings` is the append-only trail; `rep_location_state` is one row
//   per rep holding only the newest accepted fix. The dashboard reads the
//   latter, so answering "where is everyone" costs one indexed scan of a table
//   bounded by HEADCOUNT rather than a correlated per-rep LIMIT 1 over a
//   history table that grows forever. The existing getLatestPingPerRep does the
//   latter and its own comment records it at 125ms and climbing.
//
// CONSENT vs POLICY
//   Policy is what the ORG has decided (`field_location_policy`); consent is
//   what a REP has been told and has acknowledged (`field_location_consent`).
//   Keeping them apart is what makes "default on, but never secret" expressible:
//   the org may switch collection on without asking, and the rep still cannot be
//   tracked until they have been shown the disclosure. Collapsing the two would
//   force a choice between silent tracking and per-rep opt-in, and the brief
//   rules out the first while the owner ruled out the second.
//
// PRESENCE
//   `user_presence` answers "who is in the app right now" and is deliberately
//   thin: no session id, no IP, no user agent, no device identifier. A coarse
//   phone/tablet/desktop bucket is enough to tell a supervisor whether someone
//   is on the road, and anything finer is a fingerprint nobody asked for.
//
// WHY location_pings KEEPS ITS NAME
//   Renaming it would orphan the rows already written by /live-map. It is
//   altered in place instead: a tenant column it should always have had, the
//   device/server timestamp split that knock_log already models, and the
//   provenance needed to tell a dedicated ping from a fix that arrived on a
//   knock.

import { rawDb } from "./db";
import {
  CONNECTION_STATES,
  DEVICE_KINDS,
  FIELD_LOCATION_MODES,
  REP_STATUSES,
} from "@shared/liveOps";

/** CHECK bodies generated from the shared unions, so the database and the code
 *  that reads it cannot drift apart. Same device as kineticBuildMigrations. */
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const STATUS_CHECK = list(REP_STATUSES);
const MODE_CHECK = list(FIELD_LOCATION_MODES);
const DEVICE_CHECK = list(DEVICE_KINDS);
const CONNECTION_CHECK = list(CONNECTION_STATES);
// NOTE: `location_pings.source` gets no CHECK. SQLite cannot attach one through
// ALTER TABLE ADD COLUMN, and rebuilding a live table to gain one is not worth
// the risk. LOCATION_SOURCES is enforced at the write boundary in liveOpsStore
// instead - the one place that inserts a ping.

/**
 * Additive columns on the pre-existing table.
 *
 * Run OUTSIDE the transaction and tolerated one at a time: SQLite aborts the
 * whole transaction on a duplicate-column error, so a single already-applied
 * ALTER inside `BEGIN IMMEDIATE` would roll back every table created alongside
 * it. This is the same tolerate-per-statement shape runMigrations() uses.
 */
const ADDITIVE: readonly string[] = [
  // Tenancy the table should have had from the start. Without it every read
  // pays a subquery through team_members just to stay inside one org.
  `ALTER TABLE location_pings ADD COLUMN tenant_id INTEGER`,
  // The device's own clock, kept apart from the server-stamped ping_at exactly
  // as knock_log keeps device_ts apart from server_ts. Freshness is measured
  // against this one, clamped - see shared/repStatus.clampCapturedAt.
  `ALTER TABLE location_pings ADD COLUMN captured_at TEXT`,
  `ALTER TABLE location_pings ADD COLUMN source TEXT`,
  // Which shift this point belongs to. Makes "delete everything from the shift
  // that should never have been recorded" a single indexed delete, and makes an
  // off-shift point structurally identifiable rather than a matter of opinion.
  `ALTER TABLE location_pings ADD COLUMN clock_session_id INTEGER`,
  `ALTER TABLE location_pings ADD COLUMN speed_mps REAL`,
  `ALTER TABLE location_pings ADD COLUMN heading REAL`,
  // Set when a fix was accepted despite poor accuracy, so the map can widen its
  // uncertainty instead of drawing a confident pin it has not earned.
  `ALTER TABLE location_pings ADD COLUMN low_confidence INTEGER NOT NULL DEFAULT 0`,
];

export function runLiveOpsMigrations(): void {
  for (const sql of ADDITIVE) {
    try {
      rawDb.exec(sql);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (!/duplicate column|already exists/i.test(msg)) {
        console.warn("[migration] live-ops additive:", msg);
      }
    }
  }

  rawDb.exec("BEGIN IMMEDIATE");
  try {
    rawDb.exec(`
      -- ── Live state: one row per rep, the newest accepted fix ──────────────
      CREATE TABLE IF NOT EXISTS rep_location_state (
        rep_id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        user_id INTEGER,
        lat REAL,
        lng REAL,
        accuracy_m REAL,
        heading REAL,
        speed_mps REAL,
        low_confidence INTEGER NOT NULL DEFAULT 0,
        -- Device clock (clamped) vs server receipt. Both kept: the first is the
        -- honest age of the position, the second proves when we learned it.
        captured_at TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN (${STATUS_CHECK})),
        status_since TEXT,
        clock_session_id INTEGER,
        -- Resolved server-side from the polygon, never sent by the client.
        territory_id INTEGER,
        outside_territory INTEGER NOT NULL DEFAULT 0,
        last_knock_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rep_location_state_tenant
        ON rep_location_state(tenant_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rep_location_state_status
        ON rep_location_state(tenant_id, status);

      -- ── Per-rep consent ───────────────────────────────────────────────────
      -- Version-stamped: rewording the disclosure re-prompts rather than
      -- inheriting agreement to different words. paused_at is the rep's own
      -- control; revoked_at is their withdrawal. Neither is an admin field.
      CREATE TABLE IF NOT EXISTS field_location_consent (
        user_id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        disclosure_version TEXT,
        acknowledged_at TEXT,
        paused_at TEXT,
        paused_reason TEXT,
        revoked_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_field_location_consent_tenant
        ON field_location_consent(tenant_id);

      -- ── Per-org policy ────────────────────────────────────────────────────
      -- Ships 'off'. Turning collection on is a deliberate act with a named
      -- actor and a timestamp, because "who switched on employee tracking and
      -- when" is the first question anyone will ask.
      CREATE TABLE IF NOT EXISTS field_location_policy (
        tenant_id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'off' CHECK(mode IN (${MODE_CHECK})),
        retention_days INTEGER NOT NULL DEFAULT 7,
        disclosure_version TEXT,
        allow_rep_pause INTEGER NOT NULL DEFAULT 1,
        updated_by INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- ── Presence ──────────────────────────────────────────────────────────
      -- Everything here is answerable from a heartbeat. Nothing here identifies
      -- a device beyond its form factor.
      CREATE TABLE IF NOT EXISTS user_presence (
        user_id INTEGER PRIMARY KEY,
        tenant_id INTEGER,
        last_seen_at TEXT,
        session_started_at TEXT,
        app_area TEXT,
        device_kind TEXT NOT NULL DEFAULT 'unknown' CHECK(device_kind IN (${DEVICE_CHECK})),
        connection TEXT NOT NULL DEFAULT 'online' CHECK(connection IN (${CONNECTION_CHECK})),
        app_version TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_user_presence_tenant
        ON user_presence(tenant_id, last_seen_at DESC);

      -- ── Indexes the new reads need ────────────────────────────────────────
      -- Tenant-scoped history window, for the retention sweep and the audited
      -- history export. The existing index is (rep_id, ping_at) only.
      CREATE INDEX IF NOT EXISTS idx_location_pings_tenant_time
        ON location_pings(tenant_id, ping_at DESC);
      -- "Who is clocked in right now" has no index today; the only existing
      -- answer is a COUNT(DISTINCT rep_id) with a full scan of open sessions.
      CREATE INDEX IF NOT EXISTS idx_clock_sessions_open
        ON clock_sessions(tenant_id, clocked_out);
    `);
    rawDb.exec("COMMIT");
  } catch (e) {
    try { rawDb.exec("ROLLBACK"); } catch { /* already unwound */ }
    throw e;
  }

  backfillPingTenants();
}

/**
 * Give existing pings the tenant they always implicitly had.
 *
 * Idempotent by predicate rather than by a migration mark: it only ever touches
 * rows whose tenant is still null, so a re-run is a no-op, and a ping written by
 * an older build during a rolling deploy is repaired on the next boot instead of
 * being stranded outside every tenant-scoped query.
 */
function backfillPingTenants(): void {
  try {
    const pending = rawDb
      .prepare(`SELECT 1 FROM location_pings WHERE tenant_id IS NULL LIMIT 1`)
      .get();
    if (!pending) return;
    const tx = rawDb.transaction(() => {
      rawDb
        .prepare(
          `UPDATE location_pings
              SET tenant_id = (SELECT tm.tenant_id FROM team_members tm WHERE tm.id = location_pings.rep_id)
            WHERE tenant_id IS NULL`,
        )
        .run();
    });
    // .immediate(): this reads (the SELECT above and the correlated subquery)
    // and then writes. A deferred BEGIN would take its snapshot on the read and
    // fail SQLITE_BUSY_SNAPSHOT the moment any other connection commits first -
    // which busy_timeout does not cover.
    tx.immediate();
  } catch (e: any) {
    console.warn("[migration] location_pings tenant backfill:", e?.message);
  }
}
