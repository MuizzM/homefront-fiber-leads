// ── Earnings ledger store — the durable side of shared/earningsLedger.ts ────
//
// Two write paths, deliberately different:
//
//   recordNative()   money this ledger OWNS (mileage, referral, engine spiffs).
//                    Written once, at the moment it is earned.
//
//   projectPeriod()  money that already has a source of truth. REBUILT from
//                    that source on demand, never authored here.
//
// The rebuild is what makes the projection safe: it is idempotent, it deletes
// nothing that is PAID, and it can be re-run over any period at any time to
// prove the mirror still matches. `reconcilePeriod` is that proof.
//
// ── WHY REBUILD RATHER THAN WRITE-THROUGH ───────────────────────────────────
// A write-through projection has to be hooked into every place the source
// tables change — statement recalculation, adjustment approval, override
// reversal, hourly correction — and the day one of those paths is added without
// its hook, the ledger silently drifts. A rebuild reads the source as it stands
// and cannot drift, because there is nothing to forget to call.

import { rawDb } from "./db";
import {
  originOf, isNativeSource, ledgerKey, netOf, reconcile, isLedgerLocked,
  type EarningType, type EarningsLedgerRow, type LedgerStatus, type SourceType,
  type ReconciliationResult,
} from "@shared/earningsLedger";

