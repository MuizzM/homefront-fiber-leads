import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeEarnings } from "@shared/earningsLedger";

/**
 * The earnings ledger. The whole design rests on one claim — that mirroring the
 * commission plane cannot change what a rep is paid — so that is what this
 * suite spends most of its time proving:
 *
 *   * the projection RE-SUMS to the statement's own final figure;
 *   * rebuilding is idempotent, so it can be re-run whenever;
 *   * native money (mileage, referral, spiffs) is EXCLUDED from reconciliation,
 *     because the statement never knew about it;
 *   * a PAID row cannot be re-priced or deleted, by trigger.
 */
let L: typeof import("../../server/earningsLedgerStore");
let rawDb: import("better-sqlite3").Database;

const T1 = 1, REP = 10, TEAM_LEAD = 11;
const NOW = "2026-08-06T12:00:00.000Z";
const WEEK_START = "2026-08-03T04:00:00.000Z";
const WEEK_NEXT = "2026-08-10T04:00:00.000Z";
const EFFECTIVE = "2026-08-03";

function statement(over: Record<string, any> = {}): number {
  const info = rawDb.prepare(
    `INSERT INTO commission_statements
       (tenant_id, rep_id, week_start_utc, next_week_start_utc, timezone, local_week_label,
        qualification_basis, plan_version_number, tier_label, rate_cents,
        qualified_sale_count, gross_commission_cents, adjustment_cents, final_commission_cents,
        status, calculated_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    T1, over.repId ?? REP, WEEK_START, WEEK_NEXT, "America/New_York", "Aug 3-9",
    "QUALIFIED_AT", over.planVersion ?? 1, over.tierLabel ?? "Tier 2", over.rateCents ?? 20_000,
    over.saleCount ?? 8, over.gross ?? 160_000, over.adjustment ?? 0,
    over.final ?? over.gross ?? 160_000,
    over.status ?? "FINALIZED", NOW, NOW, NOW,
  );
  return Number(info.lastInsertRowid);
}

function adjustment(statementId: number, amountCents: number, reason = "correction") {
  const info = rawDb.prepare(
    `INSERT INTO commission_adjustments
       (tenant_id, statement_id, rep_id, amount_cents, type, reason, status, created_at)
     VALUES (?,?,?,?,?,?,'APPROVED',?)`,
  ).run(T1, statementId, REP, amountCents, amountCents < 0 ? "CLAWBACK" : "MANUAL", reason, NOW);
  return Number(info.lastInsertRowid);
}

function override(beneficiaryRepId: number, amountCents: number, role = "team_lead") {
  const info = rawDb.prepare(
    `INSERT INTO commission_overrides
       (tenant_id, source_ref, downline_rep_id, beneficiary_rep_id, beneficiary_role, level,
        entry_type, pair_seq, basis, amount_cents, rate_snapshot, chain_snapshot,
        earned_week_start_utc, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    T1, `sale:${Math.floor(Math.random() * 1e9)}`, REP, beneficiaryRepId, role, 1,
    "EARN", 0, "FLAT_PER_SALE", amountCents, "{}", "[]",
    WEEK_START, "PAYABLE", NOW, NOW,
  );
  return Number(info.lastInsertRowid);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-earnings-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  await import("../../server/overrideStore");   // owns commission_overrides
  L = await import("../../server/earningsLedgerStore");
});

beforeEach(() => {
  // Both ledgers defend themselves with append-only triggers, so a reset has to
  // drop them and put them back — which is itself a check that they are
  // installed, since the DELETEs below would otherwise succeed.
  rawDb.exec("DROP TRIGGER IF EXISTS earnings_ledger_no_paid_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS trg_cov_no_delete");
  rawDb.prepare("DELETE FROM earnings_ledger").run();
  rawDb.prepare("DELETE FROM commission_statements").run();
  rawDb.prepare("DELETE FROM commission_adjustments").run();
  rawDb.prepare("DELETE FROM commission_overrides").run();
  L.ensureEarningsLedgerSchema();
  rawDb.exec(`CREATE TRIGGER IF NOT EXISTS trg_cov_no_delete BEFORE DELETE ON commission_overrides
              BEGIN SELECT RAISE(ABORT, 'commission_overrides is append-only'); END`);
});

