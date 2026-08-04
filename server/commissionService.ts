// ── Weekly Commission service — persistence + calculation orchestration ───────
// Wires the PURE domain modules (shared/workweek.ts, shared/commissionTiers.ts)
// to persisted data. All money is integer cents; the server is authoritative
// (never trusts a client-supplied count/rate/total/week). Tenant-scoped: every
// query carries tenant_id AND we verify referenced rows share the tenant.
// Deliberately isolated from the legacy commissions/commissionRates + any MLM.

import crypto from "crypto";
import { rawDb } from "./db";
import { storage } from "./storage";
import { weekBoundsFor, type WorkweekConfig, DEFAULT_WORKWEEK, type WeekBounds } from "@shared/workweek";
import { computeHoldback, rollupReserve, type Holdback, type ReserveLedger } from "@shared/commissionReserve";
import {
  resolveRepReserveConfig, getReserveBalanceCents, recordWeeklyHold, setRepReserveConfig,
} from "./reserveService";
import {
  validateTiers, calculateRetroactiveCommission, calculateFlatCommission, formatUsdCents,
  type CommissionTier, type RetroResult, DEFAULT_RETRO_TIERS,
} from "@shared/commissionTiers";
import { hourlyPayForWeek, type WeekHourlyPay } from "./hourlyPay";
import { getTenantPayPolicy } from "./payPolicyStore";
import { isCommissionHeld } from "@shared/commissionHold";

// ── Typed domain errors ───────────────────────────────────────────────────────
export type CommissionErrorCode =
  | "INVALID_TIMEZONE" | "INVALID_COMMISSION_PLAN" | "INVALID_TIER_CONFIGURATION"
  | "UNSUPPORTED_TIER_MODE" | "NO_EFFECTIVE_PLAN_ASSIGNMENT" | "OVERLAPPING_PLAN_ASSIGNMENT"
  | "STATEMENT_LOCKED" | "DUPLICATE_SALE" | "CROSS_TENANT_ACCESS"
  | "UNAUTHORIZED_COMMISSION_ACTION" | "INVALID_WORKWEEK" | "INVALID_ADJUSTMENT"
  | "CONCURRENT_STATEMENT_UPDATE" | "WEEK_KEY_FROZEN" | "OPEN_CLOCK_SESSION"
  | "INVALID_HOUSE_AMOUNT";

