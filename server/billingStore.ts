// ── Billing store — the durable side of shared/billing.ts ─────────────────────
// Persists per-tenant billing state + an append-only lead-credit ledger, and runs
// the pure engine's decisions against SQLite. Provider-agnostic: a Stripe/manual
// adapter only ever calls setBillingState()/grantCredits()/setPlan() here.
//
// DARK BY DEFAULT: a tenant with NO tenant_billing row is never metered or gated.
// meterQualifiedLead()/billingGate() are no-ops for such tenants, so the live
// single-tenant portal is completely untouched until billing is provisioned.
import { rawDb } from "./db";
import {
  PLANS, type PlanKey, type BillingState, type OverageMode, type CreditState,
  canTransition, consumeCredit, creditsRemaining, usageFraction, usageLevel,
  resetCycle, portalAccess, isScanningAllowed,
} from "../shared/billing";

export interface BillingRow {
  tenantId: number;
  planKey: PlanKey;
  state: BillingState;
  cycleStart: string | null;
  cycleEnd: string | null;
  creditsIncluded: number;
  creditsUsed: number;
  creditsRollover: number;
  creditsPurchased: number;
  overageUsed: number;
  overageMode: OverageMode;
  unlimited: boolean;
  seatsPaid: number;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  provider: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(r: any): BillingRow | null {
  if (!r) return null;
  return {
    tenantId: r.tenant_id,
    planKey: r.plan_key,
    state: r.state,
    cycleStart: r.cycle_start,
    cycleEnd: r.cycle_end,
    creditsIncluded: r.credits_included,
    creditsUsed: r.credits_used,
    creditsRollover: r.credits_rollover,
    creditsPurchased: r.credits_purchased,
    overageUsed: r.overage_used,
    overageMode: r.overage_mode,
    unlimited: !!r.unlimited,
    seatsPaid: r.seats_paid,
    trialEndsAt: r.trial_ends_at,
    graceEndsAt: r.grace_ends_at,
    provider: r.provider,
    providerCustomerId: r.provider_customer_id,
    providerSubscriptionId: r.provider_subscription_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The billing row for a tenant, or null if billing isn't provisioned (dark). */
export function getBilling(tenantId: number): BillingRow | null {
  return mapRow(rawDb.prepare("SELECT * FROM tenant_billing WHERE tenant_id = ?").get(tenantId));
}

/** True when this tenant is under billing (metered + gate-able). */
export function isBillingEnabled(tenantId: number): boolean {
  return !!rawDb.prepare("SELECT 1 FROM tenant_billing WHERE tenant_id = ?").get(tenantId);
}

/** Map a DB row to the pure engine's CreditState. */
export function toCreditState(r: BillingRow): CreditState {
  return {
    planKey: r.planKey,
    state: r.state,
    included: r.creditsIncluded,
    used: r.creditsUsed,
    rollover: r.creditsRollover,
    purchased: r.creditsPurchased,
    overageUsed: r.overageUsed,
    overageMode: r.overageMode,
    unlimited: r.unlimited,
  };
}

export interface EnsureBillingOpts {
  planKey?: PlanKey;
  state?: BillingState;
  overageMode?: OverageMode;
  trialEndsAt?: string | null;
  provider?: string | null;
  /** ISO cycle start (defaults to caller-supplied "now" via the routes layer). */
  cycleStart?: string | null;
  cycleEnd?: string | null;
}

/**
 * Idempotently provision a tenant's billing row. If it already exists, returns it
 * unchanged. On create, seeds the plan's included credits (enterprise → unlimited).
 * This is the ONE switch that turns a tenant from dark → metered.
 */
export function ensureBilling(tenantId: number, opts: EnsureBillingOpts = {}): BillingRow {
  const existing = getBilling(tenantId);
  if (existing) return existing;
  const planKey = opts.planKey ?? "starter";
  const plan = PLANS[planKey];
  const unlimited = plan.monthlyCredits == null;
  const included = plan.monthlyCredits ?? 0;
  rawDb.prepare(
    `INSERT INTO tenant_billing
       (tenant_id, plan_key, state, cycle_start, cycle_end, credits_included, overage_mode,
        unlimited, seats_paid, trial_ends_at, provider, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
  ).run(
    tenantId, planKey, opts.state ?? "trial", opts.cycleStart ?? null, opts.cycleEnd ?? null,
    included, opts.overageMode ?? "stop", unlimited ? 1 : 0, plan.seats ?? 0,
    opts.trialEndsAt ?? null, opts.provider ?? null,
  );
  // Seed grant into the ledger for a clean audit trail.
  appendLedger(tenantId, included, "grant", { actor: "system:provision", balanceAfter: included });
  return getBilling(tenantId)!;
}

function appendLedger(
  tenantId: number, delta: number, reason: string,
  opts: { leadId?: number | null; overage?: boolean; balanceAfter?: number | null; dedupeKey?: string | null; actor?: string | null } = {},
): void {
  rawDb.prepare(
    `INSERT INTO lead_credit_ledger (tenant_id, delta, reason, lead_id, overage, balance_after, dedupe_key, actor)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    tenantId, delta, reason, opts.leadId ?? null, opts.overage ? 1 : 0,
    opts.balanceAfter ?? null, opts.dedupeKey ?? null, opts.actor ?? null,
  );
}

function persistCreditState(tenantId: number, next: CreditState): void {
  rawDb.prepare(
    `UPDATE tenant_billing
       SET credits_used = ?, credits_rollover = ?, credits_purchased = ?, overage_used = ?,
           updated_at = datetime('now')
     WHERE tenant_id = ?`
  ).run(next.used, next.rollover, next.purchased, next.overageUsed, tenantId);
}

export interface MeterResult {
  metered: boolean;        // was this tenant under billing at all?
  delivered: boolean;      // did a credit get consumed (lead delivered)?
  overage: boolean;
  requiresApproval: boolean;
  alreadyCounted: boolean; // idempotent replay — the lead was already charged
  remaining: number;
  level: ReturnType<typeof usageLevel>;
  reason?: string;
}

/**
 * Meter ONE lead credit for a delivered qualified opportunity — the core "credit
 * consumed only on delivery" rule. Idempotent per (tenant, lead): a retried write
 * with the same lead never double-charges. No-op (metered:false) when the tenant
 * has no billing row, so this is safe to call unconditionally from the lead path.
 *
 * Runs the whole check-and-consume inside a single better-sqlite3 transaction so
 * a concurrent request can't race two consumes past the last credit.
 */
export function meterQualifiedLead(tenantId: number, leadId: number, actor = "system:scan"): MeterResult {
  // Tenant-scoped so idempotency never depends on lead ids being globally unique.
  const dedupeKey = `consume:${tenantId}:lead:${leadId}`;
  const tx = rawDb.transaction((): MeterResult => {
    const row = getBilling(tenantId);
    if (!row) {
      return { metered: false, delivered: false, overage: false, requiresApproval: false, alreadyCounted: false, remaining: Infinity, level: "ok" };
    }
    // Idempotency: this lead already consumed a credit → report it, change nothing.
    const prior: any = rawDb.prepare("SELECT delta FROM lead_credit_ledger WHERE dedupe_key = ?").get(dedupeKey);
    if (prior) {
      const cs = toCreditState(row);
      return {
        metered: true, delivered: prior.delta < 0, overage: false, requiresApproval: false,
        alreadyCounted: true, remaining: creditsRemaining(cs), level: usageLevel(cs), reason: "already counted",
      };
    }
    const cs = toCreditState(row);
    const res = consumeCredit(cs);
    if (res.delivered) {
      persistCreditState(tenantId, res.next);
      const remaining = creditsRemaining(res.next);
      appendLedger(tenantId, -1, "lead_delivered", {
        leadId, overage: res.overage, balanceAfter: Number.isFinite(remaining) ? remaining : null,
        dedupeKey, actor,
      });
      return { metered: true, delivered: true, overage: res.overage, requiresApproval: false, alreadyCounted: false, remaining, level: usageLevel(res.next), reason: res.reason };
    }
    // Not delivered (stop / require_approval / non-delivering state). Record NO
    // consume row — nothing was charged. NOTE: metering here is ACCOUNTING, not a
    // delivery gate; the caller (scan write path) has already persisted the lead and
    // ignores this result. Withholding leads under `stop`/`require_approval` is a
    // future enforcement point at scan-dispatch, kept out of the hot write path for now.
    return {
      metered: true, delivered: false, overage: false, requiresApproval: res.requiresApproval,
      alreadyCounted: false, remaining: creditsRemaining(cs), level: usageLevel(cs), reason: res.reason,
    };
  });
  // IMMEDIATE takes the write lock up front so the read-then-write can't interleave
  // with another writer process. (Within one process better-sqlite3 is synchronous,
  // so this is only belt-and-suspenders — but it makes multi-process safe too.)
  return tx.immediate();
}

/** Transition billing state through the validated state machine. */
export function setBillingState(tenantId: number, to: BillingState, actor = "system"): { ok: boolean; state: BillingState; reason?: string } {
  const row = getBilling(tenantId);
  if (!row) return { ok: false, state: "canceled", reason: "no billing row" };
  if (!canTransition(row.state, to)) return { ok: false, state: row.state, reason: `illegal transition ${row.state} → ${to}` };
  rawDb.prepare("UPDATE tenant_billing SET state = ?, updated_at = datetime('now') WHERE tenant_id = ?").run(to, tenantId);
  appendLedger(tenantId, 0, "state_change", { actor: `${actor}:${row.state}->${to}` });
  return { ok: true, state: to };
}

/** Change plan: swaps included allowance to the new plan's (does not reset usage). */
export function setPlan(tenantId: number, planKey: PlanKey, actor = "system"): BillingRow | null {
  const row = getBilling(tenantId);
  if (!row) return null;
  const plan = PLANS[planKey];
  const unlimited = plan.monthlyCredits == null;
  rawDb.prepare(
    "UPDATE tenant_billing SET plan_key = ?, credits_included = ?, unlimited = ?, seats_paid = ?, updated_at = datetime('now') WHERE tenant_id = ?"
  ).run(planKey, plan.monthlyCredits ?? 0, unlimited ? 1 : 0, plan.seats ?? row.seatsPaid, tenantId);
  appendLedger(tenantId, 0, "plan_change", { actor: `${actor}:${row.planKey}->${planKey}` });
  return getBilling(tenantId);
}

/** Grant or purchase extra credits (adapter/admin). Positive amount. */
export function grantCredits(tenantId: number, amount: number, reason: "grant" | "purchase" | "adjustment" = "grant", actor = "system"): BillingRow | null {
  const row = getBilling(tenantId);
  if (!row || amount <= 0) return row;
  rawDb.prepare("UPDATE tenant_billing SET credits_purchased = credits_purchased + ?, updated_at = datetime('now') WHERE tenant_id = ?").run(amount, tenantId);
  const after = getBilling(tenantId)!;
  appendLedger(tenantId, amount, reason, { actor, balanceAfter: creditsRemaining(toCreditState(after)) });
  return after;
}

/** Start a fresh billing cycle (called by the adapter on invoice.paid / renewal). */
export function resetBillingCycle(tenantId: number, allowRollover: boolean, cycleStart: string, cycleEnd: string, actor = "system"): BillingRow | null {
  const row = getBilling(tenantId);
  if (!row) return null;
  const next = resetCycle(toCreditState(row), allowRollover);
  rawDb.prepare(
    `UPDATE tenant_billing
       SET credits_included = ?, credits_used = 0, credits_purchased = 0, overage_used = 0,
           credits_rollover = ?, cycle_start = ?, cycle_end = ?, updated_at = datetime('now')
     WHERE tenant_id = ?`
  ).run(next.included, next.rollover, cycleStart, cycleEnd, tenantId);
  const after = getBilling(tenantId)!;
  appendLedger(tenantId, next.included, "cycle_reset", { actor, balanceAfter: creditsRemaining(toCreditState(after)) });
  return after;
}

export interface BillingSummary {
  enabled: boolean;
  planKey: PlanKey | null;
  planName: string | null;
  state: BillingState | null;
  access: "full" | "paywall" | "blocked";
  scanningAllowed: boolean;
  unlimited: boolean;
  creditsIncluded: number;
  creditsRemaining: number | null; // null = unlimited
  creditsUsed: number;
  overageUsed: number;
  usagePct: number;
  level: ReturnType<typeof usageLevel>;
  overageMode: OverageMode | null;
  seatsPaid: number;
  trialEndsAt: string | null;
  cycleEnd: string | null;
}

/** UI/API-facing snapshot. When billing is dark, returns enabled:false + full access. */
export function billingSummary(tenantId: number): BillingSummary {
  const row = getBilling(tenantId);
  if (!row) {
    return {
      enabled: false, planKey: null, planName: null, state: null, access: "full", scanningAllowed: true,
      unlimited: false, creditsIncluded: 0, creditsRemaining: null, creditsUsed: 0, overageUsed: 0,
      usagePct: 0, level: "ok", overageMode: null, seatsPaid: 0, trialEndsAt: null, cycleEnd: null,
    };
  }
  const cs = toCreditState(row);
  const remaining = creditsRemaining(cs);
  return {
    enabled: true,
    planKey: row.planKey,
    planName: PLANS[row.planKey]?.name ?? row.planKey,
    state: row.state,
    access: portalAccess(row.state),
    scanningAllowed: isScanningAllowed(row.state),
    unlimited: row.unlimited,
    creditsIncluded: row.creditsIncluded,
    creditsRemaining: Number.isFinite(remaining) ? remaining : null,
    creditsUsed: row.creditsUsed,
    overageUsed: row.overageUsed,
    usagePct: Math.round(usageFraction(cs) * 100),
    level: usageLevel(cs),
    overageMode: row.overageMode,
    seatsPaid: row.seatsPaid,
    trialEndsAt: row.trialEndsAt,
    cycleEnd: row.cycleEnd,
  };
}

export interface BillingGate {
  allowed: boolean;                 // may the tenant use the portal at all?
  access: "full" | "paywall" | "blocked";
  scanningAllowed: boolean;         // may the tenant spend proxy / receive leads?
  reason?: string;
}

/** Access decision for middleware/routes. Dark tenants always get full access. */
export function billingGate(tenantId: number): BillingGate {
  const row = getBilling(tenantId);
  if (!row) return { allowed: true, access: "full", scanningAllowed: true };
  const access = portalAccess(row.state);
  return {
    allowed: access !== "blocked",
    access,
    scanningAllowed: isScanningAllowed(row.state),
    reason: access === "full" ? undefined : `billing state ${row.state}`,
  };
}

/** Recent ledger events for the billing/usage UI. */
export function getCreditLedger(tenantId: number, limit = 50): any[] {
  return rawDb.prepare(
    "SELECT id, delta, reason, lead_id AS leadId, overage, balance_after AS balanceAfter, actor, at FROM lead_credit_ledger WHERE tenant_id = ? ORDER BY at DESC, id DESC LIMIT ?"
  ).all(tenantId, limit);
}
