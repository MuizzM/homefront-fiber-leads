// ── Downline override ledger (upline pay on downline sales) ───────────────────
// An APPEND-ONLY per-sale money ledger, modeled on spiffs + reserve_entries:
// when a downline rep's sale QUALIFIES, each configured upline slot (first
// active team_lead, first active manager in the reports-to chain) earns a
// frozen flat amount. Rows freeze BOTH the chain and the rate config as JSON at
// earn time — the tree and the config are mutable, an earned row is not: an
// override earned under manager A never re-attributes to manager B.
//
// Money reaches the upline through ONE rail: overrideBlockForWeek() is summed
// into the upline's commission_statements.final_commission_cents by
// calculateOrRecalculateStatement (exactly how hourly pay folds in), which puts
// overrides on the statement → NACHA → 1099 → reserve rails with no second
// payment instruction anywhere. Import direction matches hourlyPay.ts:
// commissionService imports THIS file; this file NEVER imports commissionService
// (week bounds are passed in by the caller for the same reason).
//
// Row lifecycle per (source_ref, beneficiary) PAIR — rows strictly alternate
// EARN (even pair_seq) / CLAWBACK (odd), so replays and re-qualifies converge:
//
//   PAYABLE   folds into the upline's OPEN statement for earned_week
//   HELD      sale is inside the install hold — released into the week that
//             contains payable_after (the rep-side release rule, mirrored)
//   SETTLED   frozen into a FINALIZED statement (un-settled again on REOPEN)
//   EXCEPTION needs a human: a reversal against a settled week, or an earn
//             whose upline week was already locked. Never summed.
//   RESOLVED  exception closed by a manager adjustment (or mooted by reversal)
//
// syncOverridesForSale is a STATE RECONCILER, not an event handler: "sale
// QUALIFIED and pair closed → open it; sale not QUALIFIED and pair open →
// close it; otherwise no-op." Knock replays, repeated recomputes, and double
// transitions all converge; the unique pair_seq index is the DB backstop.
import { rawDb } from "./db";
import { storage } from "./storage";
import { getTenantPayPolicy } from "./payPolicyStore";
import {
  computeFlatOverrides,
  resolveOverrideChain,
  resolveSellerRates,
  type OverrideLedgerStatus,
  type OverrideRates,
  type OverrideRowWire,
  type UplineChainMemberInput,
} from "@shared/commissionOverrides";