export class CommissionError extends Error {
  constructor(public code: CommissionErrorCode, message: string, public httpStatus = 400) {
    super(message);
    this.name = "CommissionError";
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
export interface OrgCommissionConfig extends WorkweekConfig {
  qualificationBasis: QualificationBasis;
  finalizationDelayHours: number;
  correctionWindowDays: number;
  autoFinalizeEnabled: boolean;
  /** Chargeback-reserve holdback rate, whole percent. 0 = disabled (default),
   *  so no tenant's payroll changes until an operator sets it (the agreement's
   *  10% is a deliberate opt-in, gated by the same counsel review). */
  reservePercent: number;
  /** What the company books for one qualified sale, in cents. 0 = not set, and
   *  the statement omits the house column instead of printing $0.00 per door. */
  houseAmountCents: number;
}
export type QualificationBasis = "SOLD_AT" | "QUALIFIED_AT" | "INSTALLED_AT" | "ACTIVATED_AT";
const BASIS_COLUMN: Record<QualificationBasis, string> = {
  SOLD_AT: "sold_at", QUALIFIED_AT: "qualified_at", INSTALLED_AT: "installed_at", ACTIVATED_AT: "activated_at",
};

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

// Load a tenant's commission config, falling back to the documented defaults.
export function loadOrgConfig(tenantId: number): OrgCommissionConfig {
  const row = rawDb.prepare(
    `SELECT commission_timezone AS tz, commission_week_starts_on AS weekStartsOn,
            commission_week_start_local_time AS weekStartLocalTime,
            commission_qualification_basis AS basis,
            commission_finalization_delay_hours AS finalizationDelayHours,
            commission_correction_window_days AS correctionWindowDays,
            commission_auto_finalize_enabled AS autoFinalizeEnabled,
            commission_reserve_percent AS reservePercent,
            commission_house_amount_cents AS houseAmountCents
     FROM tenants WHERE id = ?`
  ).get(tenantId) as any;
  const tz = row?.tz || DEFAULT_WORKWEEK.timezone;
  if (!isValidTimezone(tz)) throw new CommissionError("INVALID_TIMEZONE", `Unsupported timezone: ${tz}`);
  const basis = (row?.basis || "QUALIFIED_AT") as QualificationBasis;
  if (!BASIS_COLUMN[basis]) throw new CommissionError("INVALID_WORKWEEK", `Unsupported qualification basis: ${basis}`);
  // Only Monday 00:00 is production-executable today; config is stored for future
  // expansion but we don't pretend an arbitrary start works.
  return {
    timezone: tz,
    weekStartsOn: Number(row?.weekStartsOn ?? 1),
    weekStartLocalTime: row?.weekStartLocalTime || "00:00",
    qualificationBasis: basis,
    finalizationDelayHours: Number(row?.finalizationDelayHours ?? 0),
    correctionWindowDays: Number(row?.correctionWindowDays ?? 30),
    autoFinalizeEnabled: !!row?.autoFinalizeEnabled,
    reservePercent: Math.min(100, Math.max(0, Number(row?.reservePercent ?? 0))),
    houseAmountCents: Math.max(0, Math.trunc(Number(row?.houseAmountCents ?? 0))),
  };
}

// ── Assignment resolution (PURE) ──────────────────────────────────────────────
export interface AssignmentRow {
  id: number; commissionPlanVersionId: number; effectiveFrom: string; effectiveTo: string | null;
}
// The assignment effective for a week: the one whose [effectiveFrom, effectiveTo)
// window contains the week's START date. A mid-week plan change therefore never
// re-prices the running week (one plan governs one week — matches retroactive
// weekly semantics). NEW-HIRE EXCEPTION: when no plan existed at week start and
// nextWeekStartUtc is given, the earliest assignment STARTING inside the week
// governs the partial hire week — otherwise a rep onboarded on a Wednesday sees
// "no plan" until Monday. Dates compared as YYYY-MM-DD strings.
export function resolveAssignmentForWeek<T extends AssignmentRow>(assignments: T[], weekStartUtc: string, nextWeekStartUtc?: string): T | null {
  const wk = weekStartUtc.slice(0, 10); // the week's start calendar date (UTC ISO)
  const covering = assignments.filter(a =>
    a.effectiveFrom.slice(0, 10) <= wk && (a.effectiveTo == null || wk < a.effectiveTo.slice(0, 10)));
  if (covering.length > 0) {
    // Most recent effectiveFrom wins if (defensively) more than one matches.
    return covering.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  }
  if (!nextWeekStartUtc) return null;
  const nk = nextWeekStartUtc.slice(0, 10);
  const startingWithin = assignments.filter(a => {
    const from = a.effectiveFrom.slice(0, 10);
    return from > wk && from < nk && (a.effectiveTo == null || from < a.effectiveTo.slice(0, 10));
  });
  if (startingWithin.length === 0) return null;
  return startingWithin.sort((a, b) => (a.effectiveFrom > b.effectiveFrom ? 1 : -1))[0]; // earliest
}

// Detect overlapping active periods for a rep (service-level, since SQLite has no
// range-exclusion constraint). Returns true if `candidate` overlaps any existing.
export function assignmentsOverlap(
  existing: Array<{ effectiveFrom: string; effectiveTo: string | null }>,
  candidate: { effectiveFrom: string; effectiveTo: string | null },
): boolean {
  const cf = candidate.effectiveFrom.slice(0, 10);
  const ct = candidate.effectiveTo ? candidate.effectiveTo.slice(0, 10) : null;
  return existing.some(e => {
    const ef = e.effectiveFrom.slice(0, 10);
    const et = e.effectiveTo ? e.effectiveTo.slice(0, 10) : null;
    // half-open [from, to); open-ended treated as +infinity
    const aEnd = ct ?? "9999-12-31";
    const bEnd = et ?? "9999-12-31";
    return cf < bEnd && ef < aEnd;
  });
}

// ── computeStatement (PURE — the financial heart, fully unit-tested) ───────────
export interface StatementComputation {
  qualifiedSaleCount: number;
  tierId: number | string | null;
  tierLabel: string | null;
  rateCents: number;
  grossCommissionCents: number;
  adjustmentCents: number;
  finalCommissionCents: number;
  retro: RetroResult | null; // null for flat plans; carries next-tier projection otherwise
}

export function computeStatement(params: {
  planType: "FLAT" | "TIERED";
  tierMode: string;
  flatRateCents: number | null;
  tiers: CommissionTier[];
  qualifiedSaleCount: number;
  approvedAdjustmentCents: number;
}): StatementComputation {
  const count = Math.max(0, Math.trunc(params.qualifiedSaleCount || 0));
  const adj = Math.trunc(params.approvedAdjustmentCents || 0);

  if (params.planType === "FLAT") {
    const rate = Math.max(0, Math.trunc(params.flatRateCents || 0));
    const gross = calculateFlatCommission(count, rate);
    return { qualifiedSaleCount: count, tierId: null, tierLabel: null, rateCents: rate, grossCommissionCents: gross, adjustmentCents: adj, finalCommissionCents: gross + adj, retro: null };
  }

  // TIERED — only RETROACTIVE_WEEKLY is executable this phase.
  if (params.tierMode !== "RETROACTIVE_WEEKLY") {
    throw new CommissionError("UNSUPPORTED_TIER_MODE", `Tier mode ${params.tierMode} is not supported for calculation yet.`);
  }
  const v = validateTiers(params.tiers);
  if (!v.ok) throw new CommissionError("INVALID_TIER_CONFIGURATION", v.errors.join(" "));
  const retro = calculateRetroactiveCommission(count, v.normalized);
  return {
    qualifiedSaleCount: count,
    tierId: retro.tierId,
    tierLabel: retro.tierLabel,
    rateCents: retro.rateCents,
    grossCommissionCents: retro.grossCommissionCents,
    adjustmentCents: adj,
    finalCommissionCents: retro.grossCommissionCents + adj,
    retro,
  };
}

// ── DB helpers (tenant-scoped, indexed) ───────────────────────────────────────
function loadTiers(tenantId: number, versionId: number): CommissionTier[] {
  return rawDb.prepare(
    `SELECT id, position, minimum_sales AS minimumSales, maximum_sales AS maximumSales, rate_cents AS rateCents, label
     FROM commission_tiers WHERE tenant_id = ? AND commission_plan_version_id = ? ORDER BY minimum_sales ASC`
  ).all(tenantId, versionId) as CommissionTier[];
}

// Aggregate qualified sales for a rep+week via the composite index — one query,
// no rows loaded into JS, no N+1. Half-open [weekStart, nextWeekStart).
//
// ── Install-hold overlay (tenant_pay_policy) ─────────────────────────────────
// Semantics mirror shared/commissionHold.ts (the pure read-side math), applied
// here at the ONE aggregation point every pay surface funnels through
// (statements → week-overview → week-export.csv → NACHA), so the money math
// itself is never forked. Under a require-install-confirm policy a QUALIFIED
// sale with a linked legacy commissions row is hold-gated:
//   • install never confirmed (payable_after NULL) → never payable;
//   • confirmed but now < payable_after → still inside the hold window;
//   • released (now >= payable_after) → the sale counts in the week containing
//     payable_after — necessarily a current-or-future (OPEN) week at confirm
//     time, so released money cannot strand inside a week that FINALIZED
//     without it. (Edge: a manager who FINALIZES mid-week can outrun a
//     payable_after landing later in that same week — a sequencing error the
//     frozen statement surfaces, not something the hold silently "fixes".)
// Sales with NO linked commissions row (API-booked, lead_id NULL) are not
// hold-gated — the hold is a knock-sale control; managers booking sales
// directly are the control there. requireInstallConfirm=false collapses the
// overlay to the legacy query, byte for byte.
function countQualifiedSales(tenantId: number, repId: number, basis: QualificationBasis, bounds: WeekBounds, now: Date = new Date()): number {
  const col = BASIS_COLUMN[basis];
  const policy = getTenantPayPolicy(tenantId);
  if (!policy.requireInstallConfirm) {
    const row = rawDb.prepare(
      `SELECT COUNT(*) AS c FROM commission_sales
       WHERE tenant_id = ? AND rep_id = ? AND status = 'QUALIFIED'
         AND ${col} IS NOT NULL AND ${col} >= ? AND ${col} < ?`
    ).get(tenantId, repId, bounds.weekStartUtc, bounds.nextWeekStartUtc) as any;
    return Number(row?.c ?? 0);
  }
  // The CASE below is the SQL rendering of isCommissionHeld() (pending status,
  // unconfirmed install, or now < payable_after) plus the release-week rule —
  // only a HELD linked commission gates the sale; any other lifecycle status
  // (approved/paid/disputed) follows the legacy basis exactly as before.
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS c FROM (
       SELECT CASE
         WHEN cm_status IS NULL THEN basis_ts          -- no linked commission: not hold-gated
         WHEN cm_status != 'pending' THEN basis_ts     -- held is a pending-only flag
         WHEN hold_payable_after IS NULL THEN NULL     -- install never confirmed: never payable
         WHEN hold_payable_after > ? THEN NULL         -- inside the hold window: not yet payable
         ELSE hold_payable_after                       -- released: pays in the payable_after week
       END AS effective_ts
       FROM (
         SELECT cs.${col} AS basis_ts,
           (SELECT cm.status FROM commissions cm
             WHERE cm.tenant_id = cs.tenant_id AND cm.lead_id = cs.lead_id AND cm.rep_id = cs.rep_id
               AND cm.status != 'superseded'
             ORDER BY cm.id DESC LIMIT 1) AS cm_status,
           (SELECT cm.payable_after FROM commissions cm
             WHERE cm.tenant_id = cs.tenant_id AND cm.lead_id = cs.lead_id AND cm.rep_id = cs.rep_id
               AND cm.status != 'superseded'
             ORDER BY cm.id DESC LIMIT 1) AS hold_payable_after
         FROM commission_sales cs
         WHERE cs.tenant_id = ? AND cs.rep_id = ? AND cs.status = 'QUALIFIED'
       )
     )
     WHERE effective_ts >= ? AND effective_ts < ?`
  ).get(now.toISOString(), tenantId, repId, bounds.weekStartUtc, bounds.nextWeekStartUtc) as any;
  return Number(row?.c ?? 0);
}

/** Read-model projection of the hold overlay: QUALIFIED sales whose natural
 *  basis falls in this week but which the install hold currently excludes from
 *  the statement. Display only — the money exclusion itself lives in
 *  countQualifiedSales above. */
function installHeldSalesForWeek(tenantId: number, repId: number, basis: QualificationBasis, bounds: WeekBounds, now: Date = new Date()): {
  saleCount: number; earliestPayableAfter: string | null;
} {
  const policy = getTenantPayPolicy(tenantId);
  if (!policy.requireInstallConfirm) return { saleCount: 0, earliestPayableAfter: null };
  const col = BASIS_COLUMN[basis];
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS c, MIN(hold_payable_after) AS earliest FROM (
       SELECT
         (SELECT cm.status FROM commissions cm
           WHERE cm.tenant_id = cs.tenant_id AND cm.lead_id = cs.lead_id AND cm.rep_id = cs.rep_id
             AND cm.status != 'superseded'
           ORDER BY cm.id DESC LIMIT 1) AS cm_status,
         (SELECT cm.payable_after FROM commissions cm
           WHERE cm.tenant_id = cs.tenant_id AND cm.lead_id = cs.lead_id AND cm.rep_id = cs.rep_id
             AND cm.status != 'superseded'
           ORDER BY cm.id DESC LIMIT 1) AS hold_payable_after
       FROM commission_sales cs
       WHERE cs.tenant_id = ? AND cs.rep_id = ? AND cs.status = 'QUALIFIED'
         AND COALESCE(cs.${col}, cs.sold_at) >= ? AND COALESCE(cs.${col}, cs.sold_at) < ?
     )
     WHERE cm_status = 'pending' AND (hold_payable_after IS NULL OR hold_payable_after > ?)`
  ).get(tenantId, repId, bounds.weekStartUtc, bounds.nextWeekStartUtc, now.toISOString()) as any;
  return { saleCount: Number(row?.c ?? 0), earliestPayableAfter: row?.earliest ?? null };
}

function sumApprovedAdjustments(tenantId: number, statementId: number): number {
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM commission_adjustments
     WHERE tenant_id = ? AND statement_id = ? AND status = 'APPROVED'`
  ).get(tenantId, statementId) as any;
  return Number(row?.s ?? 0);
}

// ── The service entrypoint ────────────────────────────────────────────────────
export interface StatementDTO {
  statement: any;
  computation: StatementComputation;
  bounds: WeekBounds;
  // The weekly HOURLY block (hybrid hourly+commission): hours from clock
  // sessions + punch corrections, priced at the rate effective at week start.
  hourly: WeekHourlyPay;
}

export function calculateOrRecalculateStatement(input: {
  tenantId: number; repId: number; weekReference: Date | string | number;
  actorId: number | null; requestId?: string | null;
}): StatementDTO {
  const { tenantId, repId, actorId } = input;
  const config = loadOrgConfig(tenantId);
  const bounds = weekBoundsFor(input.weekReference, config);

  // Locked statements are never recalculated by the ordinary path.
  const existing = rawDb.prepare(
    `SELECT * FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`
  ).get(tenantId, repId, bounds.weekStartUtc) as any;
  if (existing && (existing.status === "FINALIZED" || existing.status === "PAID")) {
    throw new CommissionError("STATEMENT_LOCKED",
      `Week ${bounds.localWeekLabel} is ${existing.status}. Use an adjustment or an authorized reopen.`, 409);
  }

  // The hourly block is computed for EVERY statement generation from source
  // (clock sessions + corrections, rate effective at week start) so a re-run
  // always recomputes truthfully — never accumulated, never double-counted.
  const hourly = hourlyPayForWeek(tenantId, repId, bounds.weekStartUtc, bounds.nextWeekStartUtc);
  const approvedAdjustmentCents = existing ? sumApprovedAdjustments(tenantId, existing.id) : 0;

  // Resolve the plan version effective for this week (tenant-scoped).
  const assignments = rawDb.prepare(
    `SELECT id, commission_plan_version_id AS commissionPlanVersionId, effective_from AS effectiveFrom, effective_to AS effectiveTo
     FROM rep_commission_assignments WHERE tenant_id = ? AND rep_id = ? ORDER BY effective_from DESC`
  ).all(tenantId, repId) as AssignmentRow[];
  const assignment = resolveAssignmentForWeek(assignments, bounds.weekStartUtc, bounds.nextWeekStartUtc);

  let comp: StatementComputation;
  let plan: any = null;
  let version: any = null;
  let basis = config.qualificationBasis as QualificationBasis;
  let planSnapshot: string | null = null;
  if (!assignment) {
    // HOURLY-ONLY rep: no commission plan, but an hourly rate governs this
    // week → they still get a weekly statement (hourly pay + adjustments,
    // commission zeros). A rep with NEITHER plan nor rate keeps the legacy
    // NO_EFFECTIVE_PLAN_ASSIGNMENT behavior.
    if (hourly.rateCents == null) throw new CommissionError("NO_EFFECTIVE_PLAN_ASSIGNMENT",
      `No commission plan assigned to rep ${repId} for week ${bounds.localWeekLabel}.`);
    comp = {
      qualifiedSaleCount: 0, tierId: null, tierLabel: null, rateCents: 0,
      grossCommissionCents: 0, adjustmentCents: approvedAdjustmentCents,
      finalCommissionCents: approvedAdjustmentCents, retro: null,
    };
  } else {
    version = rawDb.prepare(
      `SELECT * FROM commission_plan_versions WHERE id = ? AND tenant_id = ?`
    ).get(assignment.commissionPlanVersionId, tenantId) as any;
    if (!version) throw new CommissionError("CROSS_TENANT_ACCESS", "Plan version not found in tenant.", 404);
    plan = rawDb.prepare(`SELECT * FROM commission_plans WHERE id = ? AND tenant_id = ?`).get(version.commission_plan_id, tenantId) as any;
    if (!plan) throw new CommissionError("INVALID_COMMISSION_PLAN", "Plan not found in tenant.", 404);

    const tiers = plan.type === "TIERED" ? loadTiers(tenantId, version.id) : [];
    basis = (version.qualification_basis || config.qualificationBasis) as QualificationBasis;
    const qualifiedSaleCount = countQualifiedSales(tenantId, repId, basis, bounds);

    comp = computeStatement({
      planType: plan.type, tierMode: plan.tier_mode, flatRateCents: version.flat_rate_cents,
      tiers, qualifiedSaleCount, approvedAdjustmentCents,
    });

    planSnapshot = JSON.stringify({
      planId: plan.id, versionNumber: version.version_number, type: plan.type, tierMode: plan.tier_mode,
      flatRateCents: version.flat_rate_cents, currency: plan.currency,
      tiers: tiers.map(t => ({ minimumSales: t.minimumSales, maximumSales: t.maximumSales, rateCents: t.rateCents, label: t.label })),
      qualificationBasis: basis,
    });
  }
  const now = new Date().toISOString();

  // No-op guard: if nothing material changed (count, money, plan version,
  // hourly block), skip the write AND the audit entry — read-model views (the
  // week console) recompute freely without bumping calculation_version or
  // spamming the activity log.
  if (existing
    && existing.qualified_sale_count === comp.qualifiedSaleCount
    && existing.gross_commission_cents === comp.grossCommissionCents
    && existing.adjustment_cents === comp.adjustmentCents
    && existing.final_commission_cents === comp.finalCommissionCents
    && existing.commission_plan_version_id === (version?.id ?? null)
    && existing.hourly_minutes === hourly.minutes
    && (existing.hourly_rate_cents ?? null) === hourly.rateCents
    && (existing.hourly_pay_cents ?? 0) === hourly.payCents) {
    return { statement: existing, computation: comp, bounds, hourly };
  }

  // Transactional upsert — the unique (tenant,rep,week) index + synchronous
  // better-sqlite3 make duplicate creation impossible under concurrency.
  const tx = rawDb.transaction(() => {
    rawDb.prepare(
      `INSERT INTO commission_statements
        (tenant_id, rep_id, week_start_utc, next_week_start_utc, timezone, local_week_label, qualification_basis,
         commission_plan_id, commission_plan_version_id, plan_version_number, plan_snapshot,
         qualified_sale_count, tier_id, tier_label, rate_cents, gross_commission_cents, adjustment_cents,
         final_commission_cents, hourly_minutes, hourly_rate_cents, hourly_pay_cents,
         calculation_version, status, calculated_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,1,'OPEN',?,?,?)
       ON CONFLICT(tenant_id, rep_id, week_start_utc) DO UPDATE SET
         qualified_sale_count = excluded.qualified_sale_count,
         tier_id = excluded.tier_id, tier_label = excluded.tier_label, rate_cents = excluded.rate_cents,
         gross_commission_cents = excluded.gross_commission_cents,
         adjustment_cents = excluded.adjustment_cents,
         final_commission_cents = excluded.final_commission_cents,
         hourly_minutes = excluded.hourly_minutes,
         hourly_rate_cents = excluded.hourly_rate_cents,
         hourly_pay_cents = excluded.hourly_pay_cents,
         plan_snapshot = excluded.plan_snapshot,
         commission_plan_id = excluded.commission_plan_id,
         commission_plan_version_id = excluded.commission_plan_version_id,
         plan_version_number = excluded.plan_version_number,
         calculation_version = commission_statements.calculation_version + 1,
         calculated_at = excluded.calculated_at, updated_at = excluded.updated_at`
    ).run(
      tenantId, repId, bounds.weekStartUtc, bounds.nextWeekStartUtc, bounds.timezone, bounds.localWeekLabel, basis,
      plan?.id ?? null, version?.id ?? null, version?.version_number ?? null, planSnapshot,
      comp.qualifiedSaleCount, comp.tierId as any, comp.tierLabel, comp.rateCents, comp.grossCommissionCents, comp.adjustmentCents,
      comp.finalCommissionCents, hourly.minutes, hourly.rateCents, hourly.payCents, now, now, now,
    );
  });
  tx();

  const statement = rawDb.prepare(
    `SELECT * FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`
  ).get(tenantId, repId, bounds.weekStartUtc);

  storage.logActivity(actorId, existing ? "commission.statement.recalculated" : "commission.statement.created",
    "commission_statement", (statement as any).id,
    { requestId: input.requestId ?? null, repId, week: bounds.localWeekLabel, qualifiedSaleCount: comp.qualifiedSaleCount, finalCommissionCents: comp.finalCommissionCents, hourlyPayCents: hourly.payCents }, undefined);

  return { statement, computation: comp, bounds, hourly };
}

// ════════════════════════════════════════════════════════════════════════════
// PLAN / VERSION / TIER / ASSIGNMENT / SALE / ADJUSTMENT — write + read helpers.
// All tenant-scoped; all money integer cents. Routes stay thin over these.
// ════════════════════════════════════════════════════════════════════════════

function nowIso(): string { return new Date().toISOString(); }

export function createPlan(tenantId: number, actorId: number | null, input: {
  name: string; description?: string | null; type?: "FLAT" | "TIERED"; tierMode?: string; currency?: string;
}): any {
  if (!input.name || !input.name.trim()) throw new CommissionError("INVALID_COMMISSION_PLAN", "Plan name is required.");
  const type = input.type === "FLAT" ? "FLAT" : "TIERED";
  const tierMode = input.tierMode || "RETROACTIVE_WEEKLY";
  const now = nowIso();
  const info = rawDb.prepare(
    `INSERT INTO commission_plans (tenant_id, name, description, currency, type, tier_mode, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'DRAFT',?,?,?)`
  ).run(tenantId, input.name.trim(), input.description ?? null, input.currency || "USD", type, tierMode, actorId, now, now);
  storage.logActivity(actorId, "commission_structure.created", "commission_plan", Number(info.lastInsertRowid), { name: input.name, type }, undefined);
  return rawDb.prepare(`SELECT * FROM commission_plans WHERE id = ?`).get(info.lastInsertRowid);
}

// Add an IMMUTABLE version to a plan. For TIERED plans the tiers are validated
// (shared/commissionTiers) before persistence; a snapshot is stored for replay.
export function addPlanVersion(tenantId: number, actorId: number | null, planId: number, input: {
  effectiveFrom: string; effectiveTo?: string | null; flatRateCents?: number | null;
  qualificationBasis?: QualificationBasis; tiers?: CommissionTier[]; changeSummary?: string | null;
}): any {
  const plan = rawDb.prepare(`SELECT * FROM commission_plans WHERE id = ? AND tenant_id = ?`).get(planId, tenantId) as any;
  if (!plan) throw new CommissionError("CROSS_TENANT_ACCESS", "Plan not found in tenant.", 404);
  if (!input.effectiveFrom) throw new CommissionError("INVALID_COMMISSION_PLAN", "effectiveFrom is required.");
  const basis = (input.qualificationBasis || "QUALIFIED_AT") as QualificationBasis;
  if (!BASIS_COLUMN[basis]) throw new CommissionError("INVALID_WORKWEEK", `Unsupported qualification basis: ${basis}`);

  let normalizedTiers: CommissionTier[] = [];
  if (plan.type === "TIERED") {
    const v = validateTiers(input.tiers || []);
    if (!v.ok) throw new CommissionError("INVALID_TIER_CONFIGURATION", v.errors.join(" "));
    normalizedTiers = v.normalized;
  } else {
    if (!(typeof input.flatRateCents === "number" && Number.isInteger(input.flatRateCents) && input.flatRateCents > 0)) {
      throw new CommissionError("INVALID_COMMISSION_PLAN", "Flat plans require a positive integer flatRateCents.");
    }
  }

  const next = rawDb.prepare(`SELECT COALESCE(MAX(version_number),0)+1 AS n FROM commission_plan_versions WHERE commission_plan_id = ? AND tenant_id = ?`).get(planId, tenantId) as any;
  const versionNumber = Number(next.n);
  const rulesSnapshot = JSON.stringify({
    type: plan.type, tierMode: plan.tier_mode, flatRateCents: input.flatRateCents ?? null,
    qualificationBasis: basis,
    tiers: normalizedTiers.map(t => ({ minimumSales: t.minimumSales, maximumSales: t.maximumSales, rateCents: t.rateCents, label: t.label })),
  });
  const now = nowIso();

  const tx = rawDb.transaction(() => {
    const info = rawDb.prepare(
      `INSERT INTO commission_plan_versions
        (tenant_id, commission_plan_id, version_number, flat_rate_cents, qualification_basis, effective_from, effective_to, rules_snapshot, change_summary, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(tenantId, planId, versionNumber, input.flatRateCents ?? null, basis, input.effectiveFrom, input.effectiveTo ?? null, rulesSnapshot, input.changeSummary ?? null, actorId, now);
    const versionId = Number(info.lastInsertRowid);
    for (const t of normalizedTiers) {
      rawDb.prepare(
        `INSERT INTO commission_tiers (tenant_id, commission_plan_version_id, position, label, minimum_sales, maximum_sales, rate_cents, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(tenantId, versionId, t.position, t.label, t.minimumSales, t.maximumSales ?? null, t.rateCents, now);
    }
    return versionId;
  });
  const versionId = tx();
  storage.logActivity(actorId, "commission_structure.updated", "commission_plan_version", versionId, { planId, versionNumber, tierCount: normalizedTiers.length }, undefined);
  return rawDb.prepare(`SELECT * FROM commission_plan_versions WHERE id = ?`).get(versionId);
}

export function activatePlan(tenantId: number, actorId: number | null, planId: number): any {
  const plan = rawDb.prepare(`SELECT * FROM commission_plans WHERE id = ? AND tenant_id = ?`).get(planId, tenantId) as any;
  if (!plan) throw new CommissionError("CROSS_TENANT_ACCESS", "Plan not found in tenant.", 404);
  const hasVersion = rawDb.prepare(`SELECT 1 FROM commission_plan_versions WHERE commission_plan_id = ? AND tenant_id = ? LIMIT 1`).get(planId, tenantId);
  if (!hasVersion) throw new CommissionError("INVALID_COMMISSION_PLAN", "Cannot activate a plan with no versions.");
  rawDb.prepare(`UPDATE commission_plans SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND tenant_id = ?`).run(nowIso(), planId, tenantId);
  storage.logActivity(actorId, "commission_structure.updated", "commission_plan", planId, { activated: true }, undefined);
  return rawDb.prepare(`SELECT * FROM commission_plans WHERE id = ?`).get(planId);
}

// Assign a plan VERSION to a rep for an effective period, refusing overlaps.
export function assignPlanVersionToRep(tenantId: number, actorId: number | null, input: {
  repId: number; commissionPlanVersionId: number; effectiveFrom: string; effectiveTo?: string | null;
}): any {
  const rep = storage.getTeamMemberById(input.repId);
  if (!rep || rep.tenantId !== tenantId) throw new CommissionError("CROSS_TENANT_ACCESS", "Rep not found in tenant.", 404);
  const version = rawDb.prepare(`SELECT * FROM commission_plan_versions WHERE id = ? AND tenant_id = ?`).get(input.commissionPlanVersionId, tenantId) as any;
  if (!version) throw new CommissionError("CROSS_TENANT_ACCESS", "Plan version not found in tenant.", 404);
  if (!input.effectiveFrom) throw new CommissionError("INVALID_COMMISSION_PLAN", "effectiveFrom is required.");

  const existing = rawDb.prepare(
    `SELECT effective_from AS effectiveFrom, effective_to AS effectiveTo FROM rep_commission_assignments WHERE tenant_id = ? AND rep_id = ?`
  ).all(tenantId, input.repId) as Array<{ effectiveFrom: string; effectiveTo: string | null }>;
  if (assignmentsOverlap(existing, { effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null })) {
    throw new CommissionError("OVERLAPPING_PLAN_ASSIGNMENT", `Rep ${input.repId} already has a plan for that period.`, 409);
  }
  const info = rawDb.prepare(
    `INSERT INTO rep_commission_assignments (tenant_id, rep_id, commission_plan_version_id, effective_from, effective_to, assigned_by, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(tenantId, input.repId, input.commissionPlanVersionId, input.effectiveFrom, input.effectiveTo ?? null, actorId, nowIso());
  storage.logActivity(actorId, "commission_assignment.created", "rep_commission_assignment", Number(info.lastInsertRowid), { repId: input.repId, versionId: input.commissionPlanVersionId, effectiveFrom: input.effectiveFrom }, undefined);
  return rawDb.prepare(`SELECT * FROM rep_commission_assignments WHERE id = ?`).get(info.lastInsertRowid);
}

// Idempotent commissionable-sale upsert keyed by (tenant, externalId).
export function upsertSale(tenantId: number, actorId: number | null, input: {
  repId: number; externalId: string; status?: string; soldAt: string;
  qualifiedAt?: string | null; installedAt?: string | null; activatedAt?: string | null; leadId?: number | null;
}): any {
  const rep = storage.getTeamMemberById(input.repId);
  if (!rep || rep.tenantId !== tenantId) throw new CommissionError("CROSS_TENANT_ACCESS", "Rep not found in tenant.", 404);
  if (!input.externalId || !input.soldAt) throw new CommissionError("INVALID_ADJUSTMENT", "externalId and soldAt are required.");
  const status = input.status || "PENDING";
  const now = nowIso();
  rawDb.prepare(
    `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, qualified_at, installed_at, activated_at, lead_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, external_id) DO UPDATE SET
       rep_id = excluded.rep_id, status = excluded.status, sold_at = excluded.sold_at,
       qualified_at = excluded.qualified_at, installed_at = excluded.installed_at,
       activated_at = excluded.activated_at, lead_id = excluded.lead_id, updated_at = excluded.updated_at`
  ).run(tenantId, input.repId, input.externalId, status, input.soldAt, input.qualifiedAt ?? null, input.installedAt ?? null, input.activatedAt ?? null, input.leadId ?? null, now, now);
  const sale = rawDb.prepare(`SELECT * FROM commission_sales WHERE tenant_id = ? AND external_id = ?`).get(tenantId, input.externalId) as any;
  storage.logActivity(actorId, "commission_sale.upserted", "commission_sale", sale?.id, { externalId: input.externalId, repId: input.repId, status }, undefined);
  return sale;
}

// Transition a sale's lifecycle. QUALIFY stamps qualifiedAt; REVERSE/DISQUALIFY
// retain the row (status flip + reason), never a physical delete.
export function transitionSale(tenantId: number, actorId: number | null, externalId: string, action: "QUALIFY" | "REVERSE" | "DISQUALIFY" | "CANCEL", opts?: { at?: string; reason?: string | null }): any {
  const sale = rawDb.prepare(`SELECT * FROM commission_sales WHERE tenant_id = ? AND external_id = ?`).get(tenantId, externalId) as any;
  if (!sale) throw new CommissionError("INVALID_ADJUSTMENT", "Sale not found.", 404);
  const at = opts?.at || nowIso();
  const now = nowIso();
  if (action === "QUALIFY") {
    rawDb.prepare(`UPDATE commission_sales SET status='QUALIFIED', qualified_at=COALESCE(qualified_at, ?), updated_at=? WHERE id=?`).run(at, now, sale.id);
  } else if (action === "REVERSE") {
    rawDb.prepare(`UPDATE commission_sales SET status='REVERSED', reversed_at=?, updated_at=? WHERE id=?`).run(at, now, sale.id);
  } else if (action === "DISQUALIFY") {
    rawDb.prepare(`UPDATE commission_sales SET status='DISQUALIFIED', disqualification_reason=?, updated_at=? WHERE id=?`).run(opts?.reason ?? null, now, sale.id);
  } else {
    rawDb.prepare(`UPDATE commission_sales SET status='CANCELLED', updated_at=? WHERE id=?`).run(now, sale.id);
  }
  storage.logActivity(actorId, "commission_sale.transitioned", "commission_sale", sale.id, { externalId, action, reason: opts?.reason ?? null }, undefined);
  const updated = rawDb.prepare(`SELECT * FROM commission_sales WHERE id = ?`).get(sale.id) as any;

  // Best-effort recalculation of the affected week (skip if unassigned/locked).
  const config = loadOrgConfig(tenantId);
  const basisTs = updated[BASIS_COLUMN[config.qualificationBasis]] || updated.sold_at;
  let statement: any = null;
  try {
    statement = calculateOrRecalculateStatement({ tenantId, repId: sale.rep_id, weekReference: basisTs, actorId, requestId: `sale:${externalId}:${action}` }).statement;
  } catch (e) {
    if (!(e instanceof CommissionError && (e.code === "NO_EFFECTIVE_PLAN_ASSIGNMENT" || e.code === "STATEMENT_LOCKED"))) throw e;
  }
  return { sale: updated, statement };
}

// A generous sanity bound so a fat-finger or rogue approver can't swing a payout
// arbitrarily. $1,000,000 in cents — far beyond any real weekly commission.
const MAX_ADJUSTMENT_CENTS = 100_000_000;

// Re-apply the sum of APPROVED adjustments to a statement WITHOUT re-pricing its
// gross from the sales ledger. This is the ONLY sanctioned way a FINALIZED week
// changes: the frozen gross (count × rate) is never touched, but an approved,
// audited adjustment lands on adjustment_cents + final. Never runs on PAID.
export function applyApprovedAdjustments(tenantId: number, statementId: number, actorId: number | null): any {
  const stmt = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ? AND tenant_id = ?`).get(statementId, tenantId) as any;
  if (!stmt) throw new CommissionError("CROSS_TENANT_ACCESS", "Statement not found in tenant.", 404);
  if (stmt.status === "PAID") throw new CommissionError("STATEMENT_LOCKED", "Statement is PAID — money already moved; correct on a future week.", 409);
  const sum = sumApprovedAdjustments(tenantId, statementId);
  const final = stmt.gross_commission_cents + sum; // gross FROZEN — never re-read from the ledger
  rawDb.prepare(
    `UPDATE commission_statements SET adjustment_cents = ?, final_commission_cents = ?, calculation_version = calculation_version + 1, updated_at = ? WHERE id = ?`
  ).run(sum, final, nowIso(), statementId);
  storage.logActivity(actorId, "commission.statement.adjusted", "commission_statement", statementId,
    { adjustmentCents: sum, finalCommissionCents: final, grossFrozen: stmt.gross_commission_cents }, undefined);
  return rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ?`).get(statementId);
}

// Append an adjustment (PENDING). Never zero, bounded, reason required. Only
// APPROVED ones feed a statement. Guards against double-correcting: a sale the
// ledger already reversed on an OPEN week needs no adjustment — the retroactive
// re-price already handled it. (On a FINALIZED week the gross is frozen, so a
// clawback for a post-lock reversal IS the correct action and is allowed.)
export function createAdjustment(tenantId: number, actorId: number | null, input: {
  statementId: number; amountCents: number; type?: string; reason: string; relatedSaleId?: number | null;
}): any {
  const stmt = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ? AND tenant_id = ?`).get(input.statementId, tenantId) as any;
  if (!stmt) throw new CommissionError("CROSS_TENANT_ACCESS", "Statement not found in tenant.", 404);
  if (stmt.status === "PAID") throw new CommissionError("STATEMENT_LOCKED", "Statement is PAID — book corrections on a future week, not a paid one.", 409);
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) throw new CommissionError("INVALID_ADJUSTMENT", "amountCents must be a non-zero integer.");
  if (Math.abs(input.amountCents) > MAX_ADJUSTMENT_CENTS) throw new CommissionError("INVALID_ADJUSTMENT", `Adjustment exceeds the ${formatUsdCents(MAX_ADJUSTMENT_CENTS)} limit.`);
  if (!input.reason || !input.reason.trim()) throw new CommissionError("INVALID_ADJUSTMENT", "A reason is required.");
  if (input.relatedSaleId != null && (stmt.status === "OPEN" || stmt.status === "REVIEW")) {
    const sale = rawDb.prepare(`SELECT status FROM commission_sales WHERE id = ? AND tenant_id = ?`).get(input.relatedSaleId, tenantId) as any;
    if (sale && sale.status === "REVERSED") {
      throw new CommissionError("INVALID_ADJUSTMENT", "That sale is already reversed and excluded from this open week — no adjustment needed.", 409);
    }
  }
  const info = rawDb.prepare(
    `INSERT INTO commission_adjustments (tenant_id, statement_id, rep_id, amount_cents, type, reason, related_sale_id, status, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,'PENDING',?,?)`
  ).run(tenantId, input.statementId, stmt.rep_id, input.amountCents, input.type || "MANUAL", input.reason.trim(), input.relatedSaleId ?? null, actorId, nowIso());
  storage.logActivity(actorId, "commission_adjustment.created", "commission_adjustment", Number(info.lastInsertRowid), { statementId: input.statementId, amountCents: input.amountCents, type: input.type || "MANUAL" }, undefined);
  return rawDb.prepare(`SELECT * FROM commission_adjustments WHERE id = ?`).get(info.lastInsertRowid);
}

// Approve/reject an adjustment. Approval always makes final = gross + Σ(approved)
// hold: on an OPEN week via full recompute; on a FINALIZED week by applying the
// adjustment to the frozen gross (the sanctioned correction path). REJECT is
// allowed on any status (it moves no money) so dangling items can be cleared;
// APPROVE is blocked on PAID.
export function decideAdjustment(tenantId: number, actorId: number | null, adjustmentId: number, decision: "APPROVE" | "REJECT"): any {
  const adj = rawDb.prepare(`SELECT * FROM commission_adjustments WHERE id = ? AND tenant_id = ?`).get(adjustmentId, tenantId) as any;
  if (!adj) throw new CommissionError("CROSS_TENANT_ACCESS", "Adjustment not found in tenant.", 404);
  if (adj.status !== "PENDING") throw new CommissionError("INVALID_ADJUSTMENT", `Adjustment already ${adj.status}.`, 409);
  const stmt = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ? AND tenant_id = ?`).get(adj.statement_id, tenantId) as any;
  if (decision === "APPROVE" && stmt && stmt.status === "PAID") {
    throw new CommissionError("STATEMENT_LOCKED", "Statement is PAID; approve corrections on a future week.", 409);
  }
  const now = nowIso();
  if (decision === "APPROVE") {
    rawDb.prepare(`UPDATE commission_adjustments SET status='APPROVED', approved_by=?, approved_at=? WHERE id=?`).run(actorId, now, adjustmentId);
  } else {
    rawDb.prepare(`UPDATE commission_adjustments SET status='REJECTED', rejected_by=?, rejected_at=? WHERE id=?`).run(actorId, now, adjustmentId);
  }
  storage.logActivity(actorId, `commission_adjustment.${decision.toLowerCase()}d`, "commission_adjustment", adjustmentId, { statementId: adj.statement_id, amountCents: adj.amount_cents }, undefined);

  let statement = stmt;
  if (decision === "APPROVE" && stmt) {
    // OPEN → full recompute (picks up gross from ledger + adjustments).
    // FINALIZED → apply to the frozen gross (never re-price/re-tier a locked week).
    statement = (stmt.status === "FINALIZED")
      ? applyApprovedAdjustments(tenantId, stmt.id, actorId)
      : calculateOrRecalculateStatement({ tenantId, repId: stmt.rep_id, weekReference: stmt.week_start_utc, actorId, requestId: `adjustment:${adjustmentId}:approve` }).statement;
  } else if (decision === "REJECT" && stmt && (stmt.status === "OPEN" || stmt.status === "REVIEW")) {
    // A rejected item shouldn't leave a stale sum on an open statement.
    statement = calculateOrRecalculateStatement({ tenantId, repId: stmt.rep_id, weekReference: stmt.week_start_utc, actorId, requestId: `adjustment:${adjustmentId}:reject` }).statement;
  }
  return { adjustment: rawDb.prepare(`SELECT * FROM commission_adjustments WHERE id = ?`).get(adjustmentId), statement };
}

// ── Scoped statement reads ────────────────────────────────────────────────────
// Read scope by capability: self → own rep only; team → direct reports; all → tenant.
export function listStatements(tenantId: number, filter: { repIds?: number[] | null; weekStartUtc?: string | null }): any[] {
  const clauses: string[] = ["tenant_id = ?"];
  const params: any[] = [tenantId];
  if (filter.repIds) {
    if (filter.repIds.length === 0) return [];
    clauses.push(`rep_id IN (${filter.repIds.map(() => "?").join(",")})`);
    params.push(...filter.repIds);
  }
  if (filter.weekStartUtc) { clauses.push("week_start_utc = ?"); params.push(filter.weekStartUtc); }
  return rawDb.prepare(`SELECT * FROM commission_statements WHERE ${clauses.join(" AND ")} ORDER BY week_start_utc DESC, rep_id ASC`).all(...params) as any[];
}

export function getStatementById(tenantId: number, id: number): any {
  return rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ? AND tenant_id = ?`).get(id, tenantId);
}

// Read-only lookup of a rep's statement for the week containing `weekReference`.
// No write — safe for viewing a locked (FINALIZED/PAID) week.
export function getStatementForWeek(tenantId: number, repId: number, weekReference: Date | string | number): { statement: any; bounds: WeekBounds } {
  const config = loadOrgConfig(tenantId);
  const bounds = weekBoundsFor(weekReference, config);
  const statement = rawDb.prepare(`SELECT * FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`).get(tenantId, repId, bounds.weekStartUtc);
  return { statement, bounds };
}

export function listPlans(tenantId: number): any[] {
  const plans = rawDb.prepare(`SELECT * FROM commission_plans WHERE tenant_id = ? ORDER BY created_at DESC`).all(tenantId) as any[];
  return plans.map(p => ({
    ...p,
    versions: rawDb.prepare(`SELECT * FROM commission_plan_versions WHERE commission_plan_id = ? AND tenant_id = ? ORDER BY version_number ASC`).all(p.id, tenantId),
  }));
}

export function getPlanVersionTiers(tenantId: number, versionId: number): any[] {
  return rawDb.prepare(`SELECT * FROM commission_tiers WHERE tenant_id = ? AND commission_plan_version_id = ? ORDER BY minimum_sales ASC`).all(tenantId, versionId) as any[];
}

export function listRepAssignments(tenantId: number, repId: number): any[] {
  return rawDb.prepare(`SELECT * FROM rep_commission_assignments WHERE tenant_id = ? AND rep_id = ? ORDER BY effective_from DESC`).all(tenantId, repId) as any[];
}

export function getStatementAdjustments(tenantId: number, statementId: number): any[] {
  return rawDb.prepare(`SELECT * FROM commission_adjustments WHERE tenant_id = ? AND statement_id = ? ORDER BY created_at ASC`).all(tenantId, statementId) as any[];
}

export function getSaleByExternalId(tenantId: number, externalId: string): any {
  return rawDb.prepare(`SELECT * FROM commission_sales WHERE tenant_id = ? AND external_id = ?`).get(tenantId, externalId);
}

// Finalize / mark-paid transitions (immutability gate lives here).
export function transitionStatement(tenantId: number, actorId: number | null, statementId: number, action: "FINALIZE" | "REOPEN" | "MARK_PAID"): any {
  const stmt = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ? AND tenant_id = ?`).get(statementId, tenantId) as any;
  if (!stmt) throw new CommissionError("CROSS_TENANT_ACCESS", "Statement not found in tenant.", 404);
  const now = nowIso();
  if (action === "FINALIZE") {
    if (stmt.status === "PAID") throw new CommissionError("STATEMENT_LOCKED", "Paid statements cannot be re-finalized.", 409);
    if (stmt.status !== "FINALIZED") {
      // Same freeze rules as batchTransitionWeek: (1) the OPEN_CLOCK_SESSION
      // guard — an hourly rep with a forgotten open punch must never lock
      // partial hours; (2) recompute-before-freeze so the locked number always
      // matches the live ledger (sales + hourly block) at freeze time.
      const hp = hourlyPayForWeek(tenantId, stmt.rep_id, stmt.week_start_utc, stmt.next_week_start_utc);
      if (hp.rateCents != null && hp.openSessionCount > 0) {
        throw new CommissionError("OPEN_CLOCK_SESSION",
          "Close the open clock session before finalizing hourly pay.", 409);
      }
      calculateOrRecalculateStatement({ tenantId, repId: stmt.rep_id, weekReference: stmt.week_start_utc, actorId, requestId: "finalize-recompute" });
    }
    // Freeze the exact doors that composed this locked number, so the audit
    // drill-down always matches even if a sale is reversed afterward.
    const snapshot = JSON.stringify(listWeekSalesForRep(tenantId, stmt.rep_id, stmt.week_start_utc).filter((s: any) => s.status === "QUALIFIED"));
    rawDb.prepare(`UPDATE commission_statements SET status='FINALIZED', finalized_at=?, finalized_by=?, contributing_sales=?, updated_at=? WHERE id=?`).run(now, actorId, snapshot, now, statementId);
  } else if (action === "REOPEN") {
    if (stmt.status === "PAID") throw new CommissionError("STATEMENT_LOCKED", "Paid statements cannot be reopened.", 409);
    rawDb.prepare(`UPDATE commission_statements SET status='OPEN', finalized_at=NULL, finalized_by=NULL, updated_at=? WHERE id=?`).run(now, statementId);
  } else {
    if (stmt.status !== "FINALIZED") throw new CommissionError("STATEMENT_LOCKED", "Only FINALIZED statements can be marked PAID.", 409);
    rawDb.prepare(`UPDATE commission_statements SET status='PAID', paid_at=?, paid_by=?, updated_at=? WHERE id=?`).run(now, actorId, now, statementId);
  }
  storage.logActivity(actorId, `commission.statement.${action.toLowerCase()}`, "commission_statement", statementId, { from: stmt.status }, undefined);
  const after = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ?`).get(statementId) as any;

  // The week's chargeback-reserve HOLD is appended when the week SETTLES — that
  // is the moment the earned number is frozen, so the amount held can never
  // disagree with the amount paid. Idempotent per (tenant, rep, week) via a
  // unique partial index, so FINALIZE → MARK_PAID (or a reopen + re-finalize)
  // holds exactly once. Never on REOPEN: the ledger is append-only and a
  // correction is a new entry, not a rewrite.
  if (action === "FINALIZE" || action === "MARK_PAID") {
    recordWeeklyHold({
      tenantId, repId: after.rep_id, statementId: after.id,
      weekStartUtc: after.week_start_utc, weekLabel: after.local_week_label,
      earnedCents: Number(after.final_commission_cents || 0), actorId,
    });
  }
  return after;
}

// ── Org config read/update ────────────────────────────────────────────────────
export function updateOrgConfig(tenantId: number, actorId: number | null, patch: Partial<{
  commissionTimezone: string; commissionWeekStartsOn: number; commissionWeekStartLocalTime: string;
  commissionQualificationBasis: QualificationBasis; commissionFinalizationDelayHours: number;
  commissionCorrectionWindowDays: number; commissionAutoFinalizeEnabled: boolean;
  commissionHouseAmountCents: number;
}>): OrgCommissionConfig {
  // House amount is display-only revenue reporting — it never enters a payout —
  // but a negative or fractional value would print nonsense on every statement.
  if (patch.commissionHouseAmountCents != null
      && (!Number.isInteger(patch.commissionHouseAmountCents) || patch.commissionHouseAmountCents < 0)) {
    throw new CommissionError("INVALID_HOUSE_AMOUNT", "House amount must be a non-negative whole number of cents.");
  }
  if (patch.commissionTimezone != null && !isValidTimezone(patch.commissionTimezone)) {
    throw new CommissionError("INVALID_TIMEZONE", `Unsupported timezone: ${patch.commissionTimezone}`);
  }
  if (patch.commissionQualificationBasis != null && !BASIS_COLUMN[patch.commissionQualificationBasis]) {
    throw new CommissionError("INVALID_WORKWEEK", `Unsupported qualification basis: ${patch.commissionQualificationBasis}`);
  }
  // A statement's identity is (tenant, rep, week_start_utc), and week_start_utc
  // is DERIVED from timezone + week-start at compute time. Changing either after
  // a week is locked re-keys that week: the STATEMENT_LOCKED guard looks up the
  // NEW key, misses the FINALIZED/PAID row sitting under the OLD key, and the
  // same still-QUALIFIED sales get counted into a fresh statement and paid twice.
  // So these three keys are frozen once ANY locked statement exists. (Basis,
  // finalization delay, correction window, auto-finalize don't move the key and
  // stay editable.)
  const changesWeekKey = patch.commissionTimezone != null || patch.commissionWeekStartsOn != null || patch.commissionWeekStartLocalTime != null;
  if (changesWeekKey) {
    const locked = rawDb.prepare(
      `SELECT 1 FROM commission_statements WHERE tenant_id = ? AND status IN ('FINALIZED','PAID') LIMIT 1`,
    ).get(tenantId);
    if (locked) {
      throw new CommissionError("WEEK_KEY_FROZEN",
        "Timezone and week-start can't change once a week has been finalized or paid — it would re-key locked weeks and risk paying their sales twice. Reopen/settle those weeks first.", 409);
    }
  }
  const sets: string[] = []; const params: any[] = [];
  const map: Record<string, string> = {
    commissionTimezone: "commission_timezone", commissionWeekStartsOn: "commission_week_starts_on",
    commissionWeekStartLocalTime: "commission_week_start_local_time", commissionQualificationBasis: "commission_qualification_basis",
    commissionFinalizationDelayHours: "commission_finalization_delay_hours", commissionCorrectionWindowDays: "commission_correction_window_days",
    commissionAutoFinalizeEnabled: "commission_auto_finalize_enabled",
    commissionHouseAmountCents: "commission_house_amount_cents",
  };
  for (const [k, col] of Object.entries(map)) {
    const val = (patch as any)[k];
    if (val !== undefined) { sets.push(`${col} = ?`); params.push(k === "commissionAutoFinalizeEnabled" ? (val ? 1 : 0) : val); }
  }
  if (sets.length) {
    params.push(nowIso(), tenantId);
    rawDb.prepare(`UPDATE tenants SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...params);
    storage.logActivity(actorId, "commission_config.updated", "tenant", tenantId, { fields: Object.keys(patch) }, undefined);
  }
  return loadOrgConfig(tenantId);
}