describe("projection", () => {
  it("mirrors a statement's commission as one ledger row", () => {
    const id = statement();
    const { rows } = L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });

    const commission = rows.find(r => r.earningType === "PERSONAL_COMMISSION")!;
    expect(commission.grossCents).toBe(160_000);
    expect(commission.netCents).toBe(160_000);
    expect(commission.origin).toBe("PROJECTED");
    expect(commission.effectiveDate).toBe(EFFECTIVE);
    // The snapshot is what lets the number be explained years later.
    expect(commission.calculationSnapshot).toMatchObject({ tierLabel: "Tier 2", qualifiedSaleCount: 8 });
  });

  it("itemises approved adjustments rather than collapsing them", () => {
    const id = statement({ gross: 160_000, adjustment: -5_000, final: 155_000 });
    adjustment(id, -5_000, "cancelled install");
    const { rows } = L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });

    // A rep is owed the line, not a net figure they cannot explain.
    const clawback = rows.find(r => r.earningType === "CLAWBACK")!;
    expect(clawback.grossCents).toBe(-5_000);
    expect(clawback.calculationSnapshot).toMatchObject({ reason: "cancelled install" });
  });

  it("names the SLOT an override was earned by", () => {
    const id = statement({ repId: TEAM_LEAD, gross: 0, final: 4_000 });
    override(TEAM_LEAD, 4_000, "team_lead");
    const { rows } = L.projectPeriod({ tenantId: T1, repId: TEAM_LEAD, statementId: id, nowIso: NOW });
    expect(rows.find(r => r.earningType === "TEAM_LEAD_OVERRIDE")?.grossCents).toBe(4_000);

    override(TEAM_LEAD, 2_000, "manager");
    const again = L.projectPeriod({ tenantId: T1, repId: TEAM_LEAD, statementId: id, nowIso: NOW });
    expect(again.rows.find(r => r.earningType === "MANAGER_OVERRIDE")?.grossCents).toBe(2_000);
  });

  it("carries the statement's status onto the rows", () => {
    const open = statement({ status: "OPEN" });
    expect(L.projectPeriod({ tenantId: T1, repId: REP, statementId: open, nowIso: NOW }).rows[0].status).toBe("PENDING");

    rawDb.prepare("DELETE FROM commission_statements").run();
    rawDb.prepare("DELETE FROM earnings_ledger").run();
    const paid = statement({ status: "PAID" });
    expect(L.projectPeriod({ tenantId: T1, repId: REP, statementId: paid, nowIso: NOW }).rows[0].status).toBe("PAID");
  });

  it("is idempotent - rebuilding changes nothing", () => {
    const id = statement();
    adjustment(id, -5_000);
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });

    const rows = L.listEarnings(T1, { repIds: [REP] });
    expect(rows).toHaveLength(2);   // one commission, one clawback
  });

  it("picks up a recalculation on the next rebuild", () => {
    const id = statement({ gross: 160_000, final: 160_000 });
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });

    // A tier change re-priced the whole week.
    rawDb.prepare(`UPDATE commission_statements SET gross_commission_cents = 200000, final_commission_cents = 200000 WHERE id = ?`).run(id);
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });

    expect(L.getByKey(T1, "commission_statement", id, "PERSONAL_COMMISSION")!.grossCents).toBe(200_000);
  });
});