// ── Schema (idempotent; additive) ─────────────────────────────────────────────
// Created on import so the ledger exists wherever the store is used (server +
// integration tests) without touching the central migration list.
export function ensureOverrideSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS commission_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      source_ref TEXT NOT NULL,            -- 'sale:<commission_sales.id>'
      sale_id INTEGER,
      downline_rep_id INTEGER NOT NULL,    -- who sold (team_members.id)
      beneficiary_rep_id INTEGER NOT NULL, -- who earns (team_members.id)
      beneficiary_role TEXT NOT NULL,      -- slot role AT EARN TIME (frozen)
      level INTEGER NOT NULL,              -- hops above the seller; 1 = direct
      entry_type TEXT NOT NULL,            -- 'EARN' | 'CLAWBACK'
      pair_seq INTEGER NOT NULL,           -- EARN even, CLAWBACK odd, per pair
      basis TEXT NOT NULL,                 -- 'FLAT_PER_SALE'
      amount_cents INTEGER NOT NULL,       -- signed: +earn / -claw
      rate_snapshot TEXT NOT NULL,         -- frozen OverrideRates JSON
      chain_snapshot TEXT NOT NULL,        -- frozen ChainSnapshotNode[] JSON
      earned_week_start_utc TEXT NOT NULL, -- the upline pay week
      status TEXT NOT NULL DEFAULT 'PAYABLE',
      hold_payable_after TEXT,
      settled_statement_id INTEGER,
      resolved_adjustment_id INTEGER,
      reason TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL,            -- ISO .000Z always, writer-supplied
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cov_pair_seq
      ON commission_overrides(tenant_id, source_ref, beneficiary_rep_id, pair_seq);
    CREATE INDEX IF NOT EXISTS idx_cov_beneficiary_week
      ON commission_overrides(tenant_id, beneficiary_rep_id, earned_week_start_utc, status);
    CREATE INDEX IF NOT EXISTS idx_cov_sale ON commission_overrides(tenant_id, sale_id);
    CREATE INDEX IF NOT EXISTS idx_cov_status ON commission_overrides(tenant_id, status);

    -- Append-only: the ledger explains locked weeks forever, so a physical
    -- delete is never legal, and every money/attribution column is frozen.
    -- Lifecycle columns (status, settle/resolve stamps) stay mutable; the
    -- earned week may move ONLY while HELD (install-hold release re-homes the
    -- row into the release week, mirroring the rep-side rule).
    CREATE TRIGGER IF NOT EXISTS trg_cov_no_delete BEFORE DELETE ON commission_overrides
    BEGIN SELECT RAISE(ABORT, 'commission_overrides is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_cov_frozen BEFORE UPDATE ON commission_overrides
    WHEN NEW.tenant_id != OLD.tenant_id OR NEW.source_ref != OLD.source_ref
      OR NEW.sale_id IS NOT OLD.sale_id OR NEW.downline_rep_id != OLD.downline_rep_id
      OR NEW.beneficiary_rep_id != OLD.beneficiary_rep_id OR NEW.beneficiary_role != OLD.beneficiary_role
      OR NEW.level != OLD.level OR NEW.entry_type != OLD.entry_type OR NEW.pair_seq != OLD.pair_seq
      OR NEW.basis != OLD.basis OR NEW.amount_cents != OLD.amount_cents
      OR NEW.rate_snapshot != OLD.rate_snapshot OR NEW.chain_snapshot != OLD.chain_snapshot
      OR (NEW.earned_week_start_utc != OLD.earned_week_start_utc AND OLD.status != 'HELD')
    BEGIN SELECT RAISE(ABORT, 'commission_overrides money/attribution columns are frozen'); END;
  `);
}
ensureOverrideSchema();

export class OverrideError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) { super(message); }
}

const nowIso = () => new Date().toISOString();

// ── Config ────────────────────────────────────────────────────────────────────
// Reads the tenant columns directly (added in storage.ts runMigrations) so this
// module needs nothing from commissionService. Disabled or zero-rate configs
// produce zero earns; clawbacks NEVER consult the flag — money already earned
// must still reverse correctly after the feature is switched off.
export function loadOverrideRates(tenantId: number): { enabled: boolean; rates: OverrideRates } {
  const row = rawDb.prepare(
    `SELECT commission_override_enabled AS enabled,
            commission_override_basis AS basis,
            commission_override_team_lead_cents AS teamLeadCents,
            commission_override_manager_cents AS managerCents
     FROM tenants WHERE id = ?`
  ).get(tenantId) as any;
  return {
    enabled: !!row?.enabled,
    rates: {
      basis: row?.basis === "PERCENT_OF_COMMISSION" ? "PERCENT_OF_COMMISSION" : "FLAT_PER_SALE",
      teamLeadCents: Math.max(0, Math.trunc(Number(row?.teamLeadCents ?? 0))),
      managerCents: Math.max(0, Math.trunc(Number(row?.managerCents ?? 0))),
    },
  };
}

// ── Reconciler ────────────────────────────────────────────────────────────────

interface LedgerRow {
  id: number; source_ref: string; sale_id: number | null;
  downline_rep_id: number; beneficiary_rep_id: number; beneficiary_role: string;
  level: number; entry_type: "EARN" | "CLAWBACK"; pair_seq: number;
  basis: string; amount_cents: number; earned_week_start_utc: string;
  status: OverrideLedgerStatus; hold_payable_after: string | null;
  settled_statement_id: number | null;
}

function rowsForSource(tenantId: number, sourceRef: string): LedgerRow[] {
  return rawDb.prepare(
    `SELECT * FROM commission_overrides WHERE tenant_id = ? AND source_ref = ? ORDER BY beneficiary_rep_id, pair_seq`
  ).all(tenantId, sourceRef) as LedgerRow[];
}

/** The sale's install-hold verdict, mirroring countQualifiedSales' overlay: a
 *  knock-linked sale whose latest legacy commission row is still 'pending' and
 *  not yet past payable_after is HELD money. API-booked sales (no lead) are
 *  never hold-gated — same rule as rep pay. */
function installHoldFor(tenantId: number, sale: any, now: string): { held: boolean; payableAfter: string | null } {
  if (!getTenantPayPolicy(tenantId).requireInstallConfirm) return { held: false, payableAfter: null };
  if (sale.lead_id == null) return { held: false, payableAfter: null };
  const cm = rawDb.prepare(
    `SELECT status, payable_after FROM commissions
     WHERE tenant_id = ? AND lead_id = ? AND rep_id = ? AND status != 'superseded'
     ORDER BY id DESC LIMIT 1`
  ).get(tenantId, sale.lead_id, sale.rep_id) as any;
  if (!cm || cm.status !== "pending") return { held: false, payableAfter: null };
  if (cm.payable_after == null || cm.payable_after > now) return { held: true, payableAfter: cm.payable_after ?? null };
  return { held: false, payableAfter: cm.payable_after };
}

/**
 * Reconcile the ledger with one sale's current status. Called inside the same
 * transaction that flips the sale wherever possible; synchronous better-sqlite3
 * makes the read-then-insert race-free there.
 *
 * `weekStartUtc` is the sale's pay week (computed by the caller from the org
 * config — the same week the downline's statement uses).
 */
export function syncOverridesForSale(
  tenantId: number,
  saleId: number,
  actorId: number | null,
  weekStartUtc: string,
): void {
  const sale = rawDb.prepare(`SELECT * FROM commission_sales WHERE id = ? AND tenant_id = ?`).get(saleId, tenantId) as any;
  if (!sale) return; // foreign/missing sale — nothing to reconcile
  const sourceRef = `sale:${sale.id}`;
  const existing = rowsForSource(tenantId, sourceRef);
  const byBeneficiary = new Map<number, LedgerRow[]>();
  for (const r of existing) {
    const list = byBeneficiary.get(r.beneficiary_rep_id);
    if (list) list.push(r); else byBeneficiary.set(r.beneficiary_rep_id, [r]);
  }
  const now = nowIso();

  if (sale.status === "QUALIFIED") {
    const { enabled, rates: orgRates } = loadOverrideRates(tenantId);
    if (!enabled) return; // org kill-switch — earns only accrue while on
    const members = storage.getTeamMembers(tenantId);
    const membersById = new Map<number, UplineChainMemberInput>(
      members.map((m: any) => [m.id, { id: m.id, role: m.role, reportsToId: m.reportsToId ?? null, active: !!m.active }]),
    );
    // The SELLER's per-hire rates (chosen at invite time) win over the org
    // config; NULL inherits. Frozen into rate_snapshot with everything else.
    const seller = members.find((m: any) => m.id === sale.rep_id) as any;
    const rates = resolveSellerRates(orgRates, seller);
    const { chain, corrupt } = resolveOverrideChain(sale.rep_id, membersById);
    if (corrupt) {
      // Corrupt/cyclic tree: earn NOTHING (fail closed), audit once, and never
      // block the knock that got us here.
      storage.logActivity(actorId, "override.chain_corrupt", "commission_sale", sale.id,
        { sourceRef, sellerRepId: sale.rep_id }, undefined);
      return;
    }
    const { awards, chainSnapshot } = computeFlatOverrides(chain, rates);
    if (awards.length === 0) return;
    const rateSnapshot = JSON.stringify(rates);
    const chainJson = JSON.stringify(chainSnapshot);
    const hold = installHoldFor(tenantId, sale, now);
    for (const award of awards) {
      const pair = byBeneficiary.get(award.repId) ?? [];
      if (pair.length % 2 === 1) continue; // pair already open — earned, no-op
      // Never inject money into an upline week that is already locked — the
      // same rule the rep-side engine enforces (anti-gaming guard 3).
      const uplineStmt = rawDb.prepare(
        `SELECT status FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`
      ).get(tenantId, award.repId, weekStartUtc) as any;
      const uplineLocked = uplineStmt && (uplineStmt.status === "FINALIZED" || uplineStmt.status === "PAID");
      const status: OverrideLedgerStatus = uplineLocked ? "EXCEPTION" : hold.held ? "HELD" : "PAYABLE";
      rawDb.prepare(
        `INSERT INTO commission_overrides
           (tenant_id, source_ref, sale_id, downline_rep_id, beneficiary_rep_id, beneficiary_role, level,
            entry_type, pair_seq, basis, amount_cents, rate_snapshot, chain_snapshot,
            earned_week_start_utc, status, hold_payable_after, reason, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'EARN',?,?,?,?,?, ?,?,?,?,?,?,?)`
      ).run(
        tenantId, sourceRef, sale.id, sale.rep_id, award.repId, award.role, award.level,
        pair.length, rates.basis, award.amountCents, rateSnapshot, chainJson,
        weekStartUtc, status, hold.held ? hold.payableAfter : null,
        uplineLocked ? "LOCKED_WEEK_EARN" : null, actorId, now, now,
      );
    }
    return;
  }

  // Sale is not QUALIFIED (REVERSED / DISQUALIFIED / CANCELLED / PENDING):
  // close every open pair. The claw mirrors the earn's week so an open-week
  // fold nets to zero; a SETTLED earn becomes a named exception for a manager
  // adjustment — the locked statement is never silently mutated.
  for (const [, pair] of byBeneficiary) {
    if (pair.length % 2 === 0) continue; // closed — nothing to claw
    const earn = pair[pair.length - 1];
    if (earn.entry_type !== "EARN") continue; // defensive: malformed pair
    let clawStatus: OverrideLedgerStatus;
    let reason: string | null = null;
    if (earn.status === "SETTLED") {
      clawStatus = "EXCEPTION";
      reason = "OVERRIDE_REVERSED_AFTER_FINALIZE";
    } else if (earn.status === "PAYABLE") {
      clawStatus = "PAYABLE"; // folds -amount into the same open week → net 0
    } else {
      // HELD or EXCEPTION earns never reached a statement — the reversal moots
      // them. Both rows land RESOLVED so no fold ever sees either side.
      clawStatus = "RESOLVED";
      reason = earn.status === "HELD" ? "REVERSED_WHILE_HELD" : "REVERSED_BEFORE_RESOLUTION";
      rawDb.prepare(`UPDATE commission_overrides SET status='RESOLVED', reason=COALESCE(reason, ?), updated_at=? WHERE id=?`)
        .run(reason, now, earn.id);
    }
    rawDb.prepare(
      `INSERT INTO commission_overrides
         (tenant_id, source_ref, sale_id, downline_rep_id, beneficiary_rep_id, beneficiary_role, level,
          entry_type, pair_seq, basis, amount_cents, rate_snapshot, chain_snapshot,
          earned_week_start_utc, status, hold_payable_after, reason, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'CLAWBACK',?,?,?,
               (SELECT rate_snapshot FROM commission_overrides WHERE id = ?),
               (SELECT chain_snapshot FROM commission_overrides WHERE id = ?),
               ?,?,?,?,?,?,?)`
    ).run(
      tenantId, sourceRef, sale.id, earn.downline_rep_id, earn.beneficiary_rep_id, earn.beneficiary_role, earn.level,
      pair.length, earn.basis, -earn.amount_cents, earn.id, earn.id,
      earn.earned_week_start_utc, clawStatus, null, reason, actorId, now, now,
    );
    if (clawStatus === "EXCEPTION") {
      storage.logActivity(actorId, "override.reversed_after_finalize", "commission_override", earn.id,
        { sourceRef, beneficiaryRepId: earn.beneficiary_rep_id, amountCents: earn.amount_cents }, undefined);
    }
  }
}

/** Every beneficiary with an open (earned) pair for a sale — the uplines whose
 *  statements the caller should recompute after a sync. */
export function beneficiariesForSale(tenantId: number, saleId: number): Array<{ repId: number; weekStartUtc: string }> {
  const rows = rawDb.prepare(
    `SELECT beneficiary_rep_id AS repId, earned_week_start_utc AS weekStartUtc,
            MAX(pair_seq) AS maxSeq, COUNT(*) AS n
     FROM commission_overrides WHERE tenant_id = ? AND source_ref = ?
     GROUP BY beneficiary_rep_id`
  ).all(tenantId, `sale:${saleId}`) as any[];
  // Recompute for every beneficiary that has ANY rows — a fresh claw needs the
  // upline's week re-summed just as much as a fresh earn does.
  return rows.map(r => ({ repId: Number(r.repId), weekStartUtc: r.weekStartUtc }));
}

// ── Statement folding ─────────────────────────────────────────────────────────

/**
 * Release any HELD row whose install hold has passed: it becomes PAYABLE in the
 * week that CONTAINS payable_after (the rep-side release rule). `weekStartOf`
 * is passed by the caller (commissionService) so this module never needs the
 * org-config machinery — same inversion as hourlyPay taking bounds.
 */
export function promoteReleasedHolds(tenantId: number, weekStartOf: (ts: string) => string, now = nowIso()): void {
  const due = rawDb.prepare(
    `SELECT id, beneficiary_rep_id AS beneficiaryRepId, hold_payable_after AS holdPayableAfter
     FROM commission_overrides
     WHERE tenant_id = ? AND status = 'HELD' AND hold_payable_after IS NOT NULL AND hold_payable_after <= ?`
  ).all(tenantId, now) as any[];
  for (const row of due) {
    const releaseWeek = weekStartOf(row.holdPayableAfter);
    // Same rule the EARN path enforces 90 lines up: money may never land PAYABLE
    // in a week that is already FINALIZED or PAID. Without this probe the row
    // went PAYABLE into a locked week, the upline's recalculation threw
    // STATEMENT_LOCKED (swallowed best-effort by the caller), markWeekSettled had
    // already run — and the upline was simply never paid, with nothing on the
    // exceptions rail to catch it. Book EXCEPTION instead so it surfaces for a
    // manager adjustment, exactly like a reversal against a settled week.
    const uplineStmt = rawDb.prepare(
      `SELECT status FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`
    ).get(tenantId, row.beneficiaryRepId, releaseWeek) as any;
    const uplineLocked = uplineStmt && (uplineStmt.status === "FINALIZED" || uplineStmt.status === "PAID");
    rawDb.prepare(
      `UPDATE commission_overrides SET status=?, earned_week_start_utc=?, reason=COALESCE(reason, ?), updated_at=?
       WHERE id=? AND status='HELD'`
    ).run(uplineLocked ? "EXCEPTION" : "PAYABLE", releaseWeek, uplineLocked ? "LOCKED_WEEK_RELEASE" : null, now, row.id);
    if (uplineLocked) {
      storage.logActivity(null, "override.hold_released_into_locked_week", "commission_override", row.id,
        { beneficiaryRepId: row.beneficiaryRepId, weekStartUtc: releaseWeek, statementStatus: uplineStmt.status }, undefined);
    }
  }
}

/** The override block folded into one rep's weekly statement: SUM of PAYABLE
 *  rows (earns net of open-week claws). Recomputed from source on every calc —
 *  never accumulated, never double-counted (the hourly-pay rule). */
export function overrideBlockForWeek(
  tenantId: number, repId: number, weekStartUtc: string,
  weekStartOf?: (ts: string) => string,
): { payCents: number; itemCount: number } {
  if (weekStartOf) promoteReleasedHolds(tenantId, weekStartOf);
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS n FROM commission_overrides
     WHERE tenant_id = ? AND beneficiary_rep_id = ? AND earned_week_start_utc = ? AND status = 'PAYABLE'`
  ).get(tenantId, repId, weekStartUtc) as any;
  return { payCents: Number(row?.s ?? 0), itemCount: Number(row?.n ?? 0) };
}

