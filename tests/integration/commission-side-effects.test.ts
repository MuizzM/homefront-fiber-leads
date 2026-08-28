// ── Sale side effects and closeout isolation ─────────────────────────────────
//
// Two confirmed defects, both found by adversarial review of an earlier fix pass:
//
//   FIX 1 — `upsertSale` wrote, logged and returned. `syncOverridesForSale` had
//   exactly two callers and neither was it, so `POST /api/commission/sales` —
//   the door that same function's comment calls the safe write site — booked a
//   QUALIFIED sale that paid no upline and refreshed no statement. Nothing
//   repaired it later (`overrideBlockForWeek` only SUMs rows that already
//   exist), so the money was simply absent. Latent only while both override
//   rate columns are $0.
//
//   FIX 2 — `batchTransitionWeek` ran the recompute and the lock bare inside its
//   per-rep loop, so ONE rep's throw propagated out of the whole closeout: reps
//   before it stayed FINALIZED, everyone after stayed OPEN, and the results
//   array — the only record of who had already been locked — was discarded with
//   the exception.
//
// Everything here runs with NON-DEFAULT override rates, because $0 rates are
// exactly what hid FIX 1.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// A switchable fault injected into a COLLABORATOR of the closeout loop. Set
// `fault.repId` to make that one rep's hourly lookup throw a raw TypeError —
// the "unexpected exception arriving from a dependency" shape, as opposed to a
// CommissionError the loop already understands. Inert (repId -1) by default, so
// every other test in this file runs against the real implementation.
const fault = vi.hoisted(() => ({ repId: -1 }));
vi.mock("../../server/hourlyPay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/hourlyPay")>();
  return {
    ...actual,
    hourlyPayForWeek: (...args: any[]) => {
      if (args[1] === fault.repId) throw new TypeError("simulated collaborator fault");
      return (actual.hourlyPayForWeek as any)(...args);
    },
  };
});

let svc: typeof import("../../server/commissionService");
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let weekBoundsFor: (typeof import("../../shared/workweek"))["weekBoundsFor"];

const T = 1;          // default tenant, created by runMigrations
const T_OTHER = 7742; // a second org, for isolation checks

const TL_CENTS = 2500;   // non-default: team lead keeps $25 per downline sale
const MGR_CENTS = 7500;  // non-default: manager keeps $75

type Person = { memberId: number; userId: number };
let seq = 0;
function person(name: string, role: string, reportsToId: number | null, tenantId = T): Person {
  seq += 1;
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${seq}@side-effects.example.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, reportsToId, tenantId } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: m.id } as any);
  return { memberId: m.id, userId: u.id };
}

const WEEK_REF = "2026-06-10T12:00:00Z";     // Wed of the Jun 8–14 2026 week
let inWeekTs = "";
let nextWeekTs = "";

const overridesFor = (saleId: number): any[] =>
  rawDb.prepare(`SELECT * FROM commission_overrides WHERE tenant_id = ? AND source_ref = ? ORDER BY id`)
    .all(T, `sale:${saleId}`) as any[];
const stmtFor = (repId: number, weekStartUtc: string): any =>
  rawDb.prepare(`SELECT * FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`)
    .get(T, repId, weekStartUtc);

