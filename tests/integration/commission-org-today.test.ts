import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression: default effective-dating of commission assignments/plan versions
 * must use the ORG's timezone, not the UTC date. In the evening window
 * (20:00–24:00 ET) the UTC date is already TOMORROW while the org's commission
 * week is still the running one — a UTC-dated assignment fell outside the
 * week's resolution window and every recalculate failed with
 * NO_EFFECTIVE_PLAN_ASSIGNMENT (nightly CI failure, lane-a-authz 2026-08-02/03).
 */

let svc: typeof import("../../server/commissionService");
let rawDb: import("better-sqlite3").Database;
const T = 9301, REP = 9302;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-org-today-"));
  svc = await import("../../server/commissionService");
  ({ rawDb } = await import("../../server/db"));
  const { runMigrations } = await import("../../server/storage");
  rawDb.exec(`CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at TEXT, updated_at TEXT)`);
  runMigrations();
  rawDb.prepare(`INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
    .run(T, "Tenant T", new Date().toISOString(), new Date().toISOString());
  rawDb.prepare(`INSERT INTO team_members (id, name, tenant_id, role, active, created_at) VALUES (?,?,?,?,1,?)`)
    .run(REP, "Rep T", T, "rep", new Date().toISOString());
});

afterAll(() => vi.useRealTimers());

describe("org-timezone effective dating", () => {
  it("a structure assigned during the ET evening window dates to the ORG day and resolves for the running week", () => {
    // 2026-08-03 02:30 UTC = Sunday 2026-08-02 22:30 in America/New_York — the
    // commission week is STILL Jul 27 – Aug 2 even though the UTC day is Aug 3.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-03T02:30:00.000Z"));
      const out = svc.assignStructureToRep(T, 1, { repId: REP, structure: "FLAT", flatRateCents: 5000 });
      expect(out.assignment.effective_from).toBe("2026-08-02"); // org-local "today", not UTC
      // The running week's recalculate must find the plan (previously 400).
      const stmt = svc.calculateOrRecalculateStatement({ tenantId: T, repId: REP, weekReference: new Date(), actorId: 1 });
      expect(stmt.statement.id).toBeGreaterThan(0);
      expect(stmt.bounds.localWeekLabel).toContain("Jul 27");
    } finally {
      vi.useRealTimers();
    }
  });
});