/** Freeze the week's PAYABLE rows into a finalized statement. Returns the
 *  frozen rows for the contributing_overrides snapshot. */
export function markWeekSettled(tenantId: number, repId: number, weekStartUtc: string, statementId: number): LedgerRow[] {
  const now = nowIso();
  rawDb.prepare(
    `UPDATE commission_overrides SET status='SETTLED', settled_statement_id=?, updated_at=?
     WHERE tenant_id = ? AND beneficiary_rep_id = ? AND earned_week_start_utc = ? AND status = 'PAYABLE'`
  ).run(statementId, now, tenantId, repId, weekStartUtc);
  return rawDb.prepare(
    `SELECT * FROM commission_overrides WHERE tenant_id = ? AND settled_statement_id = ? ORDER BY id`
  ).all(tenantId, statementId) as LedgerRow[];
}

/** REOPEN undoes the freeze: settled rows return to PAYABLE so the reopened
 *  week recomputes truthfully instead of silently dropping its overrides. */
export function markStatementReopened(tenantId: number, statementId: number): void {
  rawDb.prepare(
    `UPDATE commission_overrides SET status='PAYABLE', settled_statement_id=NULL, updated_at=?
     WHERE tenant_id = ? AND settled_statement_id = ? AND status = 'SETTLED'`
  ).run(nowIso(), tenantId, statementId);
}

