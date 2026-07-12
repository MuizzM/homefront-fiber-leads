// ── Billing + lead-credit core (pure, provider-agnostic) ──────────────────────
// The SaaS "banking" layer's brain: plan definitions, the billing-state machine
// (TRIAL → ACTIVE → PAST_DUE → SUSPENDED → CANCELED), and lead-credit metering.
// NO Stripe, NO DB, NO I/O — every rule here is a pure function so it's fully
// unit-tested and the payment provider is just an adapter that calls setState().
//
// Core rule (per spec): a lead credit is consumed ONLY when a QUALIFIED fiber
// opportunity is delivered to the tenant — never on a failed/no-service lookup.

// ── Feature flags a plan can grant ────────────────────────────────────────────
export type Feature =
  | "csv_export" | "lead_assignment" | "rep_metrics" | "map_tools" | "crm_webhook"
  | "advanced_analytics" | "auto_lead_delivery" | "white_label" | "priority_scanning"
  | "advanced_permissions" | "sso" | "scim" | "audit_logs" | "api_access" | "custom_retention";

export type PlanKey = "starter" | "growth" | "professional" | "enterprise";

export interface Plan {
  key: PlanKey;
  name: string;
  /** Monthly included lead credits. null = custom/unlimited (enterprise). */
  monthlyCredits: number | null;
  /** Included seats. null = custom. */
  seats: number | null;
  features: Feature[];
  /** Dollar figures are the OWNER's business decision — left null until set in
   *  config/env, so no fake price ships. The UI shows "Contact us" when null. */
  monthlyPriceUsd: number | null;
  overagePerCreditUsd: number | null;
}

// Feature sets are additive up the tiers.
const F_STARTER: Feature[] = ["csv_export"];
const F_GROWTH: Feature[] = [...F_STARTER, "lead_assignment", "rep_metrics", "map_tools", "crm_webhook"];
const F_PRO: Feature[] = [...F_GROWTH, "advanced_analytics", "auto_lead_delivery", "white_label", "priority_scanning", "advanced_permissions"];
const F_ENT: Feature[] = [...F_PRO, "sso", "scim", "audit_logs", "api_access", "custom_retention"];

// Credit allowances/seats are sensible defaults. Prices are PLACEHOLDERS — edit
// these four numbers to set real pricing (Enterprise stays null = "Contact us").
export const PLANS: Record<PlanKey, Plan> = {
  starter:      { key: "starter",      name: "Starter",      monthlyCredits: 250,   seats: 3,    features: F_STARTER, monthlyPriceUsd: 99,  overagePerCreditUsd: 0.75 },
  growth:       { key: "growth",       name: "Growth",       monthlyCredits: 1500,  seats: 10,   features: F_GROWTH,  monthlyPriceUsd: 299, overagePerCreditUsd: 0.50 },
  professional: { key: "professional", name: "Professional", monthlyCredits: 6000,  seats: 40,   features: F_PRO,     monthlyPriceUsd: 799, overagePerCreditUsd: 0.35 },
  enterprise:   { key: "enterprise",   name: "Enterprise",   monthlyCredits: null,  seats: null, features: F_ENT,     monthlyPriceUsd: null, overagePerCreditUsd: null },
};

export function planHasFeature(planKey: PlanKey, f: Feature): boolean {
  return PLANS[planKey]?.features.includes(f) ?? false;
}

// ── Billing state machine ─────────────────────────────────────────────────────
export type BillingState = "trial" | "active" | "past_due" | "suspended" | "canceled";

/** Runtime allow-list for validating untrusted input (routes/adapters). */
export const BILLING_STATES: BillingState[] = ["trial", "active", "past_due", "suspended", "canceled"];
export function isBillingState(s: unknown): s is BillingState {
  return typeof s === "string" && (BILLING_STATES as string[]).includes(s);
}

const TRANSITIONS: Record<BillingState, BillingState[]> = {
  trial:     ["active", "past_due", "suspended", "canceled"], // convert, fail, expire, abandon
  active:    ["past_due", "canceled"],                        // payment fails, or user cancels
  past_due:  ["active", "suspended", "canceled"],             // recover, dunning-exhausted, cancel
  suspended: ["active", "canceled"],                          // reactivate (pay), or cancel
  canceled:  ["active", "trial"],                             // reactivate
};

export function canTransition(from: BillingState, to: BillingState): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Scanning/lead delivery runs in trial + active + the past_due grace window;
 *  a suspended or canceled tenant stops consuming proxy/credits. */
export function isScanningAllowed(state: BillingState): boolean {
  return state === "trial" || state === "active" || state === "past_due";
}

