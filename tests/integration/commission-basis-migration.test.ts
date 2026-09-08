// ── Migration behaviour + a production-like end-to-end ──────────────────────
//
// The basis snapshot is a NEW column on an EXISTING money table, so the property
// that matters most is what it does to rows that predate it. The answer must be
// "nothing": a NULL snapshot resolves through the documented fallback (the plan
// version's basis), which is exactly what already counted those sales, so no
// historical pay changes and no locked period is touched.
//
// The second half walks one sale through the whole system the way production
// does — qualification, upline override, reversal, a locked week, a poison
// event, an operator retry, and finally reconciliation.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ always: false }));
vi.mock("../../server/referralStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/referralStore")>();
  return {
    ...actual,
    referralForRep: (...args: any[]) => {
      if (fault.always) throw new TypeError("simulated collaborator fault");
      return (actual.referralForRep as any)(...args);
    },
  };
});

let svc: typeof import("../../server/commissionService");
let recon: typeof import("../../server/commissionReconciliation");
let queueOps: typeof import("../../server/eventQueueOps");
let E: typeof import("../../server/domainEventStore");
let S: typeof import("../../server/incentiveSubscriber");
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let weekBoundsFor: (typeof import("../../shared/workweek"))["weekBoundsFor"];

const T = 1;
let seq = 0;
function person(name: string, role: string, reportsToId: number | null) {
  seq += 1;
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${seq}@mig.example.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, reportsToId, tenantId: T } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId: T, teamMemberId: m.id } as any);
  return { memberId: m.id as number, userId: u.id as number };
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-basis-migration-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  svc = await import("../../server/commissionService");
  recon = await import("../../server/commissionReconciliation");
  queueOps = await import("../../server/eventQueueOps");
  E = await import("../../server/domainEventStore");
  S = await import("../../server/incentiveSubscriber");
  ({ weekBoundsFor } = await import("../../shared/workweek"));
});