export function ensureEarningsLedgerSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS earnings_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      recipient_user_id INTEGER,
      recipient_rep_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      earning_type TEXT NOT NULL,
      origin TEXT NOT NULL,
      gross_cents INTEGER NOT NULL DEFAULT 0,
      adjustment_cents INTEGER NOT NULL DEFAULT 0,
      net_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      effective_date TEXT NOT NULL,             -- YYYY-MM-DD, org-local
      compensation_plan_version INTEGER,
      calculation_snapshot TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- The spec's "unique idempotency keys", enforced by the database rather
    -- than by every writer remembering.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_idem
      ON earnings_ledger(tenant_id, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_earnings_rep_period
      ON earnings_ledger(tenant_id, recipient_rep_id, effective_date, status);
    CREATE INDEX IF NOT EXISTS idx_earnings_type
      ON earnings_ledger(tenant_id, earning_type, effective_date);
    CREATE INDEX IF NOT EXISTS idx_earnings_source
      ON earnings_ledger(tenant_id, source_type, source_id);
  `);

  // A PAID row is money that left the building. The application has no update
  // path for one; this makes that a property of the database.
  rawDb.exec(`
    CREATE TRIGGER IF NOT EXISTS earnings_ledger_no_paid_update
      BEFORE UPDATE ON earnings_ledger
      WHEN OLD.status = 'PAID' AND NEW.status = 'PAID'
        AND (NEW.gross_cents IS NOT OLD.gross_cents
          OR NEW.adjustment_cents IS NOT OLD.adjustment_cents
          OR NEW.net_cents IS NOT OLD.net_cents)
      BEGIN SELECT RAISE(ABORT, 'a PAID earnings_ledger row cannot be re-priced'); END;
    CREATE TRIGGER IF NOT EXISTS earnings_ledger_no_paid_delete
      BEFORE DELETE ON earnings_ledger
      WHEN OLD.status = 'PAID'
      BEGIN SELECT RAISE(ABORT, 'a PAID earnings_ledger row cannot be deleted'); END;
  `);
}
ensureEarningsLedgerSchema();

function mapRow(r: any): EarningsLedgerRow | null {
  if (!r) return null;
  let snapshot: Record<string, unknown> | null = null;
  if (r.calculation_snapshot) {
    try { snapshot = JSON.parse(r.calculation_snapshot); } catch { snapshot = null; }
  }
  return {
    id: r.id, tenantId: r.tenant_id,
    recipientUserId: r.recipient_user_id ?? null,
    recipientRepId: r.recipient_rep_id,
    sourceType: r.source_type, sourceId: r.source_id,
    earningType: r.earning_type, origin: r.origin,
    grossCents: r.gross_cents, adjustmentCents: r.adjustment_cents, netCents: r.net_cents,
    status: r.status, effectiveDate: r.effective_date,
    compensationPlanVersion: r.compensation_plan_version ?? null,
    calculationSnapshot: snapshot,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
}

export interface RecordInput {
  tenantId: number;
  recipientRepId: number;
  recipientUserId?: number | null;
  sourceType: SourceType;
  sourceId: number;
  earningType: EarningType;
  grossCents: number;
  adjustmentCents?: number;
  status?: LedgerStatus;
  effectiveDate: string;
  compensationPlanVersion?: number | null;
  calculationSnapshot?: Record<string, unknown> | null;
  nowIso: string;
}

/**
 * Write (or update) one ledger row.
 *
 * Idempotent on `(tenant, key)`: re-running the same projection updates the row
 * in place rather than duplicating it, which is what lets `projectPeriod` be
 * called as often as anyone likes. A PAID row is never re-priced — the trigger
 * refuses, and the upsert deliberately excludes it so a rebuild does not have
 * to know which rows are locked.
 */
export function upsert(input: RecordInput): EarningsLedgerRow {
  const key = ledgerKey(input.sourceType, input.sourceId, input.earningType);
  const gross = Math.trunc(input.grossCents || 0);
  const adjustment = Math.trunc(input.adjustmentCents || 0);
  const net = netOf(gross, adjustment);
  const origin = originOf(input.sourceType);

  rawDb.prepare(
    `INSERT INTO earnings_ledger
       (tenant_id, recipient_user_id, recipient_rep_id, source_type, source_id, earning_type,
        origin, gross_cents, adjustment_cents, net_cents, status, effective_date,
        compensation_plan_version, calculation_snapshot, idempotency_key, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, idempotency_key) DO UPDATE SET
       gross_cents = excluded.gross_cents,
       adjustment_cents = excluded.adjustment_cents,
       net_cents = excluded.net_cents,
       status = excluded.status,
       effective_date = excluded.effective_date,
       calculation_snapshot = excluded.calculation_snapshot,
       updated_at = excluded.updated_at
     WHERE earnings_ledger.status != 'PAID'`,
  ).run(
    input.tenantId, input.recipientUserId ?? null, input.recipientRepId,
    input.sourceType, input.sourceId, input.earningType, origin,
    gross, adjustment, net, input.status ?? "PENDING", input.effectiveDate,
    input.compensationPlanVersion ?? null,
    input.calculationSnapshot ? JSON.stringify(input.calculationSnapshot) : null,
    key, input.nowIso, input.nowIso,
  );

  return mapRow(rawDb.prepare(
    `SELECT * FROM earnings_ledger WHERE tenant_id = ? AND idempotency_key = ?`,
  ).get(input.tenantId, key))!;
}

/** Money this ledger owns. Identical mechanics to `upsert`, named separately so
 *  a call site reads as a claim about authority rather than a database verb. */
export function recordNative(input: RecordInput): EarningsLedgerRow {
  if (!isNativeSource(input.sourceType)) {
    throw new Error(`EARNINGS_NOT_NATIVE:${input.sourceType}`);
  }
  return upsert(input);
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface LedgerQuery {
  repIds?: number[] | null;
  earningType?: EarningType | null;
  status?: LedgerStatus | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
}

export function listEarnings(tenantId: number, q: LedgerQuery = {}): EarningsLedgerRow[] {
  const where = ["tenant_id = ?"];
  const params: any[] = [tenantId];
  if (q.repIds) {
    // Empty scope means nobody, never everybody.
    if (q.repIds.length === 0) return [];
    where.push(`recipient_rep_id IN (${q.repIds.map(() => "?").join(",")})`);
    params.push(...q.repIds);
  }
  if (q.earningType) { where.push("earning_type = ?"); params.push(q.earningType); }
  if (q.status) { where.push("status = ?"); params.push(q.status); }
  if (q.from) { where.push("effective_date >= ?"); params.push(q.from); }
  if (q.to) { where.push("effective_date <= ?"); params.push(q.to); }

  const rows = rawDb.prepare(
    `SELECT * FROM earnings_ledger WHERE ${where.join(" AND ")}
      ORDER BY effective_date DESC, id DESC LIMIT ?`,
  ).all(...params, Math.max(1, Math.min(5000, q.limit ?? 500)));
  return rows.map(mapRow).filter((r): r is EarningsLedgerRow => r != null);
}

export function getByKey(tenantId: number, sourceType: SourceType, sourceId: number, earningType: EarningType) {
  return mapRow(rawDb.prepare(
    `SELECT * FROM earnings_ledger WHERE tenant_id = ? AND idempotency_key = ?`,
  ).get(tenantId, ledgerKey(sourceType, sourceId, earningType)));
}

// ── Projection ──────────────────────────────────────────────────────────────

/** The org-local date of an ISO instant, for period bucketing. */
function dateOf(iso: string | null | undefined): string {
  if (!iso) return "";
  return String(iso).slice(0, 10);
}

/**
 * Rebuild the PROJECTED rows for one rep and one commission week.
 *
 * Reads the statement and the same source tables the statement itself read, and
 * mirrors them. Every row is keyed on its source, so running this twice changes
 * nothing and running it after a recalculation brings the mirror back into line.
 *
 * The statement's own totals are used for the commission and hourly lines
 * rather than re-derived from sales, because re-deriving is precisely how a
 * mirror stops being a mirror: a retroactive tier re-prices a whole week, and
 * only the statement knows the tier that applied.
 */
export function projectPeriod(p: {
  tenantId: number; repId: number; statementId: number; nowIso: string;
}): { rows: EarningsLedgerRow[]; statementEarnedCents: number } {
  const statement = rawDb.prepare(
    `SELECT * FROM commission_statements WHERE tenant_id = ? AND id = ? AND rep_id = ?`,
  ).get(p.tenantId, p.statementId, p.repId) as any;
  if (!statement) throw new Error("EARNINGS_STATEMENT_NOT_FOUND");

  const effectiveDate = dateOf(statement.week_start_utc);
  const weekStart = statement.week_start_utc as string;
  // A finalized or paid week is settled money; a still-open week is a claim.
  const status: LedgerStatus =
    statement.status === "PAID" ? "PAID"
      : statement.status === "FINALIZED" ? "APPROVED"
        : "PENDING";

  const common = {
    tenantId: p.tenantId, recipientRepId: p.repId,
    effectiveDate, status, nowIso: p.nowIso,
    compensationPlanVersion: statement.plan_version_number ?? null,
  };
  const rows: EarningsLedgerRow[] = [];

  // 1. Personal commission — the statement's gross, which already carries the
  //    retroactive tier decision.
  rows.push(upsert({
    ...common,
    sourceType: "commission_statement", sourceId: statement.id,
    earningType: "PERSONAL_COMMISSION",
    grossCents: statement.gross_commission_cents ?? 0,
    calculationSnapshot: {
      tierLabel: statement.tier_label,
      rateCents: statement.rate_cents,
      qualifiedSaleCount: statement.qualified_sale_count,
      weekStartUtc: weekStart,
    },
  }));

  // 2. Approved adjustments, one row each — a rep is owed the itemisation, not
  //    a single net figure they cannot explain.
  const adjustments = rawDb.prepare(
    `SELECT id, amount_cents, reason, type FROM commission_adjustments
      WHERE tenant_id = ? AND statement_id = ? AND status = 'APPROVED'`,
  ).all(p.tenantId, p.statementId) as any[];
  for (const a of adjustments) {
    rows.push(upsert({
      ...common,
      sourceType: "commission_adjustment", sourceId: a.id,
      // A negative adjustment IS a clawback in everything but name, and
      // reporting that separates them is what the spec's CLAWBACK type is for.
      earningType: a.amount_cents < 0 ? "CLAWBACK" : "ADJUSTMENT",
      grossCents: a.amount_cents,
      calculationSnapshot: { reason: a.reason, adjustmentType: a.type },
    }));
  }

  // 3. Downline overrides settled onto this statement. The ledger row names the
  //    SLOT that earned it, which is what the spec's two override types mean.
  const overrides = rawDb.prepare(
    `SELECT id, amount_cents, beneficiary_role, level, entry_type
       FROM commission_overrides
      WHERE tenant_id = ? AND beneficiary_rep_id = ? AND earned_week_start_utc = ?`,
  ).all(p.tenantId, p.repId, weekStart) as any[];
  for (const o of overrides) {
    rows.push(upsert({
      ...common,
      sourceType: "commission_override", sourceId: o.id,
      earningType: o.beneficiary_role === "manager" ? "MANAGER_OVERRIDE" : "TEAM_LEAD_OVERRIDE",
      grossCents: o.amount_cents,
      calculationSnapshot: { level: o.level, entryType: o.entry_type, role: o.beneficiary_role },
    }));
  }

  return { rows, statementEarnedCents: statement.final_commission_cents ?? 0 };
}

/**
 * Prove the projection is faithful for one rep-week.
 *
 * Compares only projected rows against the statement's own final figure. A
 * non-zero drift is a bug in `projectPeriod`; it is never a reason to touch the
 * statement, which is the authority for this money.
 */
export function reconcilePeriod(p: {
  tenantId: number; repId: number; statementId: number;
}): ReconciliationResult {
  const statement = rawDb.prepare(
    `SELECT final_commission_cents, week_start_utc FROM commission_statements
      WHERE tenant_id = ? AND id = ? AND rep_id = ?`,
  ).get(p.tenantId, p.statementId, p.repId) as any;
  if (!statement) throw new Error("EARNINGS_STATEMENT_NOT_FOUND");

  const effectiveDate = dateOf(statement.week_start_utc);
  const rows = rawDb.prepare(
    `SELECT earning_type AS earningType, net_cents AS netCents, origin
       FROM earnings_ledger
      WHERE tenant_id = ? AND recipient_rep_id = ? AND effective_date = ?`,
  ).all(p.tenantId, p.repId, effectiveDate) as any[];

  return reconcile(rows, statement.final_commission_cents ?? 0);
}

// ── Native recorders ────────────────────────────────────────────────────────

/** Approved mileage becomes a ledger row the moment it is approved. */
export function recordMileage(p: {
  tenantId: number; repId: number; tripId: number;
  reimbursementCents: number; milesHundredths: number; tripDate: string;
  rateMilliCentsPerMile: number | null; nowIso: string;
}): EarningsLedgerRow | null {
  // Zero-value trips (an org with reimbursement off, or no rate) produce no
  // ledger row at all: a $0.00 earning line on a statement reads as a mistake.
  if (p.reimbursementCents === 0) return null;
  return recordNative({
    tenantId: p.tenantId, recipientRepId: p.repId,
    sourceType: "mileage_trip", sourceId: p.tripId,
    earningType: "MILEAGE_REIMBURSEMENT",
    grossCents: p.reimbursementCents,
    status: "APPROVED",
    effectiveDate: p.tripDate,
    calculationSnapshot: {
      milesHundredths: p.milesHundredths,
      rateMilliCentsPerMile: p.rateMilliCentsPerMile,
    },
    nowIso: p.nowIso,
  });
}

/** An approved referral reward. */
export function recordReferralReward(p: {
  tenantId: number; referrerRepId: number; referralId: number;
  rewardCents: number; effectiveDate: string;
  referredRepId: number | null; qualifyingSales: number; nowIso: string;
}): EarningsLedgerRow {
  return recordNative({
    tenantId: p.tenantId, recipientRepId: p.referrerRepId,
    sourceType: "referral", sourceId: p.referralId,
    earningType: "REFERRAL_BONUS",
    grossCents: p.rewardCents,
    status: "APPROVED",
    effectiveDate: p.effectiveDate,
    calculationSnapshot: { referredRepId: p.referredRepId, qualifyingSales: p.qualifyingSales },
    nowIso: p.nowIso,
  });
}

/** An engine spiff or training bonus, from the incentive ledger. */
export function recordIncentive(p: {
  tenantId: number; repId: number; spiffId: number;
  amountCents: number; incentiveType: string | null;
  effectiveDate: string; campaignId: number | null; nowIso: string;
}): EarningsLedgerRow {
  const earningType: EarningType =
    p.incentiveType === "TRAINING_COMPLETION" || p.incentiveType === "TRAINING_ASSESSMENT"
      ? "TRAINING_BONUS"
      : p.incentiveType === "REFERRAL_REWARD"
        ? "REFERRAL_BONUS"
        : p.incentiveType === "MILEAGE_REIMBURSEMENT"
          ? "MILEAGE_REIMBURSEMENT"
          : p.amountCents < 0 ? "CLAWBACK" : "SPIFF";

  return recordNative({
    tenantId: p.tenantId, recipientRepId: p.repId,
    sourceType: "spiff", sourceId: p.spiffId,
    earningType,
    grossCents: p.amountCents,
    status: "APPROVED",
    effectiveDate: p.effectiveDate,
    calculationSnapshot: { campaignId: p.campaignId, incentiveType: p.incentiveType },
    nowIso: p.nowIso,
  });
}

// ── Status transitions ──────────────────────────────────────────────────────

/** Mark rows paid once a payout settles. A PAID row is then frozen by trigger. */
export function markPaid(tenantId: number, ids: number[], nowIso: string): number {
  if (ids.length === 0) return 0;
  const info = rawDb.prepare(
    `UPDATE earnings_ledger SET status = 'PAID', updated_at = ?
      WHERE tenant_id = ? AND status IN ('PENDING','APPROVED') AND id IN (${ids.map(() => "?").join(",")})`,
  ).run(nowIso, tenantId, ...ids);
  return info.changes;
}

/** Reverse a row. Never an edit: the original stays and this flips its status,
 *  with the offsetting money recorded as its own CLAWBACK row by the caller. */
export function markReversed(tenantId: number, id: number, nowIso: string): void {
  const row = mapRow(rawDb.prepare(`SELECT * FROM earnings_ledger WHERE tenant_id = ? AND id = ?`).get(tenantId, id));
  if (!row) throw new Error("EARNINGS_ROW_NOT_FOUND");
  if (isLedgerLocked(row.status)) throw new Error("EARNINGS_ROW_PAID");
  rawDb.prepare(`UPDATE earnings_ledger SET status = 'REVERSED', updated_at = ? WHERE tenant_id = ? AND id = ?`)
    .run(nowIso, tenantId, id);
}

// ── Org aggregates ──────────────────────────────────────────────────────────

/** Total outstanding liability by earning type — the admin dashboard figure. */
export function orgLiability(tenantId: number): Record<string, number> {
  const rows = rawDb.prepare(
    `SELECT earning_type AS t, COALESCE(SUM(net_cents), 0) AS c
       FROM earnings_ledger
      WHERE tenant_id = ? AND status IN ('PENDING','APPROVED')
      GROUP BY earning_type`,
  ).all(tenantId) as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.t] = r.c;
  return out;
}
