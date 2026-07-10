// ── Weekly Commission service — persistence + calculation orchestration ───────
// Wires the PURE domain modules (shared/workweek.ts, shared/commissionTiers.ts)
// to persisted data. All money is integer cents; the server is authoritative
// (never trusts a client-supplied count/rate/total/week). Tenant-scoped: every
// query carries tenant_id AND we verify referenced rows share the tenant.
// Deliberately isolated from the legacy commissions/commissionRates + any MLM.

import { rawDb } from "./db";
import { storage } from "./storage";
import { weekBoundsFor, type WorkweekConfig, DEFAULT_WORKWEEK, type WeekBounds } from "@shared/workweek";
import {
  validateTiers, calculateRetroactiveCommission, calculateFlatCommission,
  type CommissionTier, type RetroResult, DEFAULT_RETRO_TIERS,
} from "@shared/commissionTiers";

// ── Typed domain errors ───────────────────────────────────────────────────────
export type CommissionErrorCode =
  | "INVALID_TIMEZONE" | "INVALID_COMMISSION_PLAN" | "INVALID_TIER_CONFIGURATION"
  | "UNSUPPORTED_TIER_MODE" | "NO_EFFECTIVE_PLAN_ASSIGNMENT" | "OVERLAPPING_PLAN_ASSIGNMENT"
  | "STATEMENT_LOCKED" | "DUPLICATE_SALE" | "CROSS_TENANT_ACCESS"
  | "UNAUTHORIZED_COMMISSION_ACTION" | "INVALID_WORKWEEK" | "INVALID_ADJUSTMENT"
  | "CONCURRENT_STATEMENT_UPDATE";

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
            commission_auto_finalize_enabled AS autoFinalizeEnabled
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
function countQualifiedSales(tenantId: number, repId: number, basis: QualificationBasis, bounds: WeekBounds): number {
  const col = BASIS_COLUMN[basis];
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS c FROM commission_sales
     WHERE tenant_id = ? AND rep_id = ? AND status = 'QUALIFIED'
       AND ${col} IS NOT NULL AND ${col} >= ? AND ${col} < ?`
  ).get(tenantId, repId, bounds.weekStartUtc, bounds.nextWeekStartUtc) as any;
  return Number(row?.c ?? 0);
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

  // Resolve the plan version effective for this week (tenant-scoped).
  const assignments = rawDb.prepare(
    `SELECT id, commission_plan_version_id AS commissionPlanVersionId, effective_from AS effectiveFrom, effective_to AS effectiveTo
     FROM rep_commission_assignments WHERE tenant_id = ? AND rep_id = ? ORDER BY effective_from DESC`
  ).all(tenantId, repId) as AssignmentRow[];
  const assignment = resolveAssignmentForWeek(assignments, bounds.weekStartUtc, bounds.nextWeekStartUtc);
  if (!assignment) throw new CommissionError("NO_EFFECTIVE_PLAN_ASSIGNMENT",
    `No commission plan assigned to rep ${repId} for week ${bounds.localWeekLabel}.`);

  const version = rawDb.prepare(
    `SELECT * FROM commission_plan_versions WHERE id = ? AND tenant_id = ?`
  ).get(assignment.commissionPlanVersionId, tenantId) as any;
  if (!version) throw new CommissionError("CROSS_TENANT_ACCESS", "Plan version not found in tenant.", 404);
  const plan = rawDb.prepare(`SELECT * FROM commission_plans WHERE id = ? AND tenant_id = ?`).get(version.commission_plan_id, tenantId) as any;
  if (!plan) throw new CommissionError("INVALID_COMMISSION_PLAN", "Plan not found in tenant.", 404);

  const tiers = plan.type === "TIERED" ? loadTiers(tenantId, version.id) : [];
  const basis = (version.qualification_basis || config.qualificationBasis) as QualificationBasis;
  const qualifiedSaleCount = countQualifiedSales(tenantId, repId, basis, bounds);
  const approvedAdjustmentCents = existing ? sumApprovedAdjustments(tenantId, existing.id) : 0;

  const comp = computeStatement({
    planType: plan.type, tierMode: plan.tier_mode, flatRateCents: version.flat_rate_cents,
    tiers, qualifiedSaleCount, approvedAdjustmentCents,
  });

  const planSnapshot = JSON.stringify({
    planId: plan.id, versionNumber: version.version_number, type: plan.type, tierMode: plan.tier_mode,
    flatRateCents: version.flat_rate_cents, currency: plan.currency,
    tiers: tiers.map(t => ({ minimumSales: t.minimumSales, maximumSales: t.maximumSales, rateCents: t.rateCents, label: t.label })),
    qualificationBasis: basis,
  });
  const now = new Date().toISOString();

  // Transactional upsert — the unique (tenant,rep,week) index + synchronous
  // better-sqlite3 make duplicate creation impossible under concurrency.
  const tx = rawDb.transaction(() => {
    rawDb.prepare(
      `INSERT INTO commission_statements
        (tenant_id, rep_id, week_start_utc, next_week_start_utc, timezone, local_week_label, qualification_basis,
         commission_plan_id, commission_plan_version_id, plan_version_number, plan_snapshot,
         qualified_sale_count, tier_id, tier_label, rate_cents, gross_commission_cents, adjustment_cents,
         final_commission_cents, calculation_version, status, calculated_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,1,'OPEN',?,?,?)
       ON CONFLICT(tenant_id, rep_id, week_start_utc) DO UPDATE SET
         qualified_sale_count = excluded.qualified_sale_count,
         tier_id = excluded.tier_id, tier_label = excluded.tier_label, rate_cents = excluded.rate_cents,
         gross_commission_cents = excluded.gross_commission_cents,
         adjustment_cents = excluded.adjustment_cents,
         final_commission_cents = excluded.final_commission_cents,
         plan_snapshot = excluded.plan_snapshot,
         commission_plan_id = excluded.commission_plan_id,
         commission_plan_version_id = excluded.commission_plan_version_id,
         plan_version_number = excluded.plan_version_number,
         calculation_version = commission_statements.calculation_version + 1,
         calculated_at = excluded.calculated_at, updated_at = excluded.updated_at`
    ).run(
      tenantId, repId, bounds.weekStartUtc, bounds.nextWeekStartUtc, bounds.timezone, bounds.localWeekLabel, basis,
      plan.id, version.id, version.version_number, planSnapshot,
      comp.qualifiedSaleCount, comp.tierId as any, comp.tierLabel, comp.rateCents, comp.grossCommissionCents, comp.adjustmentCents,
      comp.finalCommissionCents, now, now, now,
    );
  });
  tx();

  const statement = rawDb.prepare(
    `SELECT * FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`
  ).get(tenantId, repId, bounds.weekStartUtc);

  storage.logActivity(actorId, existing ? "commission.statement.recalculated" : "commission.statement.created",
    "commission_statement", (statement as any).id,
    { requestId: input.requestId ?? null, repId, week: bounds.localWeekLabel, qualifiedSaleCount: comp.qualifiedSaleCount, finalCommissionCents: comp.finalCommissionCents }, undefined);

  return { statement, computation: comp, bounds };
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

// Append an adjustment (PENDING). Never zero. Only APPROVED ones feed a statement.
export function createAdjustment(tenantId: number, actorId: number | null, input: {
  statementId: number; amountCents: number; type?: string; reason: string; relatedSaleId?: number | null;
}): any {
  const stmt = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ? AND tenant_id = ?`).get(input.statementId, tenantId) as any;
  if (!stmt) throw new CommissionError("CROSS_TENANT_ACCESS", "Statement not found in tenant.", 404);
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) throw new CommissionError("INVALID_ADJUSTMENT", "amountCents must be a non-zero integer.");
  if (!input.reason || !input.reason.trim()) throw new CommissionError("INVALID_ADJUSTMENT", "A reason is required.");
  const info = rawDb.prepare(
    `INSERT INTO commission_adjustments (tenant_id, statement_id, rep_id, amount_cents, type, reason, related_sale_id, status, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,'PENDING',?,?)`
  ).run(tenantId, input.statementId, stmt.rep_id, input.amountCents, input.type || "MANUAL", input.reason.trim(), input.relatedSaleId ?? null, actorId, nowIso());
  storage.logActivity(actorId, "commission_adjustment.created", "commission_adjustment", Number(info.lastInsertRowid), { statementId: input.statementId, amountCents: input.amountCents, type: input.type || "MANUAL" }, undefined);
  return rawDb.prepare(`SELECT * FROM commission_adjustments WHERE id = ?`).get(info.lastInsertRowid);
}