let mgr: Person, tl: Person, rep: Person;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-side-effects-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  svc = await import("../../server/commissionService");
  ({ weekBoundsFor } = await import("../../shared/workweek"));

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'other-side-effects', 'Other Org', 'Owner O', 'owner@other.example.test', 'Other')`,
  ).run(T_OTHER);

  const b = weekBoundsFor(WEEK_REF, svc.loadOrgConfig(T));
  inWeekTs = new Date(Date.parse(b.weekStartUtc) + 2 * 86_400_000).toISOString();
  nextWeekTs = new Date(Date.parse(b.nextWeekStartUtc) + 2 * 86_400_000).toISOString();

  // mgr ← tl ← rep, with NON-ZERO override rates. This is the configuration the
  // defect was invisible under when the rates were left at their $0 default.
  mgr = person("SE Manager", "manager", null);
  tl = person("SE Lead", "team_lead", mgr.memberId);
  rep = person("SE Rep", "rep", tl.memberId);
  svc.updateOrgConfig(T, null, {
    overridesEnabled: true, overrideTeamLeadCents: TL_CENTS, overrideManagerCents: MGR_CENTS,
  } as any);
  svc.assignStructureToRep(T, 1, { repId: rep.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX 1 — upsertSale side effects
// ═══════════════════════════════════════════════════════════════════════════
describe("FIX 1: a QUALIFIED sale booked through upsertSale pays its upline", () => {
  it("THE DEFECT: creates the override rows the chain is owed", () => {
    const sale = svc.upsertSale(T, 1, {
      repId: rep.memberId, externalId: "se-1", status: "QUALIFIED",
      soldAt: inWeekTs, qualifiedAt: inWeekTs,
    });
    const rows = overridesFor(sale.id).filter(r => r.entry_type === "EARN");
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.beneficiary_rep_id === tl.memberId)).toMatchObject({ amount_cents: TL_CENTS, beneficiary_role: "team_lead", status: "PAYABLE" });
    expect(rows.find(r => r.beneficiary_rep_id === mgr.memberId)).toMatchObject({ amount_cents: MGR_CENTS, beneficiary_role: "manager", status: "PAYABLE" });
  });

  it("refreshes the affected unlocked statements - seller AND uplines", () => {
    const week = weekBoundsFor(inWeekTs, svc.loadOrgConfig(T)).weekStartUtc;
    // The seller's own statement exists and prices the sale.
    expect(stmtFor(rep.memberId, week).gross_commission_cents).toBe(20000);
    // The uplines' statements exist purely from override money.
    expect(stmtFor(tl.memberId, week).override_pay_cents).toBe(TL_CENTS);
    expect(stmtFor(mgr.memberId, week).override_pay_cents).toBe(MGR_CENTS);
    expect(stmtFor(mgr.memberId, week).final_commission_cents).toBe(MGR_CENTS);
  });

  it("is IDEMPOTENT - the same upsert repeated mints no second earn and no second payment", () => {
    const before = overridesFor(svc.getSaleByExternalId(T, "se-1").id).length;
    const tlBefore = stmtFor(tl.memberId, weekBoundsFor(inWeekTs, svc.loadOrgConfig(T)).weekStartUtc).override_pay_cents;
    for (let i = 0; i < 3; i++) {
      svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "se-1", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    }
    const sale = svc.getSaleByExternalId(T, "se-1");
    expect(overridesFor(sale.id)).toHaveLength(before);
    expect(stmtFor(tl.memberId, weekBoundsFor(inWeekTs, svc.loadOrgConfig(T)).weekStartUtc).override_pay_cents).toBe(tlBefore);
  });

  it("de-qualifying through upsertSale claws the overrides back and nets the fold to zero", () => {
    const week = weekBoundsFor(inWeekTs, svc.loadOrgConfig(T)).weekStartUtc;
    svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "se-dq", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const saleId = svc.getSaleByExternalId(T, "se-dq").id;
    expect(overridesFor(saleId).filter(r => r.entry_type === "EARN")).toHaveLength(2);
    const paidBefore = stmtFor(mgr.memberId, week).override_pay_cents;

    // Same door, now PENDING — the sale stops qualifying.
    svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "se-dq", status: "PENDING", soldAt: inWeekTs, qualifiedAt: inWeekTs });

    const claws = overridesFor(saleId).filter(r => r.entry_type === "CLAWBACK");
    expect(claws).toHaveLength(2);
    // Earn + claw net to zero, so the manager's week drops back by exactly the
    // manager slot — no stale override left behind.
    expect(stmtFor(mgr.memberId, week).override_pay_cents).toBe(paidBefore - MGR_CENTS);
  });

  it("a reversal through transitionSale reconciles the same way (one shared path)", () => {
    const week = weekBoundsFor(inWeekTs, svc.loadOrgConfig(T)).weekStartUtc;
    svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "se-rev", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const saleId = svc.getSaleByExternalId(T, "se-rev").id;
    const before = stmtFor(tl.memberId, week).override_pay_cents;
    svc.transitionSale(T, 1, "se-rev", "REVERSE");
    expect(overridesFor(saleId).filter(r => r.entry_type === "CLAWBACK")).toHaveLength(2);
    expect(stmtFor(tl.memberId, week).override_pay_cents).toBe(before - TL_CENTS);
  });

  it("moving an unqualified sale to a different pay week refreshes the NEW week and leaves no stale override", () => {
    const cfg = svc.loadOrgConfig(T);
    const weekA = weekBoundsFor(inWeekTs, cfg).weekStartUtc;
    const weekB = weekBoundsFor(nextWeekTs, cfg).weekStartUtc;
    expect(weekA).not.toBe(weekB);

    // Booked PENDING in week A — no overrides yet (only QUALIFIED sales earn).
    svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "se-move", status: "PENDING", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const saleId = svc.getSaleByExternalId(T, "se-move").id;
    expect(overridesFor(saleId)).toHaveLength(0);

    // Now qualified into week B.
    svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "se-move", status: "QUALIFIED", soldAt: nextWeekTs, qualifiedAt: nextWeekTs });
    const earns = overridesFor(saleId).filter(r => r.entry_type === "EARN");
    expect(earns).toHaveLength(2);
    // The earns belong to week B, and week A is untouched by them.
    for (const e of earns) expect(e.earned_week_start_utc).toBe(weekB);
    expect(stmtFor(mgr.memberId, weekB).override_pay_cents).toBe(MGR_CENTS);
  });
});

describe("FIX 1: a locked week is never mutated by a sale write", () => {
  it("refuses the QUALIFIED write, leaves the frozen totals alone, and logs an auditable outcome", () => {
    const lockRep = person("SE Locked Rep", "rep", tl.memberId);
    svc.assignStructureToRep(T, 1, { repId: lockRep.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    svc.upsertSale(T, 1, { repId: lockRep.memberId, externalId: "se-lock-1", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const week = weekBoundsFor(inWeekTs, svc.loadOrgConfig(T)).weekStartUtc;
    svc.calculateOrRecalculateStatement({ tenantId: T, repId: lockRep.memberId, weekReference: WEEK_REF, actorId: 1 });
    svc.batchTransitionWeek(T, 1, WEEK_REF, "FINALIZE", [lockRep.memberId]);

    const frozen = stmtFor(lockRep.memberId, week);
    expect(frozen.status).toBe("FINALIZED");

    let err: any;
    try {
      svc.upsertSale(T, 1, { repId: lockRep.memberId, externalId: "se-lock-2", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    } catch (e) { err = e; }
    expect(err?.code).toBe("STATEMENT_LOCKED");

    // Historical totals are byte-identical, and the refused sale never landed.
    const after = stmtFor(lockRep.memberId, week);
    expect(after.final_commission_cents).toBe(frozen.final_commission_cents);
    expect(after.gross_commission_cents).toBe(frozen.gross_commission_cents);
    expect(svc.getSaleByExternalId(T, "se-lock-2")).toBeFalsy();

    // …and the refusal is auditable.
    const logged = rawDb.prepare(
      `SELECT COUNT(*) AS c FROM activity_log WHERE action = 'commission_sale.locked_week_blocked'`,
    ).get() as any;
    expect(logged.c).toBeGreaterThan(0);
  });

  it("an override earned into a LOCKED upline week books an EXCEPTION rather than injecting money", () => {
    const week = weekBoundsFor(inWeekTs, svc.loadOrgConfig(T)).weekStartUtc;
    // Freeze the team lead's week, then have their downline sell again.
    svc.calculateOrRecalculateStatement({ tenantId: T, repId: tl.memberId, weekReference: WEEK_REF, actorId: 1 });
    const tlStmt = stmtFor(tl.memberId, week);
    const frozenTl = svc.transitionStatement(T, 1, tlStmt.id, "FINALIZE");

    svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "se-lock-upline", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const saleId = svc.getSaleByExternalId(T, "se-lock-upline").id;
    const tlRow = overridesFor(saleId).find(r => r.beneficiary_rep_id === tl.memberId);
    expect(tlRow).toMatchObject({ entry_type: "EARN", status: "EXCEPTION", reason: "LOCKED_WEEK_EARN" });
    // The locked statement did not move.
    expect(stmtFor(tl.memberId, week).final_commission_cents).toBe(frozenTl.final_commission_cents);
    // The manager's week is open, so their slot is ordinary money.
    expect(overridesFor(saleId).find(r => r.beneficiary_rep_id === mgr.memberId)!.status).toBe("PAYABLE");

    svc.transitionStatement(T, 1, tlStmt.id, "REOPEN");   // restore for later tests
  });
});

describe("FIX 1: isolation - a sale write cannot reach another org or another branch", () => {
  it("refuses a rep from a different organization outright", () => {
    const foreign = person("SE Foreign Rep", "rep", null, T_OTHER);
    let err: any;
    try {
      svc.upsertSale(T, 1, { repId: foreign.memberId, externalId: "se-foreign", status: "QUALIFIED", soldAt: inWeekTs });
    } catch (e) { err = e; }
    expect(err?.code).toBe("CROSS_TENANT_ACCESS");
    // No sale, and no override rows anywhere.
    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM commission_sales WHERE external_id = 'se-foreign'`).get())
      .toMatchObject({ c: 0 });
    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM commission_overrides WHERE tenant_id = ?`).get(T_OTHER))
      .toMatchObject({ c: 0 });
  });

  it("pays the chain that existed at EARN time, and a later re-home does not re-attribute it", () => {
    const week = weekBoundsFor(inWeekTs, svc.loadOrgConfig(T)).weekStartUtc;
    const mgr2 = person("SE Manager Two", "manager", null);
    svc.assignStructureToRep(T, 1, { repId: mgr2.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    svc.upsertSale(T, 1, { repId: rep.memberId, externalId: "se-frozen-chain", status: "QUALIFIED", soldAt: inWeekTs, qualifiedAt: inWeekTs });
    const saleId = svc.getSaleByExternalId(T, "se-frozen-chain").id;
    const earnedBy = overridesFor(saleId).filter(r => r.entry_type === "EARN").map(r => r.beneficiary_rep_id).sort();
    expect(earnedBy).toEqual([tl.memberId, mgr.memberId].sort());

    // Move the whole branch under a different manager AFTER the earn.
    rawDb.prepare(`UPDATE team_members SET reports_to_id = ? WHERE id = ?`).run(mgr2.memberId, tl.memberId);
    svc.calculateOrRecalculateStatement({ tenantId: T, repId: mgr2.memberId, weekReference: WEEK_REF, actorId: 1 });

    // The earned rows still name the original chain; the new manager got nothing
    // for a sale that happened before they owned the branch.
    const after = overridesFor(saleId).filter(r => r.entry_type === "EARN").map(r => r.beneficiary_rep_id).sort();
    expect(after).toEqual(earnedBy);
    expect(stmtFor(mgr2.memberId, week)?.override_pay_cents ?? 0).toBe(0);

    rawDb.prepare(`UPDATE team_members SET reports_to_id = ? WHERE id = ?`).run(mgr.memberId, tl.memberId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX 2 — batchTransitionWeek per-rep isolation
// ═══════════════════════════════════════════════════════════════════════════
describe("FIX 2: one rep's failure does not abort the weekly closeout", () => {
  const BATCH_WEEK_REF = "2026-07-15T12:00:00Z";
  let batchWeek = "";
  let r1: Person, r2: Person, r3: Person;
  let batchTs = "";

  beforeAll(() => {
    const cfg = svc.loadOrgConfig(T);
    batchWeek = weekBoundsFor(BATCH_WEEK_REF, cfg).weekStartUtc;
    batchTs = new Date(Date.parse(batchWeek) + 2 * 86_400_000).toISOString();

    // Three eligible reps, each with a plan and one qualified sale. They report
    // to nobody, so their closeout is independent of the override fixtures above.
    r1 = person("Batch Rep One", "rep", null);
    r2 = person("Batch Rep Two", "rep", null);
    r3 = person("Batch Rep Three", "rep", null);
    for (const p of [r1, r2, r3]) {
      svc.assignStructureToRep(T, 1, { repId: p.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
      svc.upsertSale(T, 1, { repId: p.memberId, externalId: `batch-${p.memberId}`, status: "QUALIFIED", soldAt: batchTs, qualifiedAt: batchTs });
    }
  });

  it("THE DEFECT: the MIDDLE rep throws, and reps one and three still finalize", () => {
    // An open clock punch is a real, product-level per-rep blocker; a raw fault
    // is covered separately below.
    rawDb.prepare(`UPDATE team_members SET hourly_rate_cents = 2000, hourly_rate_effective_from = '2026-01-01' WHERE id = ?`).run(r2.memberId);
    rawDb.prepare(
      `INSERT INTO clock_sessions (rep_id, user_id, tenant_id, clocked_in, clocked_out, date)
       VALUES (?,?,?,?,NULL,?)`,
    ).run(r2.memberId, r2.userId, T, batchTs, batchTs.slice(0, 10));

    const out = svc.batchTransitionWeek(T, 1, BATCH_WEEK_REF, "FINALIZE", [r1.memberId, r2.memberId, r3.memberId]);

    const byRep = new Map(out.results.map(r => [r.repId, r]));
    expect(byRep.get(r1.memberId)).toMatchObject({ outcome: "ok", result: "FINALIZED" });
    expect(byRep.get(r3.memberId)).toMatchObject({ outcome: "ok", result: "FINALIZED" });
    // The middle rep is reported, with an actionable reason and retry eligibility.
    expect(byRep.get(r2.memberId)).toMatchObject({ outcome: "blocked", code: "OPEN_CLOCK_SESSION", retryable: true });
    expect(byRep.get(r2.memberId)!.result).toMatch(/close the open clock session/i);

    // The report covers all three, and carries a correlation id.
    expect(out.results.length).toBe(3);
    expect(out.summary).toMatchObject({ ok: 2, blocked: 1, failed: 0 });
    expect(out.runId).toContain("week-finalize:");
  });

  it("the blocked rep has NO partial statement, ledger, reserve or status mutation", () => {
    const s = stmtFor(r2.memberId, batchWeek);
    expect(s.status).toBe("OPEN");                       // never half-transitioned
    expect(s.finalized_at).toBeFalsy();
    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM reserve_entries WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`)
      .get(T, r2.memberId, batchWeek)).toMatchObject({ c: 0 });
  });

  it("RERUN after correcting the failure completes only that rep and duplicates nothing", () => {
    const r1Stmt = stmtFor(r1.memberId, batchWeek);
    const reserveBefore = rawDb.prepare(`SELECT COUNT(*) AS c FROM reserve_entries WHERE tenant_id = ? AND rep_id = ?`)
      .get(T, r1.memberId) as any;

    // Close the punch — the blocker is gone.
    rawDb.prepare(`UPDATE clock_sessions SET clocked_out = ?, duration_minutes = 60 WHERE rep_id = ? AND clocked_out IS NULL`)
      .run(new Date(Date.parse(batchTs) + 3_600_000).toISOString(), r2.memberId);

    const out = svc.batchTransitionWeek(T, 1, BATCH_WEEK_REF, "FINALIZE", [r1.memberId, r2.memberId, r3.memberId]);
    const byRep = new Map(out.results.map(r => [r.repId, r]));

    // The previously blocked rep now completes…
    expect(byRep.get(r2.memberId)).toMatchObject({ outcome: "ok", result: "FINALIZED" });
    // …and the already-done reps are SKIPPED, not re-transitioned.
    expect(byRep.get(r1.memberId)).toMatchObject({ outcome: "skipped", code: "ALREADY_FINALIZED", retryable: false });
    expect(byRep.get(r3.memberId)!.outcome).toBe("skipped");

    // No duplicated accounting for the completed rep.
    expect(stmtFor(r1.memberId, batchWeek).finalized_at).toBe(r1Stmt.finalized_at);
    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM reserve_entries WHERE tenant_id = ? AND rep_id = ?`).get(T, r1.memberId))
      .toMatchObject({ c: reserveBefore.c });
  });

  it("an UNEXPECTED exception is isolated to its rep and reported as retryable", () => {
    const bad1 = person("Fault Rep One", "rep", null);
    const bad2 = person("Fault Rep Two", "rep", null);
    const good = person("Fault Rep Good", "rep", null);
    const ref = "2026-07-22T12:00:00Z";
    const cfg = svc.loadOrgConfig(T);
    const week = weekBoundsFor(ref, cfg).weekStartUtc;
    const ts = new Date(Date.parse(week) + 2 * 86_400_000).toISOString();
    for (const p of [bad1, bad2, good]) {
      svc.assignStructureToRep(T, 1, { repId: p.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
      svc.upsertSale(T, 1, { repId: p.memberId, externalId: `fault-${p.memberId}`, status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    }

    // Make ONE rep's hourly lookup throw — a raw, non-CommissionError fault
    // arriving from a collaborator, which is the shape that used to kill the run.
    let out: ReturnType<typeof svc.batchTransitionWeek>;
    fault.repId = bad1.memberId;
    try {
      out = svc.batchTransitionWeek(T, 1, ref, "FINALIZE", [bad1.memberId, bad2.memberId, good.memberId]);
    } finally {
      fault.repId = -1;
    }

    const byRep = new Map(out.results.map(r => [r.repId, r]));
    expect(byRep.get(bad1.memberId)).toMatchObject({ outcome: "failed", code: "UNEXPECTED_ERROR", retryable: true });
    expect(byRep.get(bad1.memberId)!.result).toContain("simulated collaborator fault");
    // The other two are untouched by it.
    expect(byRep.get(bad2.memberId)).toMatchObject({ outcome: "ok" });
    expect(byRep.get(good.memberId)).toMatchObject({ outcome: "ok" });
    expect(out.summary).toMatchObject({ ok: 2, failed: 1 });
    // The failed rep stayed OPEN — no partial transition.
    expect(stmtFor(bad1.memberId, week).status).toBe("OPEN");
  });

  it("a rep with sales but NO plan is reported as blocked, and the rest of the week still closes", () => {
    const noPlan = person("No Plan Rep", "rep", null);
    const withPlan = person("With Plan Rep", "rep", null);
    const ref = "2026-07-29T12:00:00Z";
    const week = weekBoundsFor(ref, svc.loadOrgConfig(T)).weekStartUtc;
    const ts = new Date(Date.parse(week) + 2 * 86_400_000).toISOString();
    svc.assignStructureToRep(T, 1, { repId: withPlan.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    for (const p of [noPlan, withPlan]) {
      svc.upsertSale(T, 1, { repId: p.memberId, externalId: `noplan-${p.memberId}`, status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    }

    const out = svc.batchTransitionWeek(T, 1, ref, "FINALIZE", [noPlan.memberId, withPlan.memberId]);
    const byRep = new Map(out.results.map(r => [r.repId, r]));
    expect(byRep.get(noPlan.memberId)).toMatchObject({ outcome: "blocked", code: "NO_EFFECTIVE_PLAN_ASSIGNMENT", retryable: true });
    expect(byRep.get(withPlan.memberId)).toMatchObject({ outcome: "ok", result: "FINALIZED" });
    // The blocked rep is reported EXACTLY once, not twice.
    expect(out.results.filter(r => r.repId === noPlan.memberId)).toHaveLength(1);
  });

  it("closeout cannot leak results or accounting between organizations", () => {
    const ref = "2026-08-05T12:00:00Z";
    const week = weekBoundsFor(ref, svc.loadOrgConfig(T)).weekStartUtc;
    const ts = new Date(Date.parse(week) + 2 * 86_400_000).toISOString();

    const mine = person("Iso Mine", "rep", null);
    svc.assignStructureToRep(T, 1, { repId: mine.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    svc.upsertSale(T, 1, { repId: mine.memberId, externalId: `iso-${mine.memberId}`, status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });

    const theirs = person("Iso Theirs", "rep", null, T_OTHER);
    svc.assignStructureToRep(T_OTHER, 1, { repId: theirs.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    svc.upsertSale(T_OTHER, 1, { repId: theirs.memberId, externalId: `iso-${theirs.memberId}`, status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    svc.calculateOrRecalculateStatement({ tenantId: T_OTHER, repId: theirs.memberId, weekReference: ref, actorId: 1 });

    const out = svc.batchTransitionWeek(T, 1, ref, "FINALIZE");
    // Only this org's reps appear in this org's report…
    expect(out.results.some(r => r.repId === theirs.memberId)).toBe(false);
    expect(out.results.some(r => r.repId === mine.memberId)).toBe(true);
    // …and the other org's statement is untouched.
    const other = rawDb.prepare(
      `SELECT status FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T_OTHER, theirs.memberId, week) as any;
    expect(other.status).toBe("OPEN");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NON-DEFAULT CONFIGURATION — the shapes the existing suite never exercised.
// Every defect this file fixes lived in one: $0 override rates, a QUALIFIED_AT
// basis, and soldAt === qualifiedAt.
// ═══════════════════════════════════════════════════════════════════════════
describe("non-default basis with soldAt / qualifiedAt / installedAt in three different weeks", () => {
  const T_BASIS = 7743;
  let bRep: Person, bTl: Person, bMgr: Person;
  let soldWeek = "", qualWeek = "", instWeek = "";
  let soldTs = "", qualTs = "", instTs = "";

  const bStmt = (repId: number, week: string): any =>
    rawDb.prepare(`SELECT * FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`)
      .get(T_BASIS, repId, week);

  beforeAll(() => {
    rawDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
       VALUES (?, 'basis-org', 'Basis Org', 'Owner B', 'owner@basis.example.test', 'Basis')`,
    ).run(T_BASIS);

    bMgr = person("Basis Manager", "manager", null, T_BASIS);
    bTl = person("Basis Lead", "team_lead", bMgr.memberId, T_BASIS);
    bRep = person("Basis Rep", "rep", bTl.memberId, T_BASIS);

    // NON-DEFAULT everywhere: INSTALLED_AT basis and non-zero override rates.
    svc.updateOrgConfig(T_BASIS, null, {
      commissionQualificationBasis: "INSTALLED_AT",
      overridesEnabled: true, overrideTeamLeadCents: TL_CENTS, overrideManagerCents: MGR_CENTS,
    } as any);
    // The plan VERSION carries its own qualification basis, and that is the one
    // the statement counts by — so it must be set here, not only on the org
    // config. (The two being separate sources is itself a finding; see the
    // divergence test at the end of this file.)
    const plan = svc.createPlan(T_BASIS, 1, { name: "Install Basis Plan", type: "FLAT" } as any);
    const version = svc.addPlanVersion(T_BASIS, 1, plan.id, {
      effectiveFrom: "2026-01-01", qualificationBasis: "INSTALLED_AT", flatRateCents: 20000,
    } as any);
    svc.activatePlan(T_BASIS, 1, plan.id);
    // Only the seller needs an assignment: an upline whose entire week is
    // override money is admitted to a statement by the override rows themselves
    // (managerHasPayableSurface), which is exactly the path being exercised.
    svc.assignPlanVersionToRep(T_BASIS, 1, {
      repId: bRep.memberId, commissionPlanVersionId: version.id, effectiveFrom: "2026-01-01",
    } as any);

    const cfg = svc.loadOrgConfig(T_BASIS);
    soldTs = "2026-09-02T15:00:00.000Z";                                    // week A
    qualTs = new Date(Date.parse(soldTs) + 7 * 86_400_000).toISOString();   // week B
    instTs = new Date(Date.parse(soldTs) + 21 * 86_400_000).toISOString();  // week D
    soldWeek = weekBoundsFor(soldTs, cfg).weekStartUtc;
    qualWeek = weekBoundsFor(qualTs, cfg).weekStartUtc;
    instWeek = weekBoundsFor(instTs, cfg).weekStartUtc;
    expect(new Set([soldWeek, qualWeek, instWeek]).size).toBe(3);   // three distinct weeks
  });

  it("pays in the INSTALLED_AT week - not the sold or qualified week", () => {
    svc.upsertSale(T_BASIS, 1, {
      repId: bRep.memberId, externalId: "basis-1", status: "QUALIFIED",
      soldAt: soldTs, qualifiedAt: qualTs, installedAt: instTs,
    });
    expect(bStmt(bRep.memberId, instWeek).gross_commission_cents).toBe(20000);
    expect(bStmt(bRep.memberId, soldWeek)?.gross_commission_cents ?? 0).toBe(0);
    expect(bStmt(bRep.memberId, qualWeek)?.gross_commission_cents ?? 0).toBe(0);
  });

  it("earns the overrides in that same INSTALLED_AT week", () => {
    const saleId = svc.getSaleByExternalId(T_BASIS, "basis-1").id;
    const earns = (rawDb.prepare(`SELECT * FROM commission_overrides WHERE tenant_id = ? AND source_ref = ?`)
      .all(T_BASIS, `sale:${saleId}`) as any[]).filter(r => r.entry_type === "EARN");
    expect(earns).toHaveLength(2);
    for (const e of earns) expect(e.earned_week_start_utc).toBe(instWeek);
    expect(bStmt(bTl.memberId, instWeek).override_pay_cents).toBe(TL_CENTS);
    expect(bStmt(bMgr.memberId, instWeek).override_pay_cents).toBe(MGR_CENTS);
  });

  it("first-time install stamping is allowed and moves the pay week forward", () => {
    // Booked with no install yet — under INSTALLED_AT it counts in no week.
    svc.upsertSale(T_BASIS, 1, { repId: bRep.memberId, externalId: "basis-2", status: "QUALIFIED", soldAt: soldTs, qualifiedAt: qualTs });
    const beforeInstall = bStmt(bRep.memberId, instWeek).gross_commission_cents;

    // Confirm the install — this is the write the sold_at fallback used to 409.
    expect(() =>
      svc.upsertSale(T_BASIS, 1, {
        repId: bRep.memberId, externalId: "basis-2", status: "QUALIFIED",
        soldAt: soldTs, qualifiedAt: qualTs, installedAt: instTs,
      }),
    ).not.toThrow();
    expect(bStmt(bRep.memberId, instWeek).gross_commission_cents).toBe(beforeInstall + 20000);
  });

  it("the server-stamped correction window clamps the INSTALL date too, not just soldAt", () => {
    // A caller claiming an install 400 days before the server received it can no
    // longer place the money in a long-settled week.
    const claimed = new Date(Date.parse(instTs) - 400 * 86_400_000).toISOString();
    svc.upsertSale(T_BASIS, 1, {
      repId: bRep.memberId, externalId: "basis-clamped", status: "PENDING",
      soldAt: soldTs, installedAt: claimed, serverReceivedAt: instTs,
    });
    const stored = svc.getSaleByExternalId(T_BASIS, "basis-clamped").installed_at;
    const floor = Date.parse(instTs) - 30 * 86_400_000;
    expect(Date.parse(stored)).toBe(floor);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BASIS DIVERGENCE — eliminated.
//
// The basis had TWO sources that could disagree:
//   · `tenants.commission_qualification_basis` picked the week a sale WRITE
//     recomputed, and
//   · `commission_plan_versions.qualification_basis` picked the week the
//     statement COUNTED.
// A sale could therefore be recomputed into a week that did not count it.
//
// Now every commission-relevant operation resolves the basis from ONE place:
// an immutable `commission_sales.qualification_basis` snapshot, stamped from the
// plan version effective when the sale first became commission-relevant.
// ═══════════════════════════════════════════════════════════════════════════
describe("qualification basis has one source of truth", () => {
  const T_DIV = 7744;
  let dRep: Person;
  const at = (week: string) => rawDb.prepare(
    `SELECT qualified_sale_count AS n, gross_commission_cents AS c, qualification_basis AS basis
       FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
  ).get(T_DIV, dRep.memberId, week) as any;

  beforeAll(() => {
    rawDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
       VALUES (?, 'divergent-org', 'Divergent Org', 'Owner D', 'owner@divergent.example.test', 'Divergent')`,
    ).run(T_DIV);
    dRep = person("Divergent Rep", "rep", null, T_DIV);
    svc.updateOrgConfig(T_DIV, null, { commissionQualificationBasis: "INSTALLED_AT" } as any);
    // The plan is created AFTER the org chose INSTALLED_AT, so the version must
    // inherit it rather than the old hardcoded QUALIFIED_AT.
    svc.assignStructureToRep(T_DIV, 1, { repId: dRep.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
  });

  it("a new plan version inherits the org basis instead of hardcoding QUALIFIED_AT", () => {
    const v = rawDb.prepare(
      `SELECT v.qualification_basis AS basis FROM commission_plan_versions v
         JOIN commission_plans p ON p.id = v.commission_plan_id
        WHERE p.tenant_id = ? ORDER BY v.id DESC LIMIT 1`,
    ).get(T_DIV) as any;
    expect(v.basis).toBe("INSTALLED_AT");
  });

  it("THE DEFECT: recompute week and count week are the same week", () => {
    const soldTs = "2026-10-07T15:00:00.000Z";
    const instTs = new Date(Date.parse(soldTs) + 21 * 86_400_000).toISOString();
    const cfg = svc.loadOrgConfig(T_DIV);
    const installWeek = weekBoundsFor(instTs, cfg).weekStartUtc;
    const soldWeek = weekBoundsFor(soldTs, cfg).weekStartUtc;
    expect(installWeek).not.toBe(soldWeek);

    svc.upsertSale(T_DIV, 1, {
      repId: dRep.memberId, externalId: "div-1", status: "QUALIFIED",
      soldAt: soldTs, qualifiedAt: soldTs, installedAt: instTs,
    });

    // The install week both received the statement AND counted the sale.
    const stmt = at(installWeek);
    expect(stmt.basis).toBe("INSTALLED_AT");
    expect(stmt.n).toBe(1);
    expect(stmt.c).toBe(20000);
    // No orphan statement in the week that merely held sold_at.
    expect(at(soldWeek)?.c ?? 0).toBe(0);
  });

  it("the sale carries an IMMUTABLE basis snapshot", () => {
    expect(svc.getSaleByExternalId(T_DIV, "div-1").qualification_basis).toBe("INSTALLED_AT");
  });

  it("changing tenant config afterwards does NOT re-week the existing sale", () => {
    const cfg = svc.loadOrgConfig(T_DIV);
    const instTs = new Date(Date.parse("2026-10-07T15:00:00.000Z") + 21 * 86_400_000).toISOString();
    const installWeek = weekBoundsFor(instTs, cfg).weekStartUtc;

    // Flip the org to a different basis. Mutable config must not reinterpret
    // history, so the frozen snapshot has to win.
    svc.updateOrgConfig(T_DIV, null, { commissionQualificationBasis: "SOLD_AT" } as any);
    svc.upsertSale(T_DIV, 1, {
      repId: dRep.memberId, externalId: "div-1", status: "QUALIFIED",
      soldAt: "2026-10-07T15:00:00.000Z", qualifiedAt: "2026-10-07T15:00:00.000Z", installedAt: instTs,
    });
    expect(svc.getSaleByExternalId(T_DIV, "div-1").qualification_basis).toBe("INSTALLED_AT");
    expect(at(installWeek).c).toBe(20000);

    svc.updateOrgConfig(T_DIV, null, { commissionQualificationBasis: "INSTALLED_AT" } as any);
  });

  it("a basis change is refused once any week is locked - it would re-key locked weeks", () => {
    const lockOrg = 7745;
    rawDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
       VALUES (?, 'lockbasis-org', 'Lock Basis', 'Owner L', 'owner@lockbasis.example.test', 'Lock')`,
    ).run(lockOrg);
    const lRep = person("Lock Basis Rep", "rep", null, lockOrg);
    svc.assignStructureToRep(lockOrg, 1, { repId: lRep.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
    const ts = "2026-11-04T15:00:00.000Z";
    svc.upsertSale(lockOrg, 1, { repId: lRep.memberId, externalId: "lock-b1", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    svc.calculateOrRecalculateStatement({ tenantId: lockOrg, repId: lRep.memberId, weekReference: ts, actorId: 1 });
    svc.batchTransitionWeek(lockOrg, 1, ts, "FINALIZE", [lRep.memberId]);

    const frozen = rawDb.prepare(
      `SELECT gross_commission_cents AS c, qualification_basis AS basis FROM commission_statements
        WHERE tenant_id = ? AND rep_id = ?`,
    ).get(lockOrg, lRep.memberId) as any;

    let err: any;
    try { svc.updateOrgConfig(lockOrg, null, { commissionQualificationBasis: "SOLD_AT" } as any); }
    catch (e) { err = e; }
    expect(err?.code).toBe("WEEK_KEY_FROZEN");

    // The locked statement is byte-identical after the refused change.
    const after = rawDb.prepare(
      `SELECT gross_commission_cents AS c, qualification_basis AS basis FROM commission_statements
        WHERE tenant_id = ? AND rep_id = ?`,
    ).get(lockOrg, lRep.memberId) as any;
    expect(after).toEqual(frozen);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE OTHER BACKDATING DOOR.
//
// `upsertSale` clamped every commission-relevant timestamp to the correction
// window. `transitionSale`'s QUALIFY wrote `COALESCE(qualified_at, caller_at)`
// with no clamp at all — so the payload one route refused, the other accepted.
// Both now resolve through shared/commissionEffectiveDate against the sale's
// OWN frozen basis.
// ═══════════════════════════════════════════════════════════════════════════
describe("every write path resolves dates the same way", () => {
  const T_DATE = 7746;
  let dRep: Person;
  const DAY = 86_400_000;
  let recvTs = "";

  const saleRow = (extId: string) => svc.getSaleByExternalId(T_DATE, extId);

  beforeAll(() => {
    rawDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
       VALUES (?, 'dates-org', 'Dates Org', 'Owner T', 'owner@dates.example.test', 'Dates')`,
    ).run(T_DATE);
    dRep = person("Dates Rep", "rep", null, T_DATE);
    svc.assignStructureToRep(T_DATE, 1, { repId: dRep.memberId, structure: "TIERED", effectiveFrom: "2026-01-01" });
    // The REAL clock: transitionSale stamps its own serverReceivedAt from
    // nowIso(), so both paths must be compared against the same receipt time.
    recvTs = new Date().toISOString();
  });

  it("THE EXPLOIT: transitionSale QUALIFY can no longer backdate into an earlier tier week", () => {
    const cfg = svc.loadOrgConfig(T_DATE);
    // A sale booked PENDING in the current week.
    svc.upsertSale(T_DATE, 1, {
      repId: dRep.memberId, externalId: "date-1", status: "PENDING",
      soldAt: recvTs, serverReceivedAt: recvTs,
    });

    // Now QUALIFY it with a timestamp 400 days back — far outside the 30-day
    // correction window. This used to be written verbatim.
    const longAgo = new Date(Date.parse(recvTs) - 400 * DAY).toISOString();
    svc.transitionSale(T_DATE, 1, "date-1", "QUALIFY", { at: longAgo });

    const stored = saleRow("date-1").qualified_at;
    // Clamped to the 30-day window floor, not the requested date. A second of
    // slack absorbs the difference between the test's clock read and the
    // service's own nowIso().
    const floor = Date.parse(recvTs) - 30 * DAY;
    expect(Date.parse(stored)).toBeGreaterThanOrEqual(floor - 5_000);
    expect(Date.parse(stored)).toBeGreaterThan(Date.parse(longAgo));
    // …so the money did not land in a week 400 days ago.
    const claimedWeek = weekBoundsFor(longAgo, cfg).weekStartUtc;
    const landed = rawDb.prepare(
      `SELECT gross_commission_cents AS c FROM commission_statements
        WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T_DATE, dRep.memberId, claimedWeek) as any;
    expect(landed?.c ?? 0).toBe(0);
  });

  it("the clamp is auditable - requested, applied and reason are all recorded", () => {
    const events = rawDb.prepare(
      `SELECT details FROM activity_log WHERE action = 'commission_sale.effective_date_clamped' ORDER BY id DESC LIMIT 1`,
    ).get() as any;
    expect(events).toBeTruthy();
    const d = JSON.parse(events.details);
    expect(d.path).toContain("transitionSale");
    expect(d.payWeekMoved).toBe(true);
    expect(d.clamps[0]).toMatchObject({ reason: "BEFORE_CORRECTION_WINDOW", isBasisField: true });
    expect(d.clamps[0].requested).toBeTruthy();
    expect(d.clamps[0].applied).toBeTruthy();
  });

  it("the SAME payload through upsertSale and transitionSale resolves to the same date and week", () => {
    const cfg = svc.loadOrgConfig(T_DATE);
    const longAgo = new Date(Date.parse(recvTs) - 400 * DAY).toISOString();

    svc.upsertSale(T_DATE, 1, {
      repId: dRep.memberId, externalId: "date-via-upsert", status: "QUALIFIED",
      soldAt: recvTs, qualifiedAt: longAgo, serverReceivedAt: recvTs,
    });
    svc.upsertSale(T_DATE, 1, {
      repId: dRep.memberId, externalId: "date-via-transition", status: "PENDING",
      soldAt: recvTs, serverReceivedAt: recvTs,
    });
    svc.transitionSale(T_DATE, 1, "date-via-transition", "QUALIFY", { at: longAgo });

    const a = saleRow("date-via-upsert").qualified_at;
    const b = saleRow("date-via-transition").qualified_at;
    // Both were clamped to the same window floor. They can differ only by the
    // milliseconds between the two calls' clock reads; what must match exactly
    // is the thing that decides the money — the pay week.
    expect(Math.abs(Date.parse(a) - Date.parse(b))).toBeLessThan(5_000);
    expect(weekBoundsFor(a, cfg).weekStartUtc).toBe(weekBoundsFor(b, cfg).weekStartUtc);
  });

  it("a caller cannot move a date that would alter a LOCKED week", () => {
    const lockTs = "2027-01-06T12:00:00.000Z";
    svc.upsertSale(T_DATE, 1, { repId: dRep.memberId, externalId: "date-lock", status: "QUALIFIED", soldAt: lockTs, qualifiedAt: lockTs });
    svc.calculateOrRecalculateStatement({ tenantId: T_DATE, repId: dRep.memberId, weekReference: lockTs, actorId: 1 });
    svc.batchTransitionWeek(T_DATE, 1, lockTs, "FINALIZE", [dRep.memberId]);
    const cfg = svc.loadOrgConfig(T_DATE);
    const lockedWeek = weekBoundsFor(lockTs, cfg).weekStartUtc;
    const frozen = rawDb.prepare(
      `SELECT gross_commission_cents AS c, qualified_sale_count AS n FROM commission_statements
        WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T_DATE, dRep.memberId, lockedWeek) as any;

    // Booking a NEW qualified sale into that locked week is refused outright…
    let err: any;
    try {
      svc.upsertSale(T_DATE, 1, { repId: dRep.memberId, externalId: "date-lock-2", status: "QUALIFIED", soldAt: lockTs, qualifiedAt: lockTs });
    } catch (e) { err = e; }
    expect(err?.code).toBe("STATEMENT_LOCKED");

    // …and the locked totals are unchanged.
    const after = rawDb.prepare(
      `SELECT gross_commission_cents AS c, qualified_sale_count AS n FROM commission_statements
        WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T_DATE, dRep.memberId, lockedWeek) as any;
    expect(after).toEqual(frozen);
  });

  it("retries and duplicate PATCHes through either path create no duplicate ledger effect", () => {
    const cfg = svc.loadOrgConfig(T_DATE);
    const ts = "2027-02-10T12:00:00.000Z";
    const week = weekBoundsFor(ts, cfg).weekStartUtc;
    for (let i = 0; i < 4; i++) {
      svc.upsertSale(T_DATE, 1, { repId: dRep.memberId, externalId: "date-idem", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
      svc.transitionSale(T_DATE, 1, "date-idem", "QUALIFY", { at: ts });
    }
    const stmt = rawDb.prepare(
      `SELECT qualified_sale_count AS n FROM commission_statements
        WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T_DATE, dRep.memberId, week) as any;
    expect(stmt.n).toBe(1);   // one door, one count, however many retries
    expect(rawDb.prepare(`SELECT COUNT(*) AS c FROM commission_sales WHERE tenant_id = ? AND external_id = ?`)
      .get(T_DATE, "date-idem")).toMatchObject({ c: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE REMAINING THREE. The clamp and the snapshot landed in earlier passes;
// these are the holes that survived them.
//
//   §2 — transitionSale had the clamp but NOT GUARD 3, so QUALIFY into a
//        settled week returned 200: reconcileSaleSideEffects swallows the
//        STATEMENT_LOCKED that follows, leaving the row QUALIFIED inside a
//        locked week until the next recompute re-priced it.
//   §3 — the write-once basis snapshot was resolved from RAW caller input,
//        five lines before the clamp ran, so a backdated payload froze a plan
//        version governing a week the sale could never legally land in.
//   §1 — the NULL-snapshot FALLBACK had two implementations: the statement
//        counted by the plan version while the recompute, the console and the
//        closeout enumeration used the tenant default.
// ═══════════════════════════════════════════════════════════════════════════
describe("the three holes the clamp and the snapshot did not close", () => {
  const T_HOLE = 7747;
  let hRep: Person;
  const DAY = 86_400_000;

  beforeAll(() => {
    rawDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
       VALUES (?, 'holes-org', 'Holes Org', 'Owner H', 'owner@holes.example.test', 'Holes')`,
    ).run(T_HOLE);
    hRep = person("Holes Rep", "rep", null, T_HOLE);
    svc.assignStructureToRep(T_HOLE, 1, { repId: hRep.memberId, structure: "FLAT", flatRateCents: 20000, effectiveFrom: "2026-01-01" });
  });

  it("§2 transitionSale QUALIFY into a FINALIZED week is refused, not silently swallowed", () => {
    const cfg = svc.loadOrgConfig(T_HOLE);
    const ts = "2026-09-09T15:00:00.000Z";
    const week = weekBoundsFor(ts, cfg).weekStartUtc;

    // A real, counted sale settles the week.
    svc.upsertSale(T_HOLE, 1, { repId: hRep.memberId, externalId: "hole-paid", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });
    svc.calculateOrRecalculateStatement({ tenantId: T_HOLE, repId: hRep.memberId, weekReference: ts, actorId: 1 });
    svc.batchTransitionWeek(T_HOLE, 1, ts, "FINALIZE", [hRep.memberId]);

    const frozen = rawDb.prepare(
      `SELECT status, qualified_sale_count AS n, gross_commission_cents AS c FROM commission_statements
        WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T_HOLE, hRep.memberId, week) as any;
    expect(frozen.status).toBe("FINALIZED");

    // A second sale sitting PENDING in that same, now-locked week.
    svc.upsertSale(T_HOLE, 1, { repId: hRep.memberId, externalId: "hole-late", status: "PENDING", soldAt: ts, qualifiedAt: ts });

    // THE DEFECT: this used to return 200 and leave the row QUALIFIED in a
    // FINALIZED week, latent until something recomputed it.
    let err: any;
    try { svc.transitionSale(T_HOLE, 1, "hole-late", "QUALIFY", { at: ts }); }
    catch (e) { err = e; }
    expect(err?.code).toBe("STATEMENT_LOCKED");
    expect(err?.httpStatus).toBe(409);

    // The row never became QUALIFIED, and the locked statement is untouched.
    expect(svc.getSaleByExternalId(T_HOLE, "hole-late").status).toBe("PENDING");
    expect(rawDb.prepare(
      `SELECT status, qualified_sale_count AS n, gross_commission_cents AS c FROM commission_statements
        WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T_HOLE, hRep.memberId, week)).toEqual(frozen);
  });

  it("§2 re-qualifying an already-QUALIFIED sale in a locked week stays idempotent", () => {
    // The guard is scoped to a sale that is not already QUALIFIED: re-running
    // QUALIFY cannot move a week (COALESCE freezes the stamp), so a 409 there
    // would only break an honest retry.
    const before = svc.getSaleByExternalId(T_HOLE, "hole-paid");
    expect(before.status).toBe("QUALIFIED");
    expect(() => svc.transitionSale(T_HOLE, 1, "hole-paid", "QUALIFY", { at: before.qualified_at })).not.toThrow();
    expect(svc.getSaleByExternalId(T_HOLE, "hole-paid").qualified_at).toBe(before.qualified_at);
  });

  it("§3 the basis snapshot is stamped from the CLAMPED date, never the raw one", () => {
    const recv = new Date().toISOString();
    // 400 days back — far outside the 30-day correction window. The snapshot
    // used to be resolved from THIS value, picking whatever plan version
    // governed a week the sale can never land in, and freezing it forever.
    const longAgo = new Date(Date.parse(recv) - 400 * DAY).toISOString();
    svc.upsertSale(T_HOLE, 1, {
      repId: hRep.memberId, externalId: "hole-clamp", status: "PENDING",
      soldAt: recv, qualifiedAt: longAgo, serverReceivedAt: recv,
    });

    const sale = svc.getSaleByExternalId(T_HOLE, "hole-clamp");
    const cfg = svc.loadOrgConfig(T_HOLE);
    // The stored date is clamped…
    expect(Date.parse(sale.qualified_at)).toBeGreaterThan(Date.parse(longAgo));
    // …and the frozen snapshot names the basis of the plan version governing
    // the week the sale ACTUALLY landed in, which is what the statement will
    // count it by.
    const landedWeek = weekBoundsFor(sale.qualified_at, cfg);
    expect(sale.qualification_basis).toBe(
      svc.fallbackBasisForRepWeek(T_HOLE, hRep.memberId, landedWeek, cfg),
    );
  });

  it("§1 a LEGACY null-snapshot sale recomputes into the week that counts it", () => {
    // Every existing sale becomes NULL on the first boot after deploy — the
    // ALTER TABLE adds the column with no backfill — so this is the DEFAULT
    // path for existing data, not an edge case.
    const cfg = svc.loadOrgConfig(T_HOLE);
    const ts = "2026-05-06T15:00:00.000Z";
    const week = weekBoundsFor(ts, cfg).weekStartUtc;
    svc.upsertSale(T_HOLE, 1, { repId: hRep.memberId, externalId: "hole-legacy", status: "QUALIFIED", soldAt: ts, qualifiedAt: ts });

    // Strip the snapshot to manufacture a pre-column row, then force the
    // recompute to resolve the fallback from scratch.
    rawDb.prepare(`UPDATE commission_sales SET qualification_basis = NULL WHERE tenant_id = ? AND external_id = ?`)
      .run(T_HOLE, "hole-legacy");
    expect(svc.getSaleByExternalId(T_HOLE, "hole-legacy").qualification_basis).toBeNull();

    svc.calculateOrRecalculateStatement({ tenantId: T_HOLE, repId: hRep.memberId, weekReference: ts, actorId: 1 });

    // The week the recompute targeted is the week that actually counts it: the
    // statement exists there AND it priced the sale, rather than an empty
    // statement in one week and the money stranded in another.
    const stmt = rawDb.prepare(
      `SELECT qualified_sale_count AS n, gross_commission_cents AS c FROM commission_statements
        WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T_HOLE, hRep.memberId, week) as any;
    expect(stmt.n).toBe(1);
    expect(stmt.c).toBe(20000);

    // And the door list agrees with the statement it belongs to.
    expect(svc.listWeekSalesForRep(T_HOLE, hRep.memberId, ts).map((s: any) => s.external_id))
      .toContain("hole-legacy");
  });

  it("§1 a legacy sale is still enumerated at FINALIZE when the org default disagrees", () => {
    // The closeout enumeration decides WHO gets a statement. A rep missed here
    // is a rep unpaid, so it must resolve each rep's own plan-version basis
    // rather than one org-wide column.
    const cfg = svc.loadOrgConfig(T_HOLE);
    const ts = "2026-05-06T15:00:00.000Z";
    const week = weekBoundsFor(ts, cfg).weekStartUtc;
    const res = svc.batchTransitionWeek(T_HOLE, 1, ts, "FINALIZE", [hRep.memberId]);
    expect(res.results.some((r: any) => r.repId === hRep.memberId && r.outcome === "ok")).toBe(true);
    expect(rawDb.prepare(
      `SELECT status FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
    ).get(T_HOLE, hRep.memberId, week)).toMatchObject({ status: "FINALIZED" });
  });
});
