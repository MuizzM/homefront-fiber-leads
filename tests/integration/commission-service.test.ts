import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RETRO_TIERS } from "../../shared/commissionTiers";
import { weekBoundsFor, DEFAULT_WORKWEEK } from "../../shared/workweek";

/**
 * Integration tests for the DB-backed commission layer against a THROWAWAY
 * SQLite (DATA_DIR → a fresh temp dir), so dev data is never touched. Covers:
 * sale aggregation, the dollar matrix end-to-end, idempotent recalculation,
 * the adjustment invariant, immutability locking, tenant isolation, and the
 * capability-based read scope.
 */

let svc: typeof import("../../server/commissionService");
let routes: typeof import("../../server/commissionRoutes");
let rawDb: import("better-sqlite3").Database;

// Two tenants; rep 1001 in T1, rep 1002 reports to lead 1001 in T1, rep 2001 in T2.
const T1 = 9001, T2 = 9002;
const REP = 1001, REP_REPORT = 1002, REP_T2 = 2001;

// A concrete week: Wed of the Jun 8–14 2026 week (a normal 168h week).
const WEEK_REF = "2026-06-10T12:00:00Z";
let weekStartUtc = "";
let inWeekTs = "";

function seedRep(id: number, tenantId: number, reportsToId: number | null) {
  rawDb.prepare(`INSERT INTO team_members (id, name, tenant_id, role, reports_to_id, active, created_at) VALUES (?,?,?,?,?,1,?)`)
    .run(id, `Rep ${id}`, tenantId, "rep", reportsToId, new Date().toISOString());
}

function activePlanFor(tenantId: number): number {
  const plan = svc.createPlan(tenantId, 1, { name: "Standard", type: "TIERED", tierMode: "RETROACTIVE_WEEKLY" });
  const version = svc.addPlanVersion(tenantId, 1, plan.id, { effectiveFrom: "2026-01-01", qualificationBasis: "QUALIFIED_AT", tiers: DEFAULT_RETRO_TIERS });
  svc.activatePlan(tenantId, 1, plan.id);
  return version.id;
}