// Approve/reject an adjustment. Approval recalculates the statement so
// finalCommissionCents = gross + Σ(approved adjustments) stays invariant.
export function decideAdjustment(tenantId: number, actorId: number | null, adjustmentId: number, decision: "APPROVE" | "REJECT"): any {
  const adj = rawDb.prepare(`SELECT * FROM commission_adjustments WHERE id = ? AND tenant_id = ?`).get(adjustmentId, tenantId) as any;
  if (!adj) throw new CommissionError("CROSS_TENANT_ACCESS", "Adjustment not found in tenant.", 404);
  if (adj.status !== "PENDING") throw new CommissionError("INVALID_ADJUSTMENT", `Adjustment already ${adj.status}.`, 409);
  const stmt = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ? AND tenant_id = ?`).get(adj.statement_id, tenantId) as any;
  if (stmt && (stmt.status === "PAID")) throw new CommissionError("STATEMENT_LOCKED", "Statement is PAID; adjustments cannot change it.", 409);
  const now = nowIso();
  if (decision === "APPROVE") {
    rawDb.prepare(`UPDATE commission_adjustments SET status='APPROVED', approved_by=?, approved_at=? WHERE id=?`).run(actorId, now, adjustmentId);
  } else {
    rawDb.prepare(`UPDATE commission_adjustments SET status='REJECTED', rejected_by=?, rejected_at=? WHERE id=?`).run(actorId, now, adjustmentId);
  }
  storage.logActivity(actorId, `commission_adjustment.${decision.toLowerCase()}d`, "commission_adjustment", adjustmentId, { statementId: adj.statement_id, amountCents: adj.amount_cents }, undefined);

  let statement = stmt;
  if (decision === "APPROVE" && stmt) {
    try {
      statement = calculateOrRecalculateStatement({ tenantId, repId: stmt.rep_id, weekReference: stmt.week_start_utc, actorId, requestId: `adjustment:${adjustmentId}:approve` }).statement;
    } catch (e) {
      if (!(e instanceof CommissionError && e.code === "STATEMENT_LOCKED")) throw e;
    }
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

// Finalize / mark-paid transitions (immutability gate lives here).
export function transitionStatement(tenantId: number, actorId: number | null, statementId: number, action: "FINALIZE" | "REOPEN" | "MARK_PAID"): any {
  const stmt = rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ? AND tenant_id = ?`).get(statementId, tenantId) as any;
  if (!stmt) throw new CommissionError("CROSS_TENANT_ACCESS", "Statement not found in tenant.", 404);
  const now = nowIso();
  if (action === "FINALIZE") {
    if (stmt.status === "PAID") throw new CommissionError("STATEMENT_LOCKED", "Paid statements cannot be re-finalized.", 409);
    rawDb.prepare(`UPDATE commission_statements SET status='FINALIZED', finalized_at=?, finalized_by=?, updated_at=? WHERE id=?`).run(now, actorId, now, statementId);
  } else if (action === "REOPEN") {
    if (stmt.status === "PAID") throw new CommissionError("STATEMENT_LOCKED", "Paid statements cannot be reopened.", 409);
    rawDb.prepare(`UPDATE commission_statements SET status='OPEN', finalized_at=NULL, finalized_by=NULL, updated_at=? WHERE id=?`).run(now, statementId);
  } else {
    if (stmt.status !== "FINALIZED") throw new CommissionError("STATEMENT_LOCKED", "Only FINALIZED statements can be marked PAID.", 409);
    rawDb.prepare(`UPDATE commission_statements SET status='PAID', paid_at=?, paid_by=?, updated_at=? WHERE id=?`).run(now, actorId, now, statementId);
  }
  storage.logActivity(actorId, `commission.statement.${action.toLowerCase()}`, "commission_statement", statementId, { from: stmt.status }, undefined);
  return rawDb.prepare(`SELECT * FROM commission_statements WHERE id = ?`).get(statementId);
}

