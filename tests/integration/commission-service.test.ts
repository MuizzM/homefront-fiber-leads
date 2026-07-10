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

  it("is idempotent — ONE row; calculation_version bumps ONLY on material change", () => {
    const first = svc.getStatementById(T1, svc.listStatements(T1, { repIds: [REP], weekStartUtc })[0].id);
    // Unchanged inputs → pure read: same version, same money, no audit noise.
    svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1, requestId: "test-2" });
    let rows = svc.listStatements(T1, { repIds: [REP], weekStartUtc });
    expect(rows.length).toBe(1);
    expect(rows[0].calculation_version).toBe(first.calculation_version);
    expect(rows[0].final_commission_cents).toBe(160000);
    // A material change (one more qualified sale) DOES bump the version.
    svc.upsertSale(T1, 1, { repId: REP, externalId: "bump-1", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1, requestId: "test-2b" });
    rows = svc.listStatements(T1, { repIds: [REP], weekStartUtc });
    expect(rows[0].calculation_version).toBeGreaterThan(first.calculation_version);
    expect(rows[0].qualified_sale_count).toBe(9);
    expect(rows[0].final_commission_cents).toBe(9 * 20000); // still tier 2 (8–12)
    // put the ledger back so later tests keep their expectations
    svc.transitionSale(T1, 1, "bump-1", "REVERSE");
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

describe("field-sale wiring: door → weekly ledger", () => {
  const REP_FIELD = 1004;
  let leadA: number, leadB: number;

  beforeAll(() => {
    seedRep(REP_FIELD, T1, null);
    svc.assignStructureToRep(T1, 1, { repId: REP_FIELD, structure: "TIERED", effectiveFrom: "2026-01-01" });
    const mkLead = (addr: string) => Number(rawDb.prepare(
      `INSERT INTO leads (address, city, state, zip, tenant_id, assigned_rep_id, lead_status, created_at, updated_at)
       VALUES (?, 'Rockwell', 'NC', '28138', ?, ?, 'prospect', datetime('now'), datetime('now'))`
    ).run(addr, T1, REP_FIELD).lastInsertRowid);
    leadA = mkLead("10 Field St");
    leadB = mkLead("12 Field St");
  });

  it("a sold knock creates ONE qualified sale per door and prices the week", () => {
    svc.recordFieldSaleFromKnock({ tenantId: T1, repId: REP_FIELD, leadId: leadA, knockId: 900, soldAt: inWeekTs, actorId: 1 });
    svc.recordFieldSaleFromKnock({ tenantId: T1, repId: REP_FIELD, leadId: leadA, knockId: 901, soldAt: inWeekTs, actorId: 1 }); // re-tap: idempotent
    svc.recordFieldSaleFromKnock({ tenantId: T1, repId: REP_FIELD, leadId: leadB, knockId: 902, soldAt: inWeekTs, actorId: 1 });
    const sales = svc.listWeekSalesForRep(T1, REP_FIELD, WEEK_REF);
    expect(sales.filter(s => s.status === "QUALIFIED").length).toBe(2); // two DOORS, not three knocks
    const out = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP_FIELD, weekReference: WEEK_REF, actorId: 1 });
    expect(out.computation.qualifiedSaleCount).toBe(2);
    expect(out.statement.gross_commission_cents).toBe(2 * 15000); // tier 1
  });

  it("un-selling the door reverses the sale and the week re-prices down", () => {
    svc.reverseFieldSale(T1, leadB, 1);
    const out = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP_FIELD, weekReference: WEEK_REF, actorId: 1 });
    expect(out.computation.qualifiedSaleCount).toBe(1);
    const sales = svc.listWeekSalesForRep(T1, REP_FIELD, WEEK_REF);
    expect(sales.find(s => s.lead_id === leadB)?.status).toBe("REVERSED");
    // reversing again is a no-op, never an error
    expect(() => svc.reverseFieldSale(T1, leadB, 1)).not.toThrow();
  });

  it("re-selling the same door re-qualifies the SAME ledger row", () => {
    svc.recordFieldSaleFromKnock({ tenantId: T1, repId: REP_FIELD, leadId: leadB, knockId: 903, soldAt: inWeekTs, actorId: 1 });
    const sales = svc.listWeekSalesForRep(T1, REP_FIELD, WEEK_REF);
    expect(sales.length).toBe(2); // still two rows total
    expect(sales.every(s => s.status === "QUALIFIED")).toBe(true);
  });

  it("backfillFieldSales adopts currently-sold leads once, idempotently", () => {
    const leadC = Number(rawDb.prepare(
      `INSERT INTO leads (address, city, state, zip, tenant_id, assigned_rep_id, lead_status, created_at, updated_at)
       VALUES ('14 Field St', 'Rockwell', 'NC', '28138', ?, ?, 'sold', datetime('now'), datetime('now'))`
    ).run(T1, REP_FIELD).lastInsertRowid);
    rawDb.prepare(
      `INSERT INTO knock_log (lead_id, rep_id, tenant_id, knocked_at, was_home, outcome) VALUES (?, ?, ?, ?, 1, 'sold')`
    ).run(leadC, REP_FIELD, T1, inWeekTs);
    const first = svc.backfillFieldSales();
    expect(first.created).toBeGreaterThanOrEqual(1);
    const again = svc.backfillFieldSales();
    expect(again.created).toBe(0); // second run adopts nothing new
    const sales = svc.listWeekSalesForRep(T1, REP_FIELD, WEEK_REF);
    expect(sales.filter(s => s.status === "QUALIFIED").length).toBe(3);
  });
});