describe("reconciliation - the proof the mirror is faithful", () => {
  it("re-sums exactly to the statement's own final figure", () => {
    const id = statement({ gross: 160_000, adjustment: -5_000, final: 155_000 });
    adjustment(id, -5_000);
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });

    const result = L.reconcilePeriod({ tenantId: T1, repId: REP, statementId: id });
    expect(result.ok).toBe(true);
    expect(result.driftCents).toBe(0);
    expect(result.ledgerCents).toBe(155_000);
    expect(result.statementCents).toBe(155_000);
  });

  it("EXCLUDES native money - the statement never knew about it", () => {
    const id = statement({ gross: 160_000, final: 160_000 });
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });

    // Mileage and a referral bonus are earnings this ledger owns. Counting them
    // against the statement would report a drift on every correct week.
    L.recordMileage({
      tenantId: T1, repId: REP, tripId: 1, reimbursementCents: 808,
      milesHundredths: 1234, tripDate: EFFECTIVE, rateMilliCentsPerMile: 65_500, nowIso: NOW,
    });
    L.recordReferralReward({
      tenantId: T1, referrerRepId: REP, referralId: 1, rewardCents: 50_000,
      effectiveDate: EFFECTIVE, referredRepId: 12, qualifyingSales: 6, nowIso: NOW,
    });

    const result = L.reconcilePeriod({ tenantId: T1, repId: REP, statementId: id });
    expect(result.ok).toBe(true);
    expect(result.ledgerCents).toBe(160_000);
  });

  it("REPORTS a drift rather than hiding it", () => {
    const id = statement({ gross: 160_000, final: 160_000 });
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });
    // Simulate a projection bug: the mirror says something the statement does not.
    rawDb.prepare(`UPDATE earnings_ledger SET net_cents = 999 WHERE earning_type = 'PERSONAL_COMMISSION'`).run();

    const result = L.reconcilePeriod({ tenantId: T1, repId: REP, statementId: id });
    expect(result.ok).toBe(false);
    // The drift points at the mirror, never at the statement.
    expect(result.driftCents).toBe(999 - 160_000);
    expect(result.byType.PERSONAL_COMMISSION).toBe(999);
  });
});

describe("native money", () => {
  it("records approved mileage with its own snapshot", () => {
    const row = L.recordMileage({
      tenantId: T1, repId: REP, tripId: 7, reimbursementCents: 808,
      milesHundredths: 1234, tripDate: EFFECTIVE, rateMilliCentsPerMile: 65_500, nowIso: NOW,
    })!;
    expect(row.earningType).toBe("MILEAGE_REIMBURSEMENT");
    expect(row.origin).toBe("NATIVE");
    expect(row.status).toBe("APPROVED");
    expect(row.calculationSnapshot).toMatchObject({ milesHundredths: 1234, rateMilliCentsPerMile: 65_500 });
  });

  it("writes NO row for a zero-value trip", () => {
    // A $0.00 line on a statement reads as a mistake, not as a fact.
    expect(L.recordMileage({
      tenantId: T1, repId: REP, tripId: 8, reimbursementCents: 0,
      milesHundredths: 1234, tripDate: EFFECTIVE, rateMilliCentsPerMile: null, nowIso: NOW,
    })).toBeNull();
  });

  it("classifies an incentive by its campaign type", () => {
    expect(L.recordIncentive({
      tenantId: T1, repId: REP, spiffId: 1, amountCents: 5_000,
      incentiveType: "TRAINING_COMPLETION", effectiveDate: EFFECTIVE, campaignId: 1, nowIso: NOW,
    }).earningType).toBe("TRAINING_BONUS");

    expect(L.recordIncentive({
      tenantId: T1, repId: REP, spiffId: 2, amountCents: 7_500,
      incentiveType: "PRODUCT_SPIFF", effectiveDate: EFFECTIVE, campaignId: 1, nowIso: NOW,
    }).earningType).toBe("SPIFF");

    // A negative engine award is a clawback whatever campaign produced it.
    expect(L.recordIncentive({
      tenantId: T1, repId: REP, spiffId: 3, amountCents: -7_500,
      incentiveType: "PRODUCT_SPIFF", effectiveDate: EFFECTIVE, campaignId: 1, nowIso: NOW,
    }).earningType).toBe("CLAWBACK");
  });

  it("refuses to record projected money through the native path", () => {
    expect(() => L.recordNative({
      tenantId: T1, recipientRepId: REP, sourceType: "commission_statement", sourceId: 1,
      earningType: "PERSONAL_COMMISSION", grossCents: 100, effectiveDate: EFFECTIVE, nowIso: NOW,
    })).toThrow(/EARNINGS_NOT_NATIVE/);
  });

  it("is idempotent per source", () => {
    for (let i = 0; i < 3; i += 1) {
      L.recordMileage({
        tenantId: T1, repId: REP, tripId: 7, reimbursementCents: 808,
        milesHundredths: 1234, tripDate: EFFECTIVE, rateMilliCentsPerMile: 65_500, nowIso: NOW,
      });
    }
    expect(L.listEarnings(T1, { repIds: [REP], earningType: "MILEAGE_REIMBURSEMENT" })).toHaveLength(1);
  });
});

