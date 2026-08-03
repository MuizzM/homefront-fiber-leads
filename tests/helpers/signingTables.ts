import type { Database } from "better-sqlite3";

/**
 * Run a fixture cleanup with the onboarding signing tables' immutability
 * triggers temporarily suspended.
 *
 * The production schema protects these tables with SQLite triggers:
 * onboarding_signature_events is append-only (any UPDATE or DELETE aborts) and
 * a completed onboarding_signing_documents row cannot have its evidence
 * rewritten. That is exactly what we want in production and exactly what a
 * fixture reset cannot work around, so the reset drops those triggers, wipes
 * the rows, and puts the triggers back VERBATIM — the SQL is read out of
 * sqlite_master rather than re-typed here, so this helper can never drift from
 * the real schema, and the `finally` guarantees it can never leave a table
 * unprotected for the test that follows. Tests that assert the triggers really
 * do abort write to the tables directly; this exists only so fixtures can
 * start from a clean slate.
 */
export function withSigningTriggersSuspended<T>(db: Database, cleanup: () => T): T {
  const triggers = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
       AND tbl_name IN ('onboarding_signing_documents', 'onboarding_signature_events')`,
  ).all() as Array<{ name: string; sql: string }>;
  try {
    for (const trigger of triggers) db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    return cleanup();
  } finally {
    for (const trigger of triggers) db.exec(trigger.sql);
  }
}

/** Truncate both onboarding signing tables between tests. */
export function resetSigningTables(db: Database): void {
  withSigningTriggersSuspended(db, () => {
    db.prepare("DELETE FROM onboarding_signature_events").run();
    db.prepare("DELETE FROM onboarding_signing_documents").run();
  });
}
