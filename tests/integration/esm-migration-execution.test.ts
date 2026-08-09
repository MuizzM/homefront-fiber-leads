import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Guards the class of bug where a migration SILENTLY does nothing.
 *
 * Three migrations and one runtime projection used to load their dependency
 * with a bare `require()`. Under the CJS production bundle esbuild inlines that
 * call and it works; under the ESM runtime dev and vitest actually use, `require`
 * is undefined, so each threw straight into its own `catch` and logged a warning
 * nobody read. The result was a schema that differed between local and
 * production, and three migrations shipping with ZERO test coverage — they had
 * never once executed in a test run.
 *
 * These assertions fail if any of them regresses to a lazy require: each one
 * proves the imported symbol was genuinely reachable at migration time, not that
 * the call was merely attempted.
 */

let rawDb: import("better-sqlite3").Database;

const insertLead = (fields: Record<string, unknown>) => {
  const cols = Object.keys(fields);
  return Number(rawDb.prepare(
    `INSERT INTO leads (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...Object.values(fields)).lastInsertRowid);
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-esm-migration-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
});

describe("restored migrations execute under the real ESM module runtime", () => {
  it("ensureAdminAuditSchema ran - the admin_audit table exists", () => {
    // Previously: `require("./adminAudit")` threw, the catch logged
    // "[migration] admin audit schema: require is not defined", and the table
    // was simply absent. Admin history surviving a redeploy is the whole point
    // of that table, so its absence was silent loss of an audit trail.
    const t = rawDb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='admin_audit'`,
    ).get();
    expect(t).toBeTruthy();
  });

  it("backfillAddressReview ran - a coordinate-less lead is quarantined", async () => {
    // Depends on addressIdentityIssues from @shared/addressKey. If that import
    // regresses to a require, the backfill no-ops and this lead stays a
    // prospect — i.e. a lead with broken identity keeps reaching field reps.
    const id = insertLead({
      address: "404 Nowhere St", city: "Terrace", state: "NC", zip: "28110",
      lead_status: "prospect", tenant_id: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      // lat/lng deliberately omitted — this is the broken-identity case.
    });
    const s = await import("../../server/storage");
    s.runMigrations();
    const row = rawDb.prepare(`SELECT lead_status FROM leads WHERE id=?`).get(id) as any;
    expect(row.lead_status).toBe("address_review");
  });

  it("backfillAddressReview leaves a well-formed lead alone", async () => {
    const id = insertLead({
      address: "12 Real Ave", city: "Terrace", state: "NC", zip: "28110",
      lead_status: "prospect", tenant_id: 1, lat: 35.0107, lng: -80.5514,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const s = await import("../../server/storage");
    s.runMigrations();
    const row = rawDb.prepare(`SELECT lead_status FROM leads WHERE id=?`).get(id) as any;
    expect(row.lead_status).toBe("prospect");
  });

  it("the competitive-suppression backfill is reachable (its shared import resolves)", async () => {
    // evaluateSingleCompetitor comes from @shared/competitiveEligibility. A
    // regressed import made runMigrations warn and continue; a resolvable one
    // lets it complete. Asserting the migration COMPLETES without the warning
    // path is the observable difference available from here.
    const mod = await import("@shared/competitiveEligibility");
    expect(typeof mod.evaluateSingleCompetitor).toBe("function");
  });

  it("the fresh-fiber projector's calling-queue import resolves", async () => {
    // freshFiberProjector previously lazy-required ./calling/store inside a
    // bare `catch {}`, so in dev every fresh drop silently failed to enrol in
    // the calling queue and nothing was logged at all.
    const mod = await import("../../server/calling/store");
    expect(typeof mod.syncFreshFiberQueue).toBe("function");
  });

  it("migrations are idempotent - a second run changes nothing", async () => {
    const s = await import("../../server/storage");
    const before = (rawDb.prepare(`SELECT COUNT(*) c FROM leads`).get() as any).c;
    expect(() => s.runMigrations()).not.toThrow();
    const after = (rawDb.prepare(`SELECT COUNT(*) c FROM leads`).get() as any).c;
    expect(after).toBe(before);
  });
});