describe("paid rows are frozen", () => {
  it("the database refuses to re-price or delete a PAID row", () => {
    const row = L.recordMileage({
      tenantId: T1, repId: REP, tripId: 9, reimbursementCents: 808,
      milesHundredths: 1234, tripDate: EFFECTIVE, rateMilliCentsPerMile: 65_500, nowIso: NOW,
    })!;
    L.markPaid(T1, [row.id], NOW);

    expect(() => rawDb.prepare(`UPDATE earnings_ledger SET net_cents = 1 WHERE id = ?`).run(row.id))
      .toThrow(/cannot be re-priced/);
    expect(() => rawDb.prepare(`DELETE FROM earnings_ledger WHERE id = ?`).run(row.id))
      .toThrow(/cannot be deleted/);
  });

  it("a rebuild leaves a PAID row alone", () => {
    const id = statement({ status: "PAID" });
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });
    rawDb.prepare(`UPDATE commission_statements SET gross_commission_cents = 999 WHERE id = ?`).run(id);
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });

    // Money that already moved is not re-priced by a later rebuild.
    expect(L.getByKey(T1, "commission_statement", id, "PERSONAL_COMMISSION")!.grossCents).toBe(160_000);
  });

  it("refuses to reverse a paid row through the API", () => {
    const row = L.recordMileage({
      tenantId: T1, repId: REP, tripId: 11, reimbursementCents: 500,
      milesHundredths: 800, tripDate: EFFECTIVE, rateMilliCentsPerMile: 65_500, nowIso: NOW,
    })!;
    L.markPaid(T1, [row.id], NOW);
    expect(() => L.markReversed(T1, row.id, NOW)).toThrow("EARNINGS_ROW_PAID");
  });
});

describe("summaries and isolation", () => {
  it("keeps pending out of the earned total", () => {
    const id = statement({ status: "OPEN" });
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });
    L.recordMileage({
      tenantId: T1, repId: REP, tripId: 20, reimbursementCents: 808,
      milesHundredths: 1234, tripDate: EFFECTIVE, rateMilliCentsPerMile: 65_500, nowIso: NOW,
    });

    const summary = summarizeEarnings(L.listEarnings(T1, { repIds: [REP] }));
    expect(summary.pendingCents).toBe(160_000);   // the open week is a claim
    expect(summary.approvedCents).toBe(808);      // the trip is a debt
    expect(summary.earnedCents).toBe(808);
  });

  it("never leaks another org's earnings", () => {
    const id = statement();
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });
    expect(L.listEarnings(2, { repIds: [REP] })).toEqual([]);
  });

  it("an EMPTY rep scope returns nothing, not everything", () => {
    const id = statement();
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });
    expect(L.listEarnings(T1, { repIds: [] })).toEqual([]);
  });

  it("reports org liability by earning type", () => {
    const id = statement();
    L.projectPeriod({ tenantId: T1, repId: REP, statementId: id, nowIso: NOW });
    L.recordReferralReward({
      tenantId: T1, referrerRepId: REP, referralId: 3, rewardCents: 50_000,
      effectiveDate: EFFECTIVE, referredRepId: 12, qualifyingSales: 6, nowIso: NOW,
    });
    const liability = L.orgLiability(T1);
    expect(liability.PERSONAL_COMMISSION).toBe(160_000);
    expect(liability.REFERRAL_BONUS).toBe(50_000);
  });
});