describe("week overview + Sunday closeout", () => {
  it("aggregates production, projected payroll, and tier proximity", () => {
    const ov = svc.getWeekOverview(T1, 1, WEEK_REF, null);
    expect(ov.bounds.weekStartUtc).toBe(weekStartUtc);
    const fieldRow = ov.rows.find(r => r.repId === 1004)!;
    expect(fieldRow.qualifiedSaleCount).toBe(3);
    expect(fieldRow.grossCommissionCents).toBe(3 * 15000);
    expect(fieldRow.salesUntilNextTier).toBe(5);          // 3 → needs 8
    expect(fieldRow.nextTierProjectedCommissionCents).toBe(8 * 20000);
    expect(fieldRow.marginalJumpCents).toBe(8 * 20000 - 3 * 15000);
    expect(ov.totals.projectedPayrollCents).toBeGreaterThan(0);
    expect(ov.totals.qualifiedSales).toBeGreaterThanOrEqual(3);
  });

  it("flags reps whose plan is not accepted, and clears after acceptance", () => {
    let ov = svc.getWeekOverview(T1, 1, WEEK_REF, null);
    expect(ov.exceptions.some(e => e.type === "PLAN_NOT_ACCEPTED" && e.repId === 1004)).toBe(true);
    const acc = svc.acceptCurrentPlan(T1, 1004, 42, "1.2.3.4");
    expect(acc.accepted).toBe(true);
    expect(acc.sha256).toMatch(/^[a-f0-9]{64}$/);
    // second acceptance is a no-op
    expect(svc.acceptCurrentPlan(T1, 1004, 42).alreadyAccepted).toBe(true);
    ov = svc.getWeekOverview(T1, 1, WEEK_REF, null);
    expect(ov.exceptions.some(e => e.type === "PLAN_NOT_ACCEPTED" && e.repId === 1004)).toBe(false);
  });

  it("batch FINALIZE locks every open statement (recalc-then-lock), idempotently", () => {
    const out = svc.batchTransitionWeek(T1, 1, WEEK_REF, "FINALIZE");
    const fieldRes = out.results.find(r => r.repId === 1004)!;
    expect(fieldRes.result).toBe("FINALIZED");
    expect(fieldRes.finalCommissionCents).toBe(3 * 15000);
    // second run: everything already locked
    const again = svc.batchTransitionWeek(T1, 1, WEEK_REF, "FINALIZE");
    expect(again.results.every(r => r.result.startsWith("already"))).toBe(true);
  });

  it("a reversal AFTER finalize never changes the locked number — it becomes an exception", () => {
    const before = svc.getStatementForWeek(T1, 1004, WEEK_REF).statement;
    svc.reverseFieldSale(T1, undefined as any, 1); // guard: bogus lead id is a no-op
    // reverse a real sold door post-finalize
    const sale = svc.listWeekSalesForRep(T1, 1004, WEEK_REF).find(s => s.status === "QUALIFIED")!;
    svc.reverseFieldSale(T1, sale.lead_id, 1);
    const after = svc.getStatementForWeek(T1, 1004, WEEK_REF).statement;
    expect(after.final_commission_cents).toBe(before.final_commission_cents); // locked money untouched
    expect(after.status).toBe("FINALIZED");
    const ov = svc.getWeekOverview(T1, 1, WEEK_REF, null);
    expect(ov.exceptions.some(e => e.type === "REVERSED_AFTER_FINALIZE" && e.repId === 1004)).toBe(true);
  });

  it("MARK_PAID only touches FINALIZED statements and is idempotent", () => {
    const out = svc.batchTransitionWeek(T1, 1, WEEK_REF, "MARK_PAID");
    const fieldRes = out.results.find(r => r.repId === 1004)!;
    expect(fieldRes.result).toBe("PAID");
    const again = svc.batchTransitionWeek(T1, 1, WEEK_REF, "MARK_PAID");
    expect(again.results.find(r => r.repId === 1004)!.result).toBe("already PAID");
  });
});