// Insert N qualified sales inside the week (unique external ids per tenant/rep).
function seedQualifiedSales(tenantId: number, repId: number, n: number, prefix: string) {
  for (let i = 0; i < n; i++) {
    svc.upsertSale(tenantId, 1, { repId, externalId: `${prefix}-${i}`, status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
  }
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-commission-int-"));
  svc = await import("../../server/commissionService");
  routes = await import("../../server/commissionRoutes");
  ({ rawDb } = await import("../../server/db"));
  const { runMigrations } = await import("../../server/storage");
  // In production `tenants` is created by drizzle-kit push (schema.ts); runMigrations
  // then patches it. Replicate the "existing DB" path: create a minimal tenants,
  // let runMigrations ALTER in the commission_* columns + create every new table.
  rawDb.exec(`CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at TEXT, updated_at TEXT)`);
  runMigrations();

  const b = weekBoundsFor(WEEK_REF, DEFAULT_WORKWEEK);
  weekStartUtc = b.weekStartUtc;
  inWeekTs = new Date(Date.parse(b.weekStartUtc) + 3 * 3_600_000).toISOString(); // +3h, safely inside

  for (const t of [T1, T2]) {
    rawDb.prepare(`INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(t, `Tenant ${t}`, new Date().toISOString(), new Date().toISOString());
  }
  seedRep(REP, T1, null);
  seedRep(REP_REPORT, T1, REP);
  seedRep(REP_T2, T2, null);
});

describe("end-to-end statement calculation", () => {
  it("aggregates 8 qualified sales in the week → $1,600 gross (retroactive)", () => {
    const versionId = activePlanFor(T1); // one plan, one active version
    svc.assignPlanVersionToRep(T1, 1, { repId: REP, commissionPlanVersionId: versionId, effectiveFrom: "2026-01-01" });
    seedQualifiedSales(T1, REP, 8, "s1");

    const out = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1, requestId: "test-1" });
    expect(out.computation.qualifiedSaleCount).toBe(8);
    expect(out.statement.gross_commission_cents).toBe(160000);
    expect(out.statement.final_commission_cents).toBe(160000);
    expect(out.statement.week_start_utc).toBe(weekStartUtc);
  });

  it("is idempotent — recalculation keeps ONE row and bumps calculation_version", () => {
    const first = svc.getStatementById(T1, svc.listStatements(T1, { repIds: [REP], weekStartUtc })[0].id);
    svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1, requestId: "test-2" });
    const rows = svc.listStatements(T1, { repIds: [REP], weekStartUtc });
    expect(rows.length).toBe(1);
    expect(rows[0].calculation_version).toBeGreaterThan(first.calculation_version);
    expect(rows[0].final_commission_cents).toBe(160000); // unchanged inputs → unchanged money
  });

  it("half-open week boundary — a sale qualified before the week start does not count", () => {
    const before = new Date(Date.parse(weekStartUtc) - 3_600_000).toISOString(); // 1h before start
    svc.upsertSale(T1, 1, { repId: REP, externalId: "before-week", status: "QUALIFIED", soldAt: before, qualifiedAt: before });
    const out = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1 });
    expect(out.computation.qualifiedSaleCount).toBe(8); // still 8, not 9
  });

  it("non-qualified sales (PENDING/REVERSED) are excluded from the count", () => {
    svc.upsertSale(T1, 1, { repId: REP, externalId: "pending-1", status: "PENDING", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    svc.upsertSale(T1, 1, { repId: REP, externalId: "reversed-1", status: "REVERSED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const out = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1 });
    expect(out.computation.qualifiedSaleCount).toBe(8);
  });
});

describe("adjustments preserve final = gross + Σ(approved)", () => {
  it("an approved +$50 adjustment raises final to $1,650; a pending one does nothing", () => {
    const stmt = svc.listStatements(T1, { repIds: [REP], weekStartUtc })[0];
    const pending = svc.createAdjustment(T1, 1, { statementId: stmt.id, amountCents: 9999, type: "BONUS", reason: "pending, should not count" });
    // pending adjustment must not move the statement
    let out = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1 });
    expect(out.statement.final_commission_cents).toBe(160000);

    const adj = svc.createAdjustment(T1, 1, { statementId: stmt.id, amountCents: 5000, type: "BONUS", reason: "spiff" });
    const decided = svc.decideAdjustment(T1, 2, adj.id, "APPROVE");
    expect(decided.statement.adjustment_cents).toBe(5000);
    expect(decided.statement.gross_commission_cents).toBe(160000);
    expect(decided.statement.final_commission_cents).toBe(165000);

    // reject the pending one — still no effect
    svc.decideAdjustment(T1, 2, pending.id, "REJECT");
    out = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1 });
    expect(out.statement.final_commission_cents).toBe(165000);
  });
});

describe("immutability — locked statements refuse recalculation", () => {
  it("FINALIZED then recalculate → STATEMENT_LOCKED", () => {
    const stmt = svc.listStatements(T1, { repIds: [REP], weekStartUtc })[0];
    svc.transitionStatement(T1, 1, stmt.id, "FINALIZE");
    expect(() => svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1 }))
      .toThrowError(/STATEMENT_LOCKED|FINALIZED/);
    // reopen restores calculability
    svc.transitionStatement(T1, 1, stmt.id, "REOPEN");
    expect(() => svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1 })).not.toThrow();
  });
});

describe("tenant isolation", () => {
  it("tenant 2's sales never bleed into tenant 1, and vice versa", () => {
    const v2 = activePlanFor(T2);
    svc.assignPlanVersionToRep(T2, 1, { repId: REP_T2, commissionPlanVersionId: v2, effectiveFrom: "2026-01-01" });
    seedQualifiedSales(T2, REP_T2, 3, "t2");
    const out2 = svc.calculateOrRecalculateStatement({ tenantId: T2, repId: REP_T2, weekReference: WEEK_REF, actorId: 1 });
    expect(out2.computation.qualifiedSaleCount).toBe(3);
    expect(out2.statement.gross_commission_cents).toBe(3 * 15000);

    // T1's rep is unaffected and invisible to T2 listings
    const t1Rows = svc.listStatements(T1, { repIds: null, weekStartUtc });
    const t2Rows = svc.listStatements(T2, { repIds: null, weekStartUtc });
    expect(t1Rows.every(r => r.tenant_id === T1)).toBe(true);
    expect(t2Rows.every(r => r.tenant_id === T2)).toBe(true);
    expect(t2Rows.some(r => r.rep_id === REP)).toBe(false);
  });

  it("cross-tenant assignment is rejected", () => {
    const v2 = svc.listRepAssignments(T2, REP_T2)[0].commission_plan_version_id;
    expect(() => svc.assignPlanVersionToRep(T1, 1, { repId: REP, commissionPlanVersionId: v2, effectiveFrom: "2027-01-01" }))
      .toThrowError(/CROSS_TENANT|not found/);
  });

  it("overlapping assignment for the same rep is rejected", () => {
    let err: any;
    try {
      svc.assignPlanVersionToRep(T1, 1, { repId: REP, commissionPlanVersionId: svc.listRepAssignments(T1, REP)[0].commission_plan_version_id, effectiveFrom: "2026-02-01" });
    } catch (e) { err = e; }
    expect(err?.code).toBe("OVERLAPPING_PLAN_ASSIGNMENT");
    expect(err?.httpStatus).toBe(409);
  });
});

describe("capability-based read scope", () => {
  const admin = { role: "admin", tenantId: T1, teamMemberId: null };
  const manager = { role: "manager", tenantId: T1, teamMemberId: null };
  const lead = { role: "team_lead", tenantId: T1, teamMemberId: REP }; // lead's own team-member id
  const rep = { role: "rep", tenantId: T1, teamMemberId: REP_REPORT };

  it("admin/manager see the whole tenant (no rep filter)", () => {
    expect(routes.readScope(admin).repIds).toBeNull();
    expect(routes.readScope(manager).repIds).toBeNull();
  });
  it("team_lead sees self + direct reports only", () => {
    const ids = routes.readScope(lead).repIds!;
    expect(ids).toContain(REP);         // self
    expect(ids).toContain(REP_REPORT);  // direct report
    expect(ids).not.toContain(REP_T2);  // other tenant / not a report
  });
  it("rep sees only their own team-member id", () => {
    expect(routes.readScope(rep).repIds).toEqual([REP_REPORT]);
    expect(routes.canReadRep(rep, REP)).toBe(false);        // cannot read the lead
    expect(routes.canReadRep(rep, REP_REPORT)).toBe(true);  // can read self
    expect(routes.canReadRep(lead, REP_REPORT)).toBe(true); // lead can read a report
  });
});

describe("onboarding-facing structure assignment (flat vs tiered)", () => {
  const REP_STRUCT = 1003; // dedicated rep so we don't disturb REP's statements
  beforeAll(() => { seedRep(REP_STRUCT, T1, null); });

  it("TIERED assignment creates the standard ladder and reports it back", () => {
    const out = svc.assignStructureToRep(T1, 1, { repId: REP_STRUCT, structure: "TIERED", effectiveFrom: "2026-01-01" });
    expect(out.structure).toBe("TIERED");
    const cur = svc.getCurrentStructureForRep(T1, REP_STRUCT);
    expect(cur.structure).toBe("TIERED");
    expect(cur.tiers.length).toBe(DEFAULT_RETRO_TIERS.length);
    expect(cur.tiers[0].rateCents).toBe(15000);
  });

  it("re-assigning to FLAT closes the tiered period (no overlap) and becomes current", () => {
    const out = svc.assignStructureToRep(T1, 1, { repId: REP_STRUCT, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01", closeExisting: true });
    expect(out.structure).toBe("FLAT");
    const cur = svc.getCurrentStructureForRep(T1, REP_STRUCT);
    expect(cur.structure).toBe("FLAT");
    expect(cur.flatRateCents).toBe(20000);
    // two assignments exist now, but only one is currently effective
    expect(svc.listRepAssignments(T1, REP_STRUCT).length).toBe(2);
  });

  it("a FLAT assignment drives a $-per-sale statement", () => {
    // give this rep 5 qualified sales in the week and calculate
    for (let i = 0; i < 5; i++) svc.upsertSale(T1, 1, { repId: REP_STRUCT, externalId: `struct-${i}`, status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const res = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP_STRUCT, weekReference: WEEK_REF, actorId: 1 });
    expect(res.computation.qualifiedSaleCount).toBe(5);
    expect(res.statement.gross_commission_cents).toBe(5 * 20000); // flat $200 × 5
  });

  it("getOrCreateStandardTieredVersion is idempotent (reuses the plan/version)", () => {
    const a = svc.getOrCreateStandardTieredVersion(T1, 1);
    const b = svc.getOrCreateStandardTieredVersion(T1, 1);
    expect(a.versionId).toBe(b.versionId);
    expect(a.planId).toBe(b.planId);
  });

  it("FLAT structure requires a positive rate", () => {
    let err: any;
    try { svc.assignStructureToRep(T1, 1, { repId: REP_STRUCT, structure: "FLAT", flatRateCents: 0, closeExisting: true }); } catch (e) { err = e; }
    expect(err?.code).toBe("INVALID_COMMISSION_PLAN");
  });
});