// ── Read models ───────────────────────────────────────────────────────────────

const wireSelect = `
  SELECT o.id, o.sale_id AS saleId, s.sold_at AS soldAt, s.status AS saleStatus,
         o.downline_rep_id AS downlineRepId, COALESCE(tm.name, 'Unknown') AS downlineRepName,
         o.beneficiary_rep_id AS beneficiaryRepId, tm.role AS downlineRole,
         o.level, o.basis, o.entry_type AS entryType, o.amount_cents AS amountCents,
         o.status, o.hold_payable_after AS holdPayableAfter
  FROM commission_overrides o
  LEFT JOIN commission_sales s ON s.id = o.sale_id
  LEFT JOIN team_members tm ON tm.id = o.downline_rep_id`;

function mapWire(r: any): OverrideRowWire {
  return {
    id: Number(r.id), saleId: r.saleId == null ? null : Number(r.saleId),
    soldAt: r.soldAt ?? null, saleStatus: r.saleStatus ?? null,
    downlineRepId: Number(r.downlineRepId), downlineRepName: String(r.downlineRepName ?? "Unknown"),
    downlineRoleAtEarn: String(r.downlineRole ?? "rep"),
    level: Number(r.level), basis: r.basis === "PERCENT_OF_COMMISSION" ? "PERCENT_OF_COMMISSION" : "FLAT_PER_SALE",
    entryType: r.entryType === "CLAWBACK" ? "CLAWBACK" : "EARN",
    amountCents: Number(r.amountCents),
    status: r.status as OverrideLedgerStatus,
    holdPayableAfter: r.holdPayableAfter ?? null,
  };
}