describe("post-finalize correction workflow (reviewer criticals)", () => {
  const REP_CORR = 1005;
  let stmtId: number;

  beforeAll(() => {
    seedRep(REP_CORR, T1, null);
    svc.assignStructureToRep(T1, 1, { repId: REP_CORR, structure: "TIERED", effectiveFrom: "2026-01-01" });
    for (let i = 0; i < 8; i++) svc.upsertSale(T1, 1, { repId: REP_CORR, externalId: `corr-${i}`, status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const out = svc.batchTransitionWeek(T1, 1, WEEK_REF, "FINALIZE", [REP_CORR]);
    stmtId = out.results.find(r => r.repId === REP_CORR)!.statementId!;
  });

  it("finalized statement snapshots the exact doors and locks 8 × $200 = $1,600", () => {
    const s = svc.getStatementById(T1, stmtId);
    expect(s.status).toBe("FINALIZED");
    expect(s.final_commission_cents).toBe(160000);
    expect(JSON.parse(s.contributing_sales).length).toBe(8); // frozen door snapshot
  });

  it("CRITICAL: an approved adjustment on a FINALIZED week APPLIES without re-pricing gross", () => {
    const adj = svc.createAdjustment(T1, 1, { statementId: stmtId, amountCents: -20000, reason: "Install cancelled — post-finalize clawback" });
    const res = svc.decideAdjustment(T1, 2, adj.id, "APPROVE");
    expect(res.statement.status).toBe("FINALIZED");            // still locked
    expect(res.statement.gross_commission_cents).toBe(160000); // gross FROZEN — never re-tiered
    expect(res.statement.adjustment_cents).toBe(-20000);
    expect(res.statement.final_commission_cents).toBe(140000); // gross + adj — invariant holds on a locked week
  });

  it("a reversal after finalize does NOT change the locked gross (drill reads the frozen snapshot)", () => {
    svc.transitionSale(T1, 1, "corr-0", "REVERSE");
    const s = svc.getStatementById(T1, stmtId);
    expect(s.gross_commission_cents).toBe(160000);             // unchanged
    expect(JSON.parse(s.contributing_sales).length).toBe(8);   // snapshot still shows the 8 that were paid
  });

  it("blocks creating an adjustment on a PAID statement; REJECT still allowed to clear dangling", () => {
    const pend = svc.createAdjustment(T1, 1, { statementId: stmtId, amountCents: 5000, reason: "pending before pay" });
    svc.transitionStatement(T1, 1, stmtId, "MARK_PAID");
    let err: any; try { svc.createAdjustment(T1, 1, { statementId: stmtId, amountCents: 1000, reason: "too late" }); } catch (e) { err = e; }
    expect(err?.code).toBe("STATEMENT_LOCKED");
    // a dangling PENDING can still be rejected on a PAID week (moves no money)
    const rej = svc.decideAdjustment(T1, 2, pend.id, "REJECT");
    expect(rej.adjustment.status).toBe("REJECTED");
    // …but it can NOT be approved on a PAID week
    const pend2 = rawDb.prepare(`INSERT INTO commission_adjustments (tenant_id, statement_id, rep_id, amount_cents, type, reason, status, created_at) VALUES (?,?,?,?,?,?,'PENDING',datetime('now'))`).run(T1, stmtId, REP_CORR, 999, "MANUAL", "x").lastInsertRowid;
    let e2: any; try { svc.decideAdjustment(T1, 2, Number(pend2), "APPROVE"); } catch (e) { e2 = e; }
    expect(e2?.code).toBe("STATEMENT_LOCKED");
  });

  it("guards: reversed-sale adjustment on an OPEN week, over-cap amount", () => {
    const REP_G = 1006;
    seedRep(REP_G, T1, null);
    svc.assignStructureToRep(T1, 1, { repId: REP_G, structure: "TIERED", effectiveFrom: "2026-01-01" });
    svc.upsertSale(T1, 1, { repId: REP_G, externalId: "g-0", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const open = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP_G, weekReference: WEEK_REF, actorId: 1 }).statement;
    const sale = svc.getSaleByExternalId(T1, "g-0");
    svc.transitionSale(T1, 1, "g-0", "REVERSE");
    // adjustment linked to an already-reversed sale on an OPEN week is refused
    let e1: any; try { svc.createAdjustment(T1, 1, { statementId: open.id, amountCents: -15000, reason: "double", relatedSaleId: sale.id }); } catch (e) { e1 = e; }
    expect(e1?.code).toBe("INVALID_ADJUSTMENT");
    // over-cap amount is refused
    let e2: any; try { svc.createAdjustment(T1, 1, { statementId: open.id, amountCents: 100_000_001, reason: "too big" }); } catch (e) { e2 = e; }
    expect(e2?.code).toBe("INVALID_ADJUSTMENT");
  });

  it("batch finalize BLOCKS a rep who has sales but no plan (owed work stays visible)", () => {
    const REP_NP = 1007;
    seedRep(REP_NP, T1, null);
    // sales but NO plan assignment
    svc.upsertSale(T1, 1, { repId: REP_NP, externalId: "np-0", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const out = svc.batchTransitionWeek(T1, 1, WEEK_REF, "FINALIZE", [REP_NP]);
    const r = out.results.find(x => x.repId === REP_NP);
    expect(r?.result).toMatch(/BLOCKED.*no plan/);
    expect(r?.statementId).toBeNull();
  });
});