describe("migration: rows that predate the basis column", () => {
  it("the column is added additively and defaults to NULL for existing rows", () => {
    const cols = rawDb.prepare(`PRAGMA table_info(commission_sales)`).all() as any[];
    const col = cols.find(c => c.name === "qualification_basis");
    expect(col).toBeTruthy();
    expect(col.notnull).toBe(0);          // nullable — no backfill required to deploy
    expect(col.dflt_value).toBeNull();
  });

  it("a legacy NULL-snapshot sale counts EXACTLY as it did before the column existed", () => {
    const rep = person("Legacy Rep", "rep", null).memberId;
    svc.assignStructureToRep(T, 1, { repId: rep, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    const ts = "2026-09-09T15:00:00.000Z";
    svc.upsertSale(T, 1, { repId: rep, externalId: "legacy-1", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });

    // Strip the snapshot to reproduce a row written before this release.
    rawDb.prepare(`UPDATE commission_sales SET qualification_basis = NULL WHERE external_id = ?`).run("legacy-1");

    const week = weekBoundsFor(ts, svc.loadOrgConfig(T)).weekStartUtc;
    const out = svc.calculateOrRecalculateStatement({ tenantId: T, repId: rep, weekReference: ts, actorId: 1 });
    expect(out.statement.qualified_sale_count).toBe(1);
    expect(out.statement.gross_commission_cents).toBe(20000);
    expect(out.statement.week_start_utc).toBe(week);
  });

  it("a LOCKED statement is byte-identical after the migration and a full recompute pass", () => {
    const rep = person("Locked Legacy Rep", "rep", null).memberId;
    svc.assignStructureToRep(T, 1, { repId: rep, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    const ts = "2026-09-16T15:00:00.000Z";
    svc.upsertSale(T, 1, { repId: rep, externalId: "locked-legacy", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    svc.calculateOrRecalculateStatement({ tenantId: T, repId: rep, weekReference: ts, actorId: 1 });
    svc.batchTransitionWeek(T, 1, ts, "FINALIZE", [rep]);
    rawDb.prepare(`UPDATE commission_sales SET qualification_basis = NULL WHERE external_id = ?`).run("locked-legacy");

    const snapshot = () => rawDb.prepare(
      `SELECT * FROM commission_statements WHERE tenant_id = ? AND rep_id = ?`,
    ).get(T, rep);
    const before = JSON.stringify(snapshot());

    // Everything a deploy would do afterwards: re-run migrations, sweep the
    // backfill, and attempt a recompute of the locked week.
    (rawDb as any).exec("SELECT 1");
    svc.backfillFieldSales();
    let err: any;
    try { svc.calculateOrRecalculateStatement({ tenantId: T, repId: rep, weekReference: ts, actorId: 1 }); }
    catch (e) { err = e; }
    expect(err?.code).toBe("STATEMENT_LOCKED");     // refused, as it must be

    expect(JSON.stringify(snapshot())).toBe(before);
  });

  it("only NEWLY written sales carry a snapshot - the migration adopts nothing retroactively", () => {
    const legacy = rawDb.prepare(`SELECT qualification_basis AS b FROM commission_sales WHERE external_id = ?`).get("legacy-1") as any;
    expect(legacy.b).toBeNull();

    const rep = person("Fresh Rep", "rep", null).memberId;
    svc.assignStructureToRep(T, 1, { repId: rep, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    const ts = "2026-09-23T15:00:00.000Z";
    svc.upsertSale(T, 1, { repId: rep, externalId: "fresh-1", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    expect(svc.getSaleByExternalId(T, "fresh-1").qualification_basis).toBe("QUALIFIED_AT");
  });
});

describe("production-like end to end", () => {
  it("qualification → override → reversal → locked week → poison event → retry → reconciliation", async () => {
    const mgr = person("E2E Manager", "manager", null);
    const tl = person("E2E Lead", "team_lead", mgr.memberId);
    const rep = person("E2E Rep", "rep", tl.memberId);
    svc.updateOrgConfig(T, null, { overridesEnabled: true, overrideTeamLeadCents: 2500, overrideManagerCents: 7500 } as any);
    svc.assignStructureToRep(T, 1, { repId: rep.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });

    const ts = "2026-10-14T15:00:00.000Z";
    const cfg = svc.loadOrgConfig(T);
    const week = weekBoundsFor(ts, cfg).weekStartUtc;
    const stmtFor = (repId: number) => rawDb.prepare(
      `SELECT * FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T, repId, week) as any;

    // 1. QUALIFICATION — the sale pays the rep and both uplines.
    svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "e2e-1", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    expect(stmtFor(rep.memberId).gross_commission_cents).toBe(20000);
    expect(stmtFor(tl.memberId).override_pay_cents).toBe(2500);
    expect(stmtFor(mgr.memberId).override_pay_cents).toBe(7500);

    // 2. REVERSAL — the overrides claw back and the fold nets to zero.
    svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "e2e-2", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    expect(stmtFor(mgr.memberId).override_pay_cents).toBe(15000);
    svc.transitionSale(T, 1, "e2e-2", "REVERSE");
    expect(stmtFor(mgr.memberId).override_pay_cents).toBe(7500);

    // 3. LOCKED WEEK — finalize, then prove nothing can move it.
    svc.batchTransitionWeek(T, 1, ts, "FINALIZE", [rep.memberId, tl.memberId, mgr.memberId]);
    const lockedRep = stmtFor(rep.memberId);
    expect(lockedRep.status).toBe("FINALIZED");
    let lockErr: any;
    try {
      svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "e2e-late", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    } catch (e) { lockErr = e; }
    expect(lockErr?.code).toBe("STATEMENT_LOCKED");
    expect(stmtFor(rep.memberId).final_commission_cents).toBe(lockedRep.final_commission_cents);

    // 4. POISON EVENT — the queue stops, visibly, without skipping.
    // Drain the GENUINE sale events first. commissionService now emits
    // SALE_APPROVED/SALE_CANCELLED at its write sites, so the qualification and
    // reversal above left real events in this queue; without this the fault
    // below would halt on one of THOSE (correctly - the queue never skips) and
    // the synthetic poison event would never be reached. Drained here, before
    // the campaign exists, so nothing is awarded for them.
    S.drain(ts);
    S.createCampaign({
      tenantId: T, name: "E2E spiff", incentiveType: "PRODUCT_SPIFF", amountBasis: "FLAT",
      rewardCents: 5000, startsAtMs: Date.parse(ts) - 86_400_000, endsAtMs: Date.parse(ts) + 86_400_000,
      approvalRequired: false, nowIso: ts,
    } as any);
    const ev = E.emit({
      tenantId: T, type: "SALE_APPROVED", subjectType: "sale", subjectId: 424242,
      subjectRepId: rep.memberId, occurredAt: ts, payload: {},
    }, ts);
    fault.always = true;
    const stalled = S.drain(ts);
    expect(stalled.failed).toHaveLength(1);
    expect(queueOps.getState(S.SUBSCRIBER_NAME, ev.id).status).toBe("failed");

    // The stall is operator-visible…
    const health = queueOps.queueHealth(S.SUBSCRIBER_NAME, T);
    expect(health.halted.some(h => h.eventId === ev.id)).toBe(true);

    // …and reconciliation reports it as a blocked queue event.
    const midRun = recon.reconcile({ tenantId: T, nowIso: ts, runId: "e2e-mid" });
    expect(midRun.findings.some(f => f.kind === "BLOCKED_QUEUE_EVENT")).toBe(true);

    // 5. OPERATOR RETRY — with a reason, audited, and the queue resumes.
    fault.always = false;
    await queueOps.operatorAction({
      tenantId: T, subscriber: S.SUBSCRIBER_NAME, eventId: ev.id, action: "RETRY",
      actorUserId: mgr.userId, reason: "dependency restored; safe to reprocess",
    });
    const resumed = S.drain(ts);
    expect(resumed.processed).toBe(1);
    expect(resumed.failed).toHaveLength(0);
    expect(queueOps.getState(S.SUBSCRIBER_NAME, ev.id).status).toBe("completed");

    // 6. RECOVERY — cursor consistent, nothing holding, no duplicate awards.
    const recovery = queueOps.recoveryReport(S.SUBSCRIBER_NAME, T);
    expect(recovery.stillHolding).toEqual([]);
    expect(recovery.duplicateAwards).toEqual([]);
    expect(recovery.cursorConsistent).toBe(true);

    // 7. RECONCILIATION — the queue finding is gone and the locked week is intact.
    const finalRun = recon.reconcile({ tenantId: T, nowIso: ts, runId: "e2e-final" });
    expect(finalRun.findings.some(f => f.kind === "BLOCKED_QUEUE_EVENT")).toBe(false);
    expect(stmtFor(rep.memberId).final_commission_cents).toBe(lockedRep.final_commission_cents);
  });
});