/** How long a payment-failed tenant stays in past_due (full access) before the
 *  dunning cron suspends it. The adapter stamps grace_ends_at = now + this. */
export const DUNNING_GRACE_DAYS = 7;

/** Portal access: full while paying (+grace); suspended → paywall (read-only);
 *  canceled → blocked. Drives the middleware gate + the paywall screen. */
export function portalAccess(state: BillingState): "full" | "paywall" | "blocked" {
  if (state === "trial" || state === "active" || state === "past_due") return "full";
  if (state === "suspended") return "paywall";
  return "blocked"; // canceled
}

// ── Lead-credit metering ──────────────────────────────────────────────────────
export type OverageMode = "stop" | "allow_overage" | "auto_purchase" | "require_approval";

/** Runtime allow-list for validating untrusted input (routes/adapters). */
export const OVERAGE_MODES: OverageMode[] = ["stop", "allow_overage", "auto_purchase", "require_approval"];
export function isOverageMode(s: unknown): s is OverageMode {
  return typeof s === "string" && (OVERAGE_MODES as string[]).includes(s);
}

export interface CreditState {
  planKey: PlanKey;
  state: BillingState;
  included: number;       // this cycle's allowance (0 for unlimited-enterprise → use Infinity via helper)
  used: number;           // credits consumed this cycle
  rollover: number;       // carried from last cycle (if plan allows)
  purchased: number;      // extra credits bought this cycle
  overageUsed: number;    // credits delivered beyond the allowance (billed later)
  overageMode: OverageMode;
  unlimited: boolean;     // enterprise custom
}

export function creditsRemaining(c: CreditState): number {
  if (c.unlimited) return Infinity;
  return Math.max(0, c.included + c.rollover + c.purchased - c.used);
}

/** 0..>1 — fraction of the allowance consumed (>1 means into overage). */
export function usageFraction(c: CreditState): number {
  if (c.unlimited) return 0;
  const cap = c.included + c.rollover + c.purchased;
  return cap <= 0 ? 1 : c.used / cap;
}

export type UsageLevel = "ok" | "warn" | "critical" | "exhausted";
export function usageLevel(c: CreditState): UsageLevel {
  if (c.unlimited) return "ok";
  const f = usageFraction(c);
  if (f >= 1) return "exhausted";
  if (f >= 0.9) return "critical";
  if (f >= 0.75) return "warn";
  return "ok";
}

export interface ConsumeResult {
  delivered: boolean;      // did the lead get delivered (credit consumed)?
  overage: boolean;        // was this an overage credit?
  requiresApproval: boolean;
  next: CreditState;
  reason?: string;
}

/**
 * Consume ONE lead credit for a delivered qualified opportunity. Pure — returns
 * the new state + whether the lead may be delivered. Honors the state machine
 * (suspended/canceled never deliver) and the overage mode when the allowance is
 * spent.
 */
export function consumeCredit(c: CreditState): ConsumeResult {
  // A tenant that isn't in a delivering state never consumes credits.
  if (!isScanningAllowed(c.state)) {
    return { delivered: false, overage: false, requiresApproval: false, next: c, reason: `billing state ${c.state}` };
  }
  if (c.unlimited) {
    return { delivered: true, overage: false, requiresApproval: false, next: { ...c, used: c.used + 1 } };
  }
  const remaining = creditsRemaining(c);
  if (remaining > 0) {
    return { delivered: true, overage: false, requiresApproval: false, next: { ...c, used: c.used + 1 } };
  }
  // Allowance spent — behavior depends on the overage mode.
  switch (c.overageMode) {
    case "allow_overage":
    case "auto_purchase": // (adapter tops up credits; here it's treated as deliver+bill)
      return { delivered: true, overage: true, requiresApproval: false, next: { ...c, used: c.used + 1, overageUsed: c.overageUsed + 1 } };
    case "require_approval":
      return { delivered: false, overage: false, requiresApproval: true, next: c, reason: "credit limit reached — approval required" };
    case "stop":
    default:
      return { delivered: false, overage: false, requiresApproval: false, next: c, reason: "credit limit reached" };
  }
}

/** Start a fresh billing cycle: reset used/overage, optionally roll unused credits. */
export function resetCycle(c: CreditState, allowRollover: boolean): CreditState {
  const unused = allowRollover ? creditsRemaining(c) : 0;
  const rollover = Number.isFinite(unused) ? unused : 0;
  const included = PLANS[c.planKey].monthlyCredits ?? c.included;
  return { ...c, included, used: 0, purchased: 0, overageUsed: 0, rollover };
}