/** One beneficiary's ledger rows for a week (per-sale drill-down). */
export function listWeekOverridesForBeneficiary(tenantId: number, repId: number, weekStartUtc: string): OverrideRowWire[] {
  const rows = rawDb.prepare(
    `${wireSelect}
     WHERE o.tenant_id = ? AND o.beneficiary_rep_id = ? AND o.earned_week_start_utc = ?
     ORDER BY COALESCE(s.sold_at, o.created_at) DESC, o.id DESC`
  ).all(tenantId, repId, weekStartUtc) as any[];
  return rows.map(mapWire);
}

/** Batch: override pay per beneficiary for a week (the week-overview join).
 *  PAYABLE only — mirrors overrideBlockForWeek so console and statement agree. */
export function sumWeekOverridesByRep(tenantId: number, weekStartUtc: string): Map<number, { payCents: number; itemCount: number }> {
  const rows = rawDb.prepare(
    `SELECT beneficiary_rep_id AS repId, COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n
     FROM commission_overrides
     WHERE tenant_id = ? AND earned_week_start_utc = ? AND status = 'PAYABLE'
     GROUP BY beneficiary_rep_id`
  ).all(tenantId, weekStartUtc) as any[];
  return new Map(rows.map(r => [Number(r.repId), { payCents: Number(r.s), itemCount: Number(r.n) }]));
}