// ════════════════════════════════════════════════════════════════════════════
// ONBOARDING-FACING structure assignment — the "flat vs tiered" choice made when
// a rep is onboarded (Applications approve) or changed later (Team). Resolves the
// choice to a concrete plan VERSION and assigns it, creating the tenant's default
// plans on first use. Keeps the API surface tiny for callers.
// ════════════════════════════════════════════════════════════════════════════

const STANDARD_TIERED_PLAN_NAME = "Standard Weekly Tiers";
const FLAT_PLAN_NAME = "Flat Per-Sale";
const CUSTOM_TIERED_PLAN_NAME = "Custom Weekly Tiers";
// "Today" for default effective-dating. Assignments are resolved against ORG-
// TIMEZONE weeks (weekBoundsFor), so the default must be the org's LOCAL
// calendar date — the UTC date flips to tomorrow during the evening window
// (e.g. 20:00–24:00 ET), which stranded a same-day assignment OUTSIDE the
// running week's resolution window and broke recalculate with
// NO_EFFECTIVE_PLAN_ASSIGNMENT (nightly CI failure 2026-08-02/03).
const todayInTz = (timezone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const orgToday = (tenantId: number) => todayInTz(loadOrgConfig(tenantId).timezone);

export type CommissionStructure = "FLAT" | "TIERED";

// The tenant's canonical retroactive-weekly tiered plan (default tiers), created
// + activated on first use. Idempotent — reused thereafter.
export function getOrCreateStandardTieredVersion(tenantId: number, actorId: number | null): { planId: number; versionId: number } {
  let plan = rawDb.prepare(`SELECT * FROM commission_plans WHERE tenant_id = ? AND type = 'TIERED' AND name = ? ORDER BY id ASC LIMIT 1`).get(tenantId, STANDARD_TIERED_PLAN_NAME) as any;
  if (!plan) plan = createPlan(tenantId, actorId, { name: STANDARD_TIERED_PLAN_NAME, type: "TIERED", tierMode: "RETROACTIVE_WEEKLY", description: "Default retroactive weekly tiers (1–7 $150, 8–12 $200, 13–16 $250, 17+ $300)." });
  let version = rawDb.prepare(`SELECT * FROM commission_plan_versions WHERE tenant_id = ? AND commission_plan_id = ? ORDER BY version_number DESC LIMIT 1`).get(tenantId, plan.id) as any;
  if (!version) version = addPlanVersion(tenantId, actorId, plan.id, { effectiveFrom: orgToday(tenantId), qualificationBasis: "QUALIFIED_AT", tiers: DEFAULT_RETRO_TIERS });
  if (plan.status !== "ACTIVE") activatePlan(tenantId, actorId, plan.id);
  return { planId: plan.id, versionId: version.id };
}

// A flat per-sale plan; each distinct rate is a distinct immutable version under
// the tenant's single "Flat Per-Sale" plan. Reuses a version with the same rate.
export function getOrCreateFlatVersion(tenantId: number, actorId: number | null, flatRateCents: number): { planId: number; versionId: number } {
  if (!(Number.isInteger(flatRateCents) && flatRateCents > 0)) {
    throw new CommissionError("INVALID_COMMISSION_PLAN", "A flat structure needs a positive whole-cent rate.");
  }
  let plan = rawDb.prepare(`SELECT * FROM commission_plans WHERE tenant_id = ? AND type = 'FLAT' AND name = ? ORDER BY id ASC LIMIT 1`).get(tenantId, FLAT_PLAN_NAME) as any;
  if (!plan) plan = createPlan(tenantId, actorId, { name: FLAT_PLAN_NAME, type: "FLAT", description: "Flat per-qualified-sale commission." });
  let version = rawDb.prepare(`SELECT * FROM commission_plan_versions WHERE tenant_id = ? AND commission_plan_id = ? AND flat_rate_cents = ? ORDER BY version_number DESC LIMIT 1`).get(tenantId, plan.id, flatRateCents) as any;
  if (!version) version = addPlanVersion(tenantId, actorId, plan.id, { effectiveFrom: orgToday(tenantId), flatRateCents, qualificationBasis: "QUALIFIED_AT" });
  if (plan.status !== "ACTIVE") activatePlan(tenantId, actorId, plan.id);
  return { planId: plan.id, versionId: version.id };
}

// A tenant-edited weekly ladder; each distinct ladder is a distinct immutable
// version under one "Custom Weekly Tiers" plan — the exact design the flat plan
// already uses for rates. Matching is by the full economic signature (every
// band boundary and rate), so two reps put on the same ladder share a version
// and the version history stays readable instead of growing one row per click.
export function getOrCreateCustomTieredVersion(
  tenantId: number, actorId: number | null, tiers: CommissionTier[],
): { planId: number; versionId: number } {
  const v = validateTiers(tiers || []);
  if (!v.ok) throw new CommissionError("INVALID_TIER_CONFIGURATION", v.errors.join(" "));
  const signature = v.normalized
    .map(t => `${t.minimumSales}-${t.maximumSales ?? "open"}@${t.rateCents}`).join("|");

  let plan = rawDb.prepare(`SELECT * FROM commission_plans WHERE tenant_id = ? AND type = 'TIERED' AND name = ? ORDER BY id ASC LIMIT 1`).get(tenantId, CUSTOM_TIERED_PLAN_NAME) as any;
  if (!plan) plan = createPlan(tenantId, actorId, { name: CUSTOM_TIERED_PLAN_NAME, type: "TIERED", tierMode: "RETROACTIVE_WEEKLY", description: "Manager-edited retroactive weekly ladders. One immutable version per distinct ladder." });

  const versions = rawDb.prepare(`SELECT id FROM commission_plan_versions WHERE tenant_id = ? AND commission_plan_id = ?`).all(tenantId, plan.id) as any[];
  for (const row of versions) {
    const existing = getPlanVersionTiers(tenantId, row.id)
      .map((t: any) => `${t.minimum_sales}-${t.maximum_sales ?? "open"}@${t.rate_cents}`).join("|");
    if (existing === signature) {
      if (plan.status !== "ACTIVE") activatePlan(tenantId, actorId, plan.id);
      return { planId: plan.id, versionId: row.id };
    }
  }
  const version = addPlanVersion(tenantId, actorId, plan.id, {
    effectiveFrom: orgToday(tenantId), qualificationBasis: "QUALIFIED_AT", tiers: v.normalized,
    changeSummary: `Ladder: ${v.normalized.map(t => `${t.label} ${t.rateCents / 100}`).join(", ")}`,
  });
  if (plan.status !== "ACTIVE") activatePlan(tenantId, actorId, plan.id);
  return { planId: plan.id, versionId: version.id };
}

// Assign a FLAT or TIERED structure to a rep. `closeExisting` ends any current
// open assignment at effectiveFrom (half-open) so re-assigning a rep's structure
// never trips the overlap guard — this is how "change a rep's commission" works.
export function assignStructureToRep(tenantId: number, actorId: number | null, input: {
  repId: number; structure: CommissionStructure; flatRateCents?: number | null;
  commissionPlanVersionId?: number | null; effectiveFrom?: string; closeExisting?: boolean;
  tiers?: CommissionTier[] | null;
  // Per-rep chargeback-reserve overrides, set in the SAME action that sets pay
  // (onboarding, or the comp editor). `undefined` leaves them alone; `null`
  // clears the override back to the org default.
  reservePercent?: number | null;
  reserveCapCents?: number | null;
}): { assignment: any; versionId: number; structure: CommissionStructure } {
  const rep = storage.getTeamMemberById(input.repId);
  if (!rep || rep.tenantId !== tenantId) throw new CommissionError("CROSS_TENANT_ACCESS", "Rep not found in tenant.", 404);
  const effectiveFrom = input.effectiveFrom || orgToday(tenantId);

  // Resolve the concrete version: an explicit custom plan version wins; else the
  // structure's canonical plan.
  let versionId: number;
  let structure: CommissionStructure = input.structure;
  if (input.commissionPlanVersionId) {
    const v = rawDb.prepare(`SELECT v.*, p.type AS plan_type FROM commission_plan_versions v JOIN commission_plans p ON p.id = v.commission_plan_id WHERE v.id = ? AND v.tenant_id = ?`).get(input.commissionPlanVersionId, tenantId) as any;
    if (!v) throw new CommissionError("CROSS_TENANT_ACCESS", "Plan version not found in tenant.", 404);
    versionId = v.id;
    structure = v.plan_type === "FLAT" ? "FLAT" : "TIERED";
  } else if (input.structure === "FLAT") {
    versionId = getOrCreateFlatVersion(tenantId, actorId, input.flatRateCents ?? 0).versionId;
  } else if (input.tiers && input.tiers.length > 0) {
    // THE BUG THIS BRANCH FIXES: the Team dialog has always sent the manager's
    // edited ladder, and this function silently dropped it — every "custom"
    // assignment landed on the standard tiers while the toast said otherwise.
    // A manager who set 1-6 at $175 believed it; the rep was paid $150.
    versionId = getOrCreateCustomTieredVersion(tenantId, actorId, input.tiers).versionId;
  } else {
    versionId = getOrCreateStandardTieredVersion(tenantId, actorId).versionId;
  }

  if (input.closeExisting) {
    const open = rawDb.prepare(`SELECT id FROM rep_commission_assignments WHERE tenant_id = ? AND rep_id = ? AND (effective_to IS NULL OR effective_to > ?)`).all(tenantId, input.repId, effectiveFrom) as any[];
    for (const a of open) rawDb.prepare(`UPDATE rep_commission_assignments SET effective_to = ? WHERE id = ?`).run(effectiveFrom, a.id);
  }

  const assignment = assignPlanVersionToRep(tenantId, actorId, { repId: input.repId, commissionPlanVersionId: versionId, effectiveFrom });
  // Reserve overrides travel with the comp change and are audited separately with
  // their own before/after (setRepReserveConfig), so a pay-affecting reserve edit
  // is never buried inside a plan-assignment log line.
  if (input.reservePercent !== undefined || input.reserveCapCents !== undefined) {
    setRepReserveConfig(tenantId, input.repId, actorId, {
      ...(input.reservePercent !== undefined ? { reservePercent: input.reservePercent } : {}),
      ...(input.reserveCapCents !== undefined ? { reserveCapCents: input.reserveCapCents } : {}),
    });
  }
  storage.logActivity(actorId, "commission_structure.assigned", "rep_commission_assignment", assignment.id, { repId: input.repId, structure, versionId, flatRateCents: input.flatRateCents ?? null }, undefined);
  return { assignment, versionId, structure };
}

// Resolve a rep's CURRENT effective structure for display (Team card, rep view):
// structure type, rate/tiers, effective dates — or null if unassigned.
export function getCurrentStructureForRep(tenantId: number, repId: number): any {
  const assignments = listRepAssignments(tenantId, repId).map(a => ({
    id: a.id, commissionPlanVersionId: a.commission_plan_version_id,
    effectiveFrom: a.effective_from, effectiveTo: a.effective_to,
  }));
  // The reserve policy is a property of the REP, not of the plan assignment, so
  // the comp editor can read (and seed from) it even for an unassigned rep.
  const reserve = resolveRepReserveConfig(tenantId, repId);
  const active = resolveAssignmentForWeek(assignments, new Date().toISOString());
  if (!active) return { structure: null, reserve };
  const version = rawDb.prepare(`SELECT v.*, p.name AS plan_name, p.type AS plan_type, p.tier_mode FROM commission_plan_versions v JOIN commission_plans p ON p.id = v.commission_plan_id WHERE v.id = ? AND v.tenant_id = ?`).get(active.commissionPlanVersionId, tenantId) as any;
  if (!version) return { structure: null, reserve };
  const tiers = version.plan_type === "TIERED" ? getPlanVersionTiers(tenantId, version.id) : [];
  const acceptedRow = rawDb.prepare(`SELECT accepted_at FROM rep_commission_assignments WHERE id = ?`).get(active.id) as any;
  return {
    assignmentId: active.id, effectiveFrom: active.effectiveFrom, effectiveTo: active.effectiveTo,
    structure: version.plan_type === "FLAT" ? "FLAT" : "TIERED",
    planName: version.plan_name, planId: version.commission_plan_id, commissionPlanVersionId: version.id,
    flatRateCents: version.flat_rate_cents,
    acceptedAt: acceptedRow?.accepted_at ?? null,
    tiers: tiers.map((t: any) => ({ minimumSales: t.minimum_sales, maximumSales: t.maximum_sales, rateCents: t.rate_cents, label: t.label })),
    reserve,
  };
}

// Picker options for the onboarding/assignment UI: the default tiers (for
// preview), a suggested flat rate, and any existing custom plans in the tenant.
export function getAssignablePlanOptions(tenantId: number): any {
  return {
    standardTiers: DEFAULT_RETRO_TIERS.map(t => ({ minimumSales: t.minimumSales, maximumSales: t.maximumSales, rateCents: t.rateCents, label: t.label })),
    suggestedFlatRateCents: 15000,
    customPlans: listPlans(tenantId)
      .filter((p: any) => p.status === "ACTIVE" && p.name !== STANDARD_TIERED_PLAN_NAME && p.name !== FLAT_PLAN_NAME)
      .map((p: any) => ({ id: p.id, name: p.name, type: p.type, latestVersionId: p.versions?.[p.versions.length - 1]?.id ?? null })),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FIELD-SALE WIRING — the bridge from door-knocking to the weekly engine.
// One commissionable sale PER DOOR: externalId `lead:<leadId>`. Marking a door
// sold (re-)qualifies that one row; un-marking flips it REVERSED. Never deletes,
// never duplicates. A reversal against an already-FINALIZED week does NOT touch
// the locked statement — it surfaces as an exception for a manager adjustment.
// ════════════════════════════════════════════════════════════════════════════

const fieldSaleExternalId = (leadId: number) => `lead:${leadId}`;

export function recordFieldSaleFromKnock(input: {
  tenantId: number; repId: number; leadId: number; knockId: number;
  soldAt: string; serverReceivedAt: string; actorId: number | null;
}): void {
  const { tenantId, repId, leadId, soldAt, serverReceivedAt, actorId } = input;
  const externalId = fieldSaleExternalId(leadId);
  const existing = rawDb.prepare(
    `SELECT id, rep_id, status FROM commission_sales WHERE tenant_id = ? AND external_id = ?`,
  ).get(tenantId, externalId) as any;

  // ── ANTI-GAMING GUARD 1: a live sale is FROZEN (owner + pay-week). ──────────
  // Retroactive weekly pay makes re-crediting and re-timing extremely valuable,
  // so once a door's sale is QUALIFIED its rep_id and its week are set for good.
  // A later "sold" knock — from a teammate who shares the territory, or from the
  // original rep re-knocking in a richer week — is recorded as field history but
  // is a MONEY no-op here. Closes two confirmed exploits:
  //   * sale theft: rep B re-marks rep A's sold door and the ON CONFLICT upsert
  //     flips rep_id (and the whole week's tier contribution) from A to B;
  //   * week re-timing: a rep drags a prior-week sale into this week's count by
  //     re-knocking it "now", inflating the retroactive tier.
  // A genuine correction (wrong rep, wrong week) is a manager reversal, never a
  // silent client-driven overwrite.
  if (existing && existing.status === "QUALIFIED") {
    if (Number(existing.rep_id) !== repId) {
      storage.logActivity(actorId, "commission_sale.credit_conflict_blocked", "commission_sale", existing.id,
        { externalId, leadId, existingRepId: existing.rep_id, attemptedRepId: repId }, undefined);
    }
    return;
  }

  // ── ANTI-GAMING GUARD 2: the pay-week is placed by SERVER-RECEIVED time, ────
  // clamped to the correction window — never by the raw client knock timestamp.
  // Honest offline flush still lands in its true week (a sale that syncs a few
  // days late is inside the window); what this stops is backdating weeks/months
  // to concentrate many sales into one high-tier week. The true field time still
  // records on the knock row as history — this only bounds the MONEY week.
  const config = loadOrgConfig(tenantId);
  const serverMs = Date.parse(serverReceivedAt);
  const floorMs = serverMs - config.correctionWindowDays * 86_400_000;
  const rawMs = Date.parse(soldAt);
  const clampedMs = Math.min(Math.max(Number.isFinite(rawMs) ? rawMs : serverMs, floorMs), serverMs);
  const effectiveSoldAt = new Date(clampedMs).toISOString();

  // ── ANTI-GAMING GUARD 3: never inject QUALIFIED money into a locked week. ───
  // If the target week's statement is already FINALIZED or PAID, the sale is
  // booked PENDING (uncounted) and flagged for manual review instead of silently
  // re-pricing — or worse, latently sitting inside a paid week to surface on the
  // next recalculation. A manager qualifies it into an open correction period.
  const bounds = weekBoundsFor(effectiveSoldAt, config);
  const lockedStmt = rawDb.prepare(
    `SELECT status FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`,
  ).get(tenantId, repId, bounds.weekStartUtc) as any;
  const weekLocked = lockedStmt && (lockedStmt.status === "FINALIZED" || lockedStmt.status === "PAID");

  upsertSale(tenantId, actorId, {
    repId, externalId, status: weekLocked ? "PENDING" : "QUALIFIED",
    soldAt: effectiveSoldAt, qualifiedAt: weekLocked ? null : effectiveSoldAt, leadId,
  });
  if (weekLocked) {
    storage.logActivity(actorId, "commission_sale.locked_week_pending", "commission_sale", undefined,
      { externalId, leadId, weekStartUtc: bounds.weekStartUtc, status: lockedStmt.status }, undefined);
    return;
  }
  // Keep the rep's live week fresh (best-effort — a missing plan must never
  // block the knock).
  try {
    calculateOrRecalculateStatement({ tenantId, repId, weekReference: effectiveSoldAt, actorId, requestId: `field-sale:lead:${leadId}` });
  } catch (e) {
    if (!(e instanceof CommissionError && (e.code === "NO_EFFECTIVE_PLAN_ASSIGNMENT" || e.code === "STATEMENT_LOCKED"))) throw e;
  }
}

export function reverseFieldSale(tenantId: number, leadId: number, actorId: number | null): void {
  const externalId = fieldSaleExternalId(leadId);
  const sale = rawDb.prepare(`SELECT id, status FROM commission_sales WHERE tenant_id = ? AND external_id = ?`).get(tenantId, externalId) as any;
  if (!sale || sale.status === "REVERSED") return; // nothing to reverse — not an error
  transitionSale(tenantId, actorId, externalId, "REVERSE");
}

// Deterministic one-time backfill: every lead that is CURRENTLY sold becomes one
// QUALIFIED sale dated by its most recent sold knock. Idempotent (upsert by
// external id); leads without a rep/tenant are skipped, never guessed. Called
// from server startup after migrations.
export function backfillFieldSales(): { created: number; skipped: number } {
  let created = 0, skipped = 0;
  const soldLeads = rawDb.prepare(
    `SELECT l.id, l.tenant_id AS tenantId, l.assigned_rep_id AS assignedRepId,
            (SELECT k.knocked_at FROM knock_log k WHERE k.lead_id = l.id AND k.outcome = 'sold' ORDER BY k.knocked_at DESC LIMIT 1) AS soldAt,
            (SELECT k.rep_id FROM knock_log k WHERE k.lead_id = l.id AND k.outcome = 'sold' ORDER BY k.knocked_at DESC LIMIT 1) AS soldByRepId
     FROM leads l WHERE l.lead_status = 'sold'`
  ).all() as any[];
  for (const l of soldLeads) {
    const repId = l.soldByRepId ?? l.assignedRepId;
    if (!l.tenantId || !repId || !l.soldAt) { skipped++; continue; }
    const existing = rawDb.prepare(`SELECT id FROM commission_sales WHERE tenant_id = ? AND external_id = ?`).get(l.tenantId, fieldSaleExternalId(l.id));
    if (existing) { skipped++; continue; } // already in the ledger — never overwrite
    upsertSale(l.tenantId, null, {
      repId, externalId: fieldSaleExternalId(l.id), status: "QUALIFIED",
      soldAt: l.soldAt, qualifiedAt: l.soldAt, leadId: l.id,
    });
    created++;
  }
  if (created > 0) {
    storage.logActivity(null, "commission_sales.backfilled", "commission_sale", undefined, { created, skipped }, undefined);
    console.log(`[commission] Backfilled ${created} field sales into the weekly ledger (${skipped} skipped)`);
  }
  return { created, skipped };
}

// ════════════════════════════════════════════════════════════════════════════
// WEEK OVERVIEW — the manager/admin closeout read model. One call answers:
// production, projected payroll, tier proximity, payroll exposure, exceptions,
// and what's final. Live-computes OPEN weeks; never touches locked statements.
// ════════════════════════════════════════════════════════════════════════════

export interface WeekOverviewRepRow {
  repId: number; repName: string; active: boolean;
  statementId: number | null;
  status: string;                       // OPEN | REVIEW | FINALIZED | PAID | NO_PLAN
  qualifiedSaleCount: number;
  pendingSaleCount: number;
  reversedSaleCount: number;
  tierLabel: string | null;
  rateCents: number;
  grossCommissionCents: number;
  adjustmentCents: number;
  finalCommissionCents: number;
  structure: "FLAT" | "TIERED" | null;
  planAccepted: boolean;
  // Hourly block (hybrid hourly+commission): hours worked, the rate effective
  // at week start, and the hourly pay. rateCents null = commission-only rep.
  hours: number;
  hourlyMinutes: number;
  hourlyRateCents: number | null;
  hourlyPayCents: number;
  openClockSessions: number;
  // Tier-movement intelligence (tiered plans, open weeks only)
  salesUntilNextTier: number | null;
  nextTierRateCents: number | null;
  nextTierProjectedCommissionCents: number | null;
  marginalJumpCents: number | null;     // payroll delta if this rep reaches the next tier
  // Install-hold read model (additive): QUALIFIED sales this week currently
  // EXCLUDED from the statement by the install hold, with the earliest release
  // date (null = install never confirmed). Named installHold so it can never
  // be read as the chargeback-reserve "holdback" — a different concept.
  installHold: { saleCount: number; earliestPayableAfter: string | null };
}

export function getWeekOverview(tenantId: number, actorId: number | null, weekReference: Date | string | number, repIds: number[] | null): {
  bounds: WeekBounds; weekEnded: boolean; rows: WeekOverviewRepRow[];
  totals: { projectedPayrollCents: number; finalizedPayrollCents: number; paidPayrollCents: number; exposureCents: number; qualifiedSales: number; repsWithSales: number; installHoldSales: number };
  exceptions: Array<{ type: string; repId: number; repName: string; detail: string }>;
} {
  const config = loadOrgConfig(tenantId);
  const bounds = weekBoundsFor(weekReference, config);
  const weekEnded = Date.now() >= Date.parse(bounds.nextWeekStartUtc);

  // Reps in scope: tenant roster (optionally narrowed by caller's read scope).
  let reps = storage.getTeamMembers(tenantId).filter((m: any) => m.role !== "manager");
  if (repIds) reps = reps.filter((m: any) => repIds.includes(m.id));

  const rows: WeekOverviewRepRow[] = [];
  const exceptions: Array<{ type: string; repId: number; repName: string; detail: string }> = [];
  let projected = 0, finalized = 0, paid = 0, exposure = 0, qualifiedSales = 0, repsWithSales = 0;

  for (const rep of reps as any[]) {
    // Per-status sale counts for the week (basis column from org config).
    const basisCol = BASIS_COLUMN[config.qualificationBasis];
    const counts = rawDb.prepare(
      `SELECT status, COUNT(*) AS c FROM commission_sales
       WHERE tenant_id = ? AND rep_id = ?
         AND COALESCE(${basisCol}, sold_at) >= ? AND COALESCE(${basisCol}, sold_at) < ?
       GROUP BY status`
    ).all(tenantId, rep.id, bounds.weekStartUtc, bounds.nextWeekStartUtc) as any[];
    const byStatus: Record<string, number> = {};
    for (const c of counts) byStatus[c.status] = Number(c.c);

    const structure = getCurrentStructureForRep(tenantId, rep.id);
    const acceptedAt = structure?.acceptedAt ?? null;
    // Hourly block for the week (source-truthful: sessions + corrections, rate
    // effective at week start). Also drives the OPEN_CLOCK_SESSION exception.
    const hp = hourlyPayForWeek(tenantId, rep.id, bounds.weekStartUtc, bounds.nextWeekStartUtc);

    let row: WeekOverviewRepRow = {
      repId: rep.id, repName: rep.name, active: !!rep.active,
      statementId: null, status: "NO_PLAN",
      qualifiedSaleCount: byStatus["QUALIFIED"] ?? 0,
      pendingSaleCount: byStatus["PENDING"] ?? 0,
      reversedSaleCount: byStatus["REVERSED"] ?? 0,
      tierLabel: null, rateCents: 0, grossCommissionCents: 0,
      adjustmentCents: 0, finalCommissionCents: 0,
      structure: structure?.structure ?? null, planAccepted: !!acceptedAt,
      hours: hp.hours, hourlyMinutes: hp.minutes, hourlyRateCents: hp.rateCents,
      hourlyPayCents: hp.payCents, openClockSessions: hp.openSessionCount,
      salesUntilNextTier: null, nextTierRateCents: null,
      nextTierProjectedCommissionCents: null, marginalJumpCents: null,
      installHold: installHeldSalesForWeek(tenantId, rep.id, config.qualificationBasis, bounds),
    };

    // Auto-close rule: an ended week with a forgotten open clock-in can never
    // finalize truthfully — surface the named exception (mirrors the other
    // closeout blockers) so a manager closes the punch first.
    if (hp.weekEnded && hp.openSessionCount > 0) {
      exceptions.push({ type: "OPEN_CLOCK_SESSION", repId: rep.id, repName: rep.name,
        detail: `${hp.openSessionCount} open clock session(s) reach into this ended week — clock out (or correct the punch) before finalizing hourly pay.` });
    }
    // Set when NO plan governs this week (either the calc threw, or it took the
    // hourly-only path) — drives SALES_WITHOUT_PLAN from the LEDGER counts so
    // it also fires for hourly-only reps, whose statement calc no longer throws.
    let noPlanForWeek = false;

    try {
      const existing = rawDb.prepare(
        `SELECT * FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`
      ).get(tenantId, rep.id, bounds.weekStartUtc) as any;

      if (existing && (existing.status === "FINALIZED" || existing.status === "PAID")) {
        // Locked — read as stored, never recompute. The hourly block is frozen
        // with the statement (audit fidelity). A statement locked BEFORE the
        // hourly plane existed (hourly_minutes IS NULL) renders a zero/empty
        // block — NEVER the live read: backdating a rate before a frozen week
        // must not pay money the locked statement never had (CSV/overview
        // consume these fields).
        row = { ...row,
          statementId: existing.id, status: existing.status,
          qualifiedSaleCount: existing.qualified_sale_count,
          tierLabel: existing.tier_label, rateCents: existing.rate_cents,
          grossCommissionCents: existing.gross_commission_cents,
          adjustmentCents: existing.adjustment_cents,
          finalCommissionCents: existing.final_commission_cents,
          ...(existing.hourly_minutes != null ? {
            hours: Math.round((existing.hourly_minutes / 60) * 100) / 100,
            hourlyMinutes: existing.hourly_minutes,
            hourlyRateCents: existing.hourly_rate_cents ?? null,
            hourlyPayCents: existing.hourly_pay_cents ?? 0,
          } : {
            hours: 0, hourlyMinutes: 0, hourlyRateCents: null, hourlyPayCents: 0,
          }),
        };
        if (existing.status === "PAID") paid += existing.final_commission_cents;
        else finalized += existing.final_commission_cents;
        // Exception: a door was un-sold AFTER this week locked → money already
        // finalized against a reversed sale. Needs a manager adjustment.
        const lateReversals = rawDb.prepare(
          `SELECT COUNT(*) AS c FROM commission_sales
           WHERE tenant_id = ? AND rep_id = ? AND status = 'REVERSED'
             AND COALESCE(${basisCol}, sold_at) >= ? AND COALESCE(${basisCol}, sold_at) < ?
             AND reversed_at > ?`
        ).get(tenantId, rep.id, bounds.weekStartUtc, bounds.nextWeekStartUtc, existing.finalized_at ?? existing.updated_at) as any;
        if (Number(lateReversals?.c ?? 0) > 0) {
          exceptions.push({ type: "REVERSED_AFTER_FINALIZE", repId: rep.id, repName: rep.name,
            detail: `${lateReversals.c} sale(s) un-sold after the week was ${existing.status.toLowerCase()} — book a clawback adjustment.` });
        }
      } else {
        // Open (or missing) — live recompute so the console is always current.
        const out = calculateOrRecalculateStatement({ tenantId, repId: rep.id, weekReference: bounds.weekStartUtc, actorId, requestId: "week-overview" });
        const c = out.computation;
        noPlanForWeek = out.statement.commission_plan_version_id == null;
        row = { ...row,
          statementId: out.statement.id, status: out.statement.status,
          qualifiedSaleCount: c.qualifiedSaleCount, tierLabel: c.tierLabel,
          rateCents: c.rateCents, grossCommissionCents: c.grossCommissionCents,
          adjustmentCents: c.adjustmentCents, finalCommissionCents: c.finalCommissionCents,
          salesUntilNextTier: c.retro?.salesUntilNextTier ?? null,
          nextTierRateCents: c.retro?.nextTierRateCents ?? null,
          nextTierProjectedCommissionCents: c.retro?.nextTierProjectedCommissionCents ?? null,
          marginalJumpCents: c.retro?.nextTierProjectedCommissionCents != null
            ? c.retro.nextTierProjectedCommissionCents - c.grossCommissionCents : null,
        };
        projected += c.finalCommissionCents;
        // Payroll exposure: a rep who has ALREADY produced this week and is within
        // 2 sales of the next tier could jump payroll by the marginal amount.
        // Requires real production — a 0-sale rep "1 away from tier 1" is noise.
        if (c.qualifiedSaleCount > 0 && row.salesUntilNextTier != null && row.salesUntilNextTier <= 2 && row.marginalJumpCents != null && row.marginalJumpCents > 0) {
          exposure += row.marginalJumpCents;
        }
      }
    } catch (e) {
      if (e instanceof CommissionError && e.code === "NO_EFFECTIVE_PLAN_ASSIGNMENT") {
        noPlanForWeek = true; // no plan AND no hourly rate — exception below
      } else { throw e; }
    }

    if (noPlanForWeek && (row.qualifiedSaleCount + row.pendingSaleCount) > 0) {
      exceptions.push({ type: "SALES_WITHOUT_PLAN", repId: rep.id, repName: rep.name,
        detail: `${row.qualifiedSaleCount + row.pendingSaleCount} sale(s) this week but no commission plan assigned — these pay $0 until a plan is set.` });
    }

    if (structure && !acceptedAt && row.status !== "NO_PLAN") {
      exceptions.push({ type: "PLAN_NOT_ACCEPTED", repId: rep.id, repName: rep.name,
        detail: "Commission plan has not been accepted by the rep yet." });
    }
    qualifiedSales += row.qualifiedSaleCount;
    if (row.qualifiedSaleCount > 0) repsWithSales++;
    rows.push(row);
  }

  // Pending adjustments anywhere in this week are a closeout blocker worth seeing.
  const pendingAdj = rawDb.prepare(
    `SELECT a.rep_id AS repId, COUNT(*) AS c FROM commission_adjustments a
     JOIN commission_statements s ON s.id = a.statement_id
     WHERE a.tenant_id = ? AND a.status = 'PENDING' AND s.week_start_utc = ?
     GROUP BY a.rep_id`
  ).all(tenantId, bounds.weekStartUtc) as any[];
  for (const p of pendingAdj) {
    const rep = rows.find(r => r.repId === p.repId);
    exceptions.push({ type: "PENDING_ADJUSTMENT", repId: p.repId, repName: rep?.repName ?? `Rep ${p.repId}`,
      detail: `${p.c} pending adjustment(s) awaiting a decision.` });
  }

  rows.sort((a, b) => b.finalCommissionCents - a.finalCommissionCents || a.repName.localeCompare(b.repName));
  return {
    bounds, weekEnded, rows,
    totals: {
      projectedPayrollCents: projected, finalizedPayrollCents: finalized, paidPayrollCents: paid,
      exposureCents: exposure, qualifiedSales, repsWithSales,
      installHoldSales: rows.reduce((sum, row) => sum + row.installHold.saleCount, 0),
    },
    exceptions,
  };
}

// ── Batch closeout (the Sunday ritual) ───────────────────────────────────────
// Recalculates then finalizes every OPEN statement in the week; already-locked
// statements are skipped, never re-touched. Returns per-rep results so the UI
// can show exactly what happened. MARK_PAID is idempotent per statement.
export function batchTransitionWeek(tenantId: number, actorId: number | null, weekReference: Date | string | number, action: "FINALIZE" | "MARK_PAID", repIds?: number[] | null): {
  bounds: WeekBounds;
  results: Array<{ repId: number; statementId: number | null; result: string; finalCommissionCents?: number }>;
} {
  const config = loadOrgConfig(tenantId);
  const bounds = weekBoundsFor(weekReference, config);
  const basisCol = BASIS_COLUMN[config.qualificationBasis];
  const results: Array<{ repId: number; statementId: number | null; result: string; finalCommissionCents?: number }> = [];
  const blocked = new Set<number>();

  // FINALIZE first ensures a statement EXISTS for every in-scope rep with
  // qualified sales — a rep whose statement was never live-computed would
  // otherwise be silently skipped. A rep with sales but no plan is reported as
  // an explicit blocker (not finalized, not lost).
  if (action === "FINALIZE") {
    const salesByRep = rawDb.prepare(
      `SELECT rep_id AS repId, COUNT(*) AS c FROM commission_sales
       WHERE tenant_id = ? AND status = 'QUALIFIED'
         AND COALESCE(${basisCol}, sold_at) >= ? AND COALESCE(${basisCol}, sold_at) < ?
       GROUP BY rep_id`
    ).all(tenantId, bounds.weekStartUtc, bounds.nextWeekStartUtc) as any[];
    for (const s of salesByRep) {
      if (repIds && !repIds.includes(s.repId)) continue;
      try {
        calculateOrRecalculateStatement({ tenantId, repId: s.repId, weekReference: bounds.weekStartUtc, actorId, requestId: "batch-finalize-ensure" });
      } catch (e) {
        if (e instanceof CommissionError && e.code === "NO_EFFECTIVE_PLAN_ASSIGNMENT") {
          results.push({ repId: s.repId, statementId: null, result: `BLOCKED (${s.c} qualified sale(s), no plan assigned)` });
          blocked.add(s.repId);
        } else if (e instanceof CommissionError && e.code === "STATEMENT_LOCKED") {
          /* already locked — handled in the main loop below */
        } else { throw e; }
      }
    }
  }

  const stmts = rawDb.prepare(
    `SELECT * FROM commission_statements WHERE tenant_id = ? AND week_start_utc = ?`
  ).all(tenantId, bounds.weekStartUtc) as any[];

  for (const s of stmts) {
    if (repIds && !repIds.includes(s.rep_id)) continue;
    if (action === "FINALIZE") {
      if (s.status === "FINALIZED" || s.status === "PAID") { results.push({ repId: s.rep_id, statementId: s.id, result: `already ${s.status}` }); continue; }
      // Auto-close rule: a week is final only when it has ended AND no open
      // clock session remains. An open punch would freeze partial hourly pay,
      // so it BLOCKS finalize with a named exception (mirrors the week-overview
      // OPEN_CLOCK_SESSION exception) — commission-only reps are unaffected.
      const hp = hourlyPayForWeek(tenantId, s.rep_id, bounds.weekStartUtc, bounds.nextWeekStartUtc);
      if (hp.rateCents != null && hp.openSessionCount > 0) {
        results.push({ repId: s.rep_id, statementId: s.id, result: "BLOCKED (OPEN_CLOCK_SESSION: close the open clock session before finalizing hourly pay)" });
        continue;
      }
      // Recompute right before locking so the frozen number matches the ledger.
      const fresh = calculateOrRecalculateStatement({ tenantId, repId: s.rep_id, weekReference: bounds.weekStartUtc, actorId, requestId: "batch-finalize" });
      const locked = transitionStatement(tenantId, actorId, fresh.statement.id, "FINALIZE");
      results.push({ repId: s.rep_id, statementId: locked.id, result: "FINALIZED", finalCommissionCents: locked.final_commission_cents });
    } else {
      if (s.status === "PAID") { results.push({ repId: s.rep_id, statementId: s.id, result: "already PAID" }); continue; }
      if (s.status !== "FINALIZED") { results.push({ repId: s.rep_id, statementId: s.id, result: `skipped (${s.status} — finalize first)` }); continue; }
      const paid = transitionStatement(tenantId, actorId, s.id, "MARK_PAID");
      results.push({ repId: s.rep_id, statementId: paid.id, result: "PAID", finalCommissionCents: paid.final_commission_cents });
    }
  }

  storage.logActivity(actorId, `commission.week.${action.toLowerCase()}`, "commission_statement", undefined,
    { week: bounds.localWeekLabel, results: results.map(r => ({ repId: r.repId, result: r.result })) }, undefined);
  return { bounds, results };
}

// ── Plan acceptance (direct onboarding's handshake) ──────────────────────────
// The rep accepts their CURRENT effective assignment. The exact terms they saw
// are frozen into agreement_snapshot with a content hash — a later plan change
// creates a NEW assignment which needs a fresh acceptance.
export function acceptCurrentPlan(tenantId: number, repId: number, actorUserId: number | null, ip?: string | null): any {
  const current = getCurrentStructureForRep(tenantId, repId);
  // `structure: null` is the "no plan" shape (the reserve policy still rides
  // along on that object, so a falsy check on the object itself is not enough).
  if (!current?.structure) throw new CommissionError("NO_EFFECTIVE_PLAN_ASSIGNMENT", "No commission plan is assigned to you yet.");
  const existing = rawDb.prepare(`SELECT accepted_at FROM rep_commission_assignments WHERE id = ? AND tenant_id = ?`).get(current.assignmentId, tenantId) as any;
  if (existing?.accepted_at) return { alreadyAccepted: true, acceptedAt: existing.accepted_at };

  const terms = {
    structure: current.structure, planName: current.planName,
    flatRateCents: current.flatRateCents, tiers: current.tiers,
    effectiveFrom: current.effectiveFrom, weekBasis: "Monday–Sunday, org timezone",
  };
  const termsJson = JSON.stringify(terms);
  const hash = crypto.createHash("sha256").update(termsJson).digest("hex");
  const acceptedAt = new Date().toISOString();
  rawDb.prepare(
    `UPDATE rep_commission_assignments SET accepted_at = ?, agreement_snapshot = ? WHERE id = ? AND tenant_id = ?`
  ).run(acceptedAt, JSON.stringify({ terms, sha256: hash, acceptedAt, acceptedByUserId: actorUserId, ip: ip ?? null }), current.assignmentId, tenantId);
  storage.logActivity(actorUserId, "commission_plan.accepted", "rep_commission_assignment", current.assignmentId,
    { repId, sha256: hash }, ip ?? undefined);
  return { accepted: true, acceptedAt, sha256: hash };
}

// The sales behind a rep's week — the "what counts toward my pay" list.
export function listWeekSalesForRep(tenantId: number, repId: number, weekReference: Date | string | number): any[] {
  const config = loadOrgConfig(tenantId);
  const bounds = weekBoundsFor(weekReference, config);
  const basisCol = BASIS_COLUMN[config.qualificationBasis];
  const rows = rawDb.prepare(
    `SELECT cs.id, cs.external_id, cs.status, cs.sold_at, cs.qualified_at, cs.reversed_at,
            cs.lead_id, cs.house_amount_cents, l.address, l.city,
            (SELECT cm.status FROM commissions cm
              WHERE cm.tenant_id = cs.tenant_id AND cm.lead_id = cs.lead_id AND cm.rep_id = cs.rep_id
                AND cm.status != 'superseded'
              ORDER BY cm.id DESC LIMIT 1) AS cm_status,
            (SELECT cm.install_confirmed_at FROM commissions cm
              WHERE cm.tenant_id = cs.tenant_id AND cm.lead_id = cs.lead_id AND cm.rep_id = cs.rep_id
                AND cm.status != 'superseded'
              ORDER BY cm.id DESC LIMIT 1) AS cm_install_confirmed_at,
            (SELECT cm.payable_after FROM commissions cm
              WHERE cm.tenant_id = cs.tenant_id AND cm.lead_id = cs.lead_id AND cm.rep_id = cs.rep_id
                AND cm.status != 'superseded'
              ORDER BY cm.id DESC LIMIT 1) AS cm_payable_after
     FROM commission_sales cs LEFT JOIN leads l ON l.id = cs.lead_id
     WHERE cs.tenant_id = ? AND cs.rep_id = ?
       AND COALESCE(cs.${basisCol}, cs.sold_at) >= ? AND COALESCE(cs.${basisCol}, cs.sold_at) < ?
     ORDER BY COALESCE(cs.${basisCol}, cs.sold_at) DESC`
  ).all(tenantId, repId, bounds.weekStartUtc, bounds.nextWeekStartUtc) as any[];
  // Per-sale install-hold flag (same pure predicate the payable math uses) so
  // the rep-facing "what counts" list can show a held sale WITH its release
  // date instead of letting it vanish unexplained from the statement.
  const policy = getTenantPayPolicy(tenantId);
  return rows.map(row => {
    const linked = row.cm_status != null;
    const installHold = linked && isCommissionHeld(
      { status: row.cm_status, installConfirmedAt: row.cm_install_confirmed_at, payableAfter: row.cm_payable_after },
      policy,
    );
    const { cm_status, cm_install_confirmed_at, cm_payable_after, ...sale } = row;
    return { ...sale, installHold, payableAfter: installHold ? (row.cm_payable_after ?? null) : null };
  });
}

// ── Reserve (holdback) read model ─────────────────────────────────────────────
// Presentation-layer split of the AUTHORITATIVE final commission: the statement
// stays the source of truth for what's earned; this shows how that earned amount
// divides into the withheld reserve and the net paid this period. Consistent
// everywhere it's rendered (rep screen, admin view, API), so the split is a real
// payroll instruction, not a cosmetic overlay. Disabled tenants (percent 0) get
// an all-net holdback — the UI simply shows no reserve.
// When `repId` is given the split is PER-REP and CAP-AWARE: the rep's own
// percent/cap override (falling back to the org default) applied against their
// live ledger balance, so the number stops at the cap instead of over-holding.
// Omitting repId reproduces the original org-wide, uncapped split byte for byte
// — no existing caller changes behaviour.
export function holdbackForStatement(tenantId: number, finalCommissionCents: number, repId?: number): Holdback {
  const earnedCents = Math.trunc(finalCommissionCents || 0);
  if (repId == null) {
    return computeHoldback({ earnedCents, reservePercent: loadOrgConfig(tenantId).reservePercent });
  }
  const cfg = resolveRepReserveConfig(tenantId, repId);
  return computeHoldback({
    earnedCents,
    reservePercent: cfg.reservePercent,
    reserveCapCents: cfg.reserveCapCents,
    currentBalanceCents: getReserveBalanceCents(tenantId, repId),
  });
}

/** LEGACY per-statement rollup: what the current percent WOULD have withheld
 *  across a rep's settled weeks, plus the net paid against them.
 *
 *  This is a projection, NOT the balance. The authoritative balance — the only
 *  thing that knows about manual chargeback drawdowns and releases — is the
 *  append-only ledger (`reserveService.getReserveBalanceCents`, SQL SUM), which
 *  is what `/api/me/reserve` and the admin reserve view report. Kept because the
 *  weekly screen still shows netPaid/earnedToDate off the same statement fold
 *  its per-week splits come from.
 *
 *  ONLY settled weeks are folded. An OPEN week is live-recomputed on every knock,
 *  so including it made "held to date" and "net paid to date" drift upward in
 *  real time off money that has not been paid. FINALIZED/PAID weeks are frozen.
 */
export function getReserveLedgerForRep(tenantId: number, repId: number): ReserveLedger {
  const pct = resolveRepReserveConfig(tenantId, repId).reservePercent;
  const rows = rawDb.prepare(
    `SELECT final_commission_cents AS finalCents FROM commission_statements
      WHERE tenant_id = ? AND rep_id = ? AND status IN ('FINALIZED','PAID')`,
  ).all(tenantId, repId) as Array<{ finalCents: number }>;
  return rollupReserve(rows.map(r => Number(r.finalCents || 0)), pct);
}