// ── Org config read/update ────────────────────────────────────────────────────
export function updateOrgConfig(tenantId: number, actorId: number | null, patch: Partial<{
  commissionTimezone: string; commissionWeekStartsOn: number; commissionWeekStartLocalTime: string;
  commissionQualificationBasis: QualificationBasis; commissionFinalizationDelayHours: number;
  commissionCorrectionWindowDays: number; commissionAutoFinalizeEnabled: boolean;
}>): OrgCommissionConfig {
  if (patch.commissionTimezone != null && !isValidTimezone(patch.commissionTimezone)) {
    throw new CommissionError("INVALID_TIMEZONE", `Unsupported timezone: ${patch.commissionTimezone}`);
  }
  if (patch.commissionQualificationBasis != null && !BASIS_COLUMN[patch.commissionQualificationBasis]) {
    throw new CommissionError("INVALID_WORKWEEK", `Unsupported qualification basis: ${patch.commissionQualificationBasis}`);
  }
  const sets: string[] = []; const params: any[] = [];
  const map: Record<string, string> = {
    commissionTimezone: "commission_timezone", commissionWeekStartsOn: "commission_week_starts_on",
    commissionWeekStartLocalTime: "commission_week_start_local_time", commissionQualificationBasis: "commission_qualification_basis",
    commissionFinalizationDelayHours: "commission_finalization_delay_hours", commissionCorrectionWindowDays: "commission_correction_window_days",
    commissionAutoFinalizeEnabled: "commission_auto_finalize_enabled",
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
const today = () => new Date().toISOString().slice(0, 10);

export type CommissionStructure = "FLAT" | "TIERED";

// The tenant's canonical retroactive-weekly tiered plan (default tiers), created
// + activated on first use. Idempotent — reused thereafter.
export function getOrCreateStandardTieredVersion(tenantId: number, actorId: number | null): { planId: number; versionId: number } {
  let plan = rawDb.prepare(`SELECT * FROM commission_plans WHERE tenant_id = ? AND type = 'TIERED' AND name = ? ORDER BY id ASC LIMIT 1`).get(tenantId, STANDARD_TIERED_PLAN_NAME) as any;
  if (!plan) plan = createPlan(tenantId, actorId, { name: STANDARD_TIERED_PLAN_NAME, type: "TIERED", tierMode: "RETROACTIVE_WEEKLY", description: "Default retroactive weekly tiers (1–7 $150, 8–12 $200, 13–16 $250, 17+ $300)." });
  let version = rawDb.prepare(`SELECT * FROM commission_plan_versions WHERE tenant_id = ? AND commission_plan_id = ? ORDER BY version_number DESC LIMIT 1`).get(tenantId, plan.id) as any;
  if (!version) version = addPlanVersion(tenantId, actorId, plan.id, { effectiveFrom: today(), qualificationBasis: "QUALIFIED_AT", tiers: DEFAULT_RETRO_TIERS });
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
  if (!version) version = addPlanVersion(tenantId, actorId, plan.id, { effectiveFrom: today(), flatRateCents, qualificationBasis: "QUALIFIED_AT" });
  if (plan.status !== "ACTIVE") activatePlan(tenantId, actorId, plan.id);
  return { planId: plan.id, versionId: version.id };
}

// Assign a FLAT or TIERED structure to a rep. `closeExisting` ends any current
// open assignment at effectiveFrom (half-open) so re-assigning a rep's structure
// never trips the overlap guard — this is how "change a rep's commission" works.
export function assignStructureToRep(tenantId: number, actorId: number | null, input: {
  repId: number; structure: CommissionStructure; flatRateCents?: number | null;
  commissionPlanVersionId?: number | null; effectiveFrom?: string; closeExisting?: boolean;
}): { assignment: any; versionId: number; structure: CommissionStructure } {
  const rep = storage.getTeamMemberById(input.repId);
  if (!rep || rep.tenantId !== tenantId) throw new CommissionError("CROSS_TENANT_ACCESS", "Rep not found in tenant.", 404);
  const effectiveFrom = input.effectiveFrom || today();

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
  } else {
    versionId = getOrCreateStandardTieredVersion(tenantId, actorId).versionId;
  }

  if (input.closeExisting) {
    const open = rawDb.prepare(`SELECT id FROM rep_commission_assignments WHERE tenant_id = ? AND rep_id = ? AND (effective_to IS NULL OR effective_to > ?)`).all(tenantId, input.repId, effectiveFrom) as any[];
    for (const a of open) rawDb.prepare(`UPDATE rep_commission_assignments SET effective_to = ? WHERE id = ?`).run(effectiveFrom, a.id);
  }

  const assignment = assignPlanVersionToRep(tenantId, actorId, { repId: input.repId, commissionPlanVersionId: versionId, effectiveFrom });
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
  const active = resolveAssignmentForWeek(assignments, new Date().toISOString());
  if (!active) return null;
  const version = rawDb.prepare(`SELECT v.*, p.name AS plan_name, p.type AS plan_type, p.tier_mode FROM commission_plan_versions v JOIN commission_plans p ON p.id = v.commission_plan_id WHERE v.id = ? AND v.tenant_id = ?`).get(active.commissionPlanVersionId, tenantId) as any;
  if (!version) return null;
  const tiers = version.plan_type === "TIERED" ? getPlanVersionTiers(tenantId, version.id) : [];
  return {
    assignmentId: active.id, effectiveFrom: active.effectiveFrom, effectiveTo: active.effectiveTo,
    structure: version.plan_type === "FLAT" ? "FLAT" : "TIERED",
    planName: version.plan_name, planId: version.commission_plan_id, commissionPlanVersionId: version.id,
    flatRateCents: version.flat_rate_cents,
    tiers: tiers.map((t: any) => ({ minimumSales: t.minimum_sales, maximumSales: t.maximum_sales, rateCents: t.rate_cents, label: t.label })),
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
