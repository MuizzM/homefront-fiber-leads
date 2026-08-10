// ── Fiber Sales Academy schema ────────────────────────────────────────────────
//
// Five tables, one transaction, all additive. Nothing here touches
// training_progress: the Academy's path activities of kind "lesson" write the
// SAME training_progress row the module list has always written, so a lesson
// finished in either place is finished in both. These tables hold only what did
// not exist before.
//
//   academy_activity_progress  one row per (tenant, user, activity). The
//                              completion record for path activities that are
//                              not lessons: scenarios, drills, timed practice,
//                              branching trees, pitch builds.
//   academy_activity_state     one row per (tenant, user, activity). Opaque
//                              mid-activity resume state, so a rep who closes
//                              the app inside question three of a scenario
//                              comes back to question three.
//   academy_roleplay_sessions  one row per completed drill: the transcript and
//                              the eleven scores, as JSON. Private to the rep
//                              and their chain of command.
//   academy_assignments        supervisor to rep. Carries the note, so a rep
//                              sees WHY something was assigned.
//   academy_offer_catalog      one row per tenant: the market-configurable
//                              offer catalog as JSON, versioned.
//
// tenant_id is normalized to 0 for legacy users with no tenant, matching the
// training_progress convention, so every UNIQUE conflict target is real
// (SQLite treats NULLs as distinct).

import { rawDb } from "./db";

export function runAcademyMigrations(): void {
  rawDb.exec("BEGIN IMMEDIATE");
  try {
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS academy_activity_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER NOT NULL,
        -- Validated against shared/academyPath.ts before any write.
        activity_id TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT (datetime('now')),
        -- 0 to 100, or NULL for activities that do not produce a score.
        score INTEGER,
        UNIQUE(tenant_id, user_id, activity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_academy_progress_user
        ON academy_activity_progress(tenant_id, user_id);

      -- Resume state. Deliberately separate from the completion row: a rep can
      -- have state without a completion (mid-quiz) and a completion without
      -- state (finished, nothing to resume). Merging them would make "have they
      -- started" and "have they finished" the same column.
      CREATE TABLE IF NOT EXISTS academy_activity_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER NOT NULL,
        activity_id TEXT NOT NULL,
        -- Opaque JSON. Each activity kind owns its own shape; the server only
        -- checks that it parses and is under the size cap.
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, user_id, activity_id)
      );

      -- One completed role-play. transcript_json and score_json are written
      -- once and never updated: a coaching record that can be edited after the
      -- fact is not a record.
      CREATE TABLE IF NOT EXISTS academy_roleplay_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER NOT NULL,
        -- Client-generated session id, also the engine seed. Unique per user so
        -- a replayed submission is idempotent rather than duplicated.
        session_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        market TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'text',
        outcome TEXT NOT NULL,
        overall INTEGER NOT NULL,
        transcript_json TEXT NOT NULL,
        score_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tenant_id, user_id, session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_academy_roleplay_user
        ON academy_roleplay_sessions(tenant_id, user_id, created_at);

      CREATE TABLE IF NOT EXISTS academy_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('activity','stage')),
        note TEXT NOT NULL DEFAULT '',
        assigned_by INTEGER NOT NULL,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        -- yyyy-mm-dd, or NULL for no deadline.
        due_on TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_academy_assignments_user
        ON academy_assignments(tenant_id, user_id, completed_at);

      -- The market-configurable offer catalog. One row per tenant; absence
      -- means the tenant is on the seed catalog, which is the honest default
      -- (every seeded offer is scoped to every market and carries a
      -- confirm-at-the-address disclosure).
      CREATE TABLE IF NOT EXISTS academy_offer_catalog (
        tenant_id INTEGER PRIMARY KEY,
        catalog_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    rawDb.exec("COMMIT");
  } catch (e) {
    try { rawDb.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