/** Does this rep have ANY ledger presence for the week? (getWeekOverview's
 *  "payable surface" test for including managers.) */
export function hasOverrideRowsForWeek(tenantId: number, repId: number, weekStartUtc: string): boolean {
  return !!rawDb.prepare(
    `SELECT 1 FROM commission_overrides WHERE tenant_id = ? AND beneficiary_rep_id = ? AND earned_week_start_utc = ? LIMIT 1`
  ).get(tenantId, repId, weekStartUtc);
}

/** Open exceptions for the console (reversals against settled weeks, earns
 *  that landed in locked weeks). */
export function listExceptions(tenantId: number): Array<OverrideRowWire & { beneficiaryRepId: number; beneficiaryName: string; reason: string | null; earnedWeekStartUtc: string }> {
  const rows = rawDb.prepare(
    `SELECT o.id, o.sale_id AS saleId, s.sold_at AS soldAt, s.status AS saleStatus,
            o.downline_rep_id AS downlineRepId, COALESCE(tm.name, 'Unknown') AS downlineRepName,
            o.beneficiary_rep_id AS beneficiaryRepId, tm.role AS downlineRole,
            o.level, o.basis, o.entry_type AS entryType, o.amount_cents AS amountCents,
            o.status, o.hold_payable_after AS holdPayableAfter,
            o.reason, o.earned_week_start_utc AS earnedWeekStartUtc,
            (SELECT tb.name FROM team_members tb WHERE tb.id = o.beneficiary_rep_id) AS beneficiaryName
     FROM commission_overrides o
     LEFT JOIN commission_sales s ON s.id = o.sale_id
     LEFT JOIN team_members tm ON tm.id = o.downline_rep_id
     WHERE o.tenant_id = ? AND o.status = 'EXCEPTION'
     ORDER BY o.created_at DESC`
  ).all(tenantId) as any[];
  return rows.map(r => ({
    ...mapWire(r),
    beneficiaryRepId: Number(r.beneficiaryRepId),
    beneficiaryName: String(r.beneficiaryName ?? "Unknown"),
    reason: r.reason ?? null,
    earnedWeekStartUtc: String(r.earnedWeekStartUtc),
  }));
}

/** Close an exception after the manager books the correcting adjustment.
 *  Compare-and-swap so a double-click resolves exactly once. */
export function resolveException(tenantId: number, overrideId: number, adjustmentId: number, actorId: number | null): void {
  const result = rawDb.prepare(
    `UPDATE commission_overrides SET status='RESOLVED', resolved_adjustment_id=?, updated_at=?
     WHERE id = ? AND tenant_id = ? AND status = 'EXCEPTION'`
  ).run(adjustmentId, nowIso(), overrideId, tenantId);
  if (result.changes === 0) throw new OverrideError("EXCEPTION_NOT_OPEN", "Override exception not found or already resolved.", 409);
  storage.logActivity(actorId, "override.exception_resolved", "commission_override", overrideId,
    { adjustmentId }, undefined);
}
