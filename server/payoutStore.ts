// ── Payout store — the durable side of shared/payouts.ts ──────────────────────
// Rep connected-account records + the payout ledger (one Transfer per row).
// UNIQUE(statement_id) on rep_payouts makes "Pay reps" idempotent at the DB level:
// a second attempt for the same finalized statement can never create a second
// payout. Connect webhook idempotency reuses the billing_events table.
import { rawDb } from "./db";
import type { OnboardingStatus, PayoutStatus } from "../shared/payouts";

export interface PayoutAccount {
  repId: number; tenantId: number; provider: string;
  stripeAccountId: string | null; onboardingStatus: OnboardingStatus;
  payoutsEnabled: boolean; chargesEnabled: boolean; detailsSubmitted: boolean;
  disabledReason: string | null; lastEventAt: string | null; createdAt: string; updatedAt: string;
}
function mapAccount(r: any): PayoutAccount | null {
  if (!r) return null;
  return {
    repId: r.rep_id, tenantId: r.tenant_id, provider: r.provider,
    stripeAccountId: r.stripe_account_id, onboardingStatus: r.onboarding_status,
    payoutsEnabled: !!r.payouts_enabled, chargesEnabled: !!r.charges_enabled,
    detailsSubmitted: !!r.details_submitted, disabledReason: r.disabled_reason,
    lastEventAt: r.last_event_at ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function assertRepInTenant(tenantId: number, repId: number): void {
  const member = rawDb.prepare(
    "SELECT tenant_id tenantId FROM team_members WHERE id = ?",
  ).get(repId) as { tenantId: number | null } | undefined;
  if (!member || member.tenantId !== tenantId) throw new Error("PAYOUT_REP_TENANT_MISMATCH");
}

export function getPayoutAccount(tenantId: number, repId: number): PayoutAccount | null {
  return mapAccount(rawDb.prepare(
    "SELECT * FROM rep_payout_accounts WHERE tenant_id = ? AND rep_id = ?",
  ).get(tenantId, repId));
}
export function getPayoutAccountByStripeId(tenantId: number, stripeAccountId: string): PayoutAccount | null {
  return mapAccount(rawDb.prepare(
    "SELECT * FROM rep_payout_accounts WHERE tenant_id = ? AND stripe_account_id = ?",
  ).get(tenantId, stripeAccountId));
}

/**
 * Webhooks do not have a portal session from which to obtain a tenant. Resolve
 * only the tenant id from Stripe's globally unique account id, then require the
 * resolved id on every subsequent read/write. Keeping this seam narrow prevents
 * request handlers from accidentally turning an account id into a cross-tenant
 * lookup primitive.
 */
export function resolvePayoutAccountTenantForWebhook(stripeAccountId: string): number | null {
  const row = rawDb.prepare(
    "SELECT tenant_id tenantId FROM rep_payout_accounts WHERE stripe_account_id = ?",
  ).get(stripeAccountId) as { tenantId: number } | undefined;
  return row?.tenantId ?? null;
}
/** Idempotently ensure a rep has a payout-account row (created before the Stripe
 *  account id exists — onboarding fills that in). */
export function ensurePayoutAccount(repId: number, tenantId: number): PayoutAccount {
  assertRepInTenant(tenantId, repId);

  // rep_id is the table PK. Read it without tenant scope only to detect a legacy
  // corrupt/foreign row and fail closed; never return that row to the caller.
  const anyExisting = mapAccount(rawDb.prepare(
    "SELECT * FROM rep_payout_accounts WHERE rep_id = ?",
  ).get(repId));
  if (anyExisting) {
    if (anyExisting.tenantId !== tenantId) throw new Error("PAYOUT_ACCOUNT_TENANT_CONFLICT");
    return anyExisting;
  }
  rawDb.prepare("INSERT INTO rep_payout_accounts (rep_id, tenant_id) VALUES (?, ?)").run(repId, tenantId);
  return getPayoutAccount(tenantId, repId)!;
}
export function setStripeAccountId(tenantId: number, repId: number, stripeAccountId: string): void {
  const result = rawDb.prepare(
    "UPDATE rep_payout_accounts SET stripe_account_id = ?, updated_at = datetime('now') WHERE tenant_id = ? AND rep_id = ?",
  ).run(stripeAccountId, tenantId, repId);
  if (result.changes !== 1) throw new Error("PAYOUT_ACCOUNT_NOT_FOUND");
}
export function updateAccountFromStripe(tenantId: number, stripeAccountId: string, f: {
  payoutsEnabled: boolean; chargesEnabled: boolean; detailsSubmitted: boolean;
  disabledReason: string | null; onboardingStatus: OnboardingStatus; eventCreated?: string | null;
}): boolean {
  // Ordering guard: Stripe doesn't guarantee webhook order — an OLDER account.updated
  // must not overwrite newer onboarding facts (e.g. flip payouts_enabled back on after
  // a restriction). Only apply when the event is >= the last one we applied.
  const wc = f.eventCreated ? " AND (last_event_at IS NULL OR last_event_at <= ?)" : "";
  const stmt = rawDb.prepare(
    `UPDATE rep_payout_accounts
       SET payouts_enabled = ?, charges_enabled = ?, details_submitted = ?, disabled_reason = ?,
           onboarding_status = ?, last_event_at = COALESCE(?, last_event_at), updated_at = datetime('now')
     WHERE tenant_id = ? AND stripe_account_id = ?${wc}`
  );
  const args: any[] = [f.payoutsEnabled ? 1 : 0, f.chargesEnabled ? 1 : 0, f.detailsSubmitted ? 1 : 0, f.disabledReason ?? null, f.onboardingStatus, f.eventCreated ?? null, tenantId, stripeAccountId];
  if (f.eventCreated) args.push(f.eventCreated);
  return stmt.run(...args).changes === 1;
}

// ── Payouts ───────────────────────────────────────────────────────────────────
export interface PayoutRow {
  id: number; tenantId: number; repId: number; statementId: number | null;
  amountCents: number; currency: string; status: PayoutStatus;
  stripeTransferId: string | null; destinationAccountId: string | null;
  failureReason: string | null; createdBy: number | null;
  createdAt: string; paidAt: string | null; updatedAt: string;
}
function mapPayout(r: any): PayoutRow | null {
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenant_id, repId: r.rep_id, statementId: r.statement_id,
    amountCents: r.amount_cents, currency: r.currency, status: r.status,
    stripeTransferId: r.stripe_transfer_id, destinationAccountId: r.destination_account_id,
    failureReason: r.failure_reason, createdBy: r.created_by,
    createdAt: r.created_at, paidAt: r.paid_at, updatedAt: r.updated_at,
  };
}

export function getPayoutByStatement(tenantId: number, statementId: number): PayoutRow | null {
  return mapPayout(rawDb.prepare(
    "SELECT * FROM rep_payouts WHERE tenant_id = ? AND statement_id = ?",
  ).get(tenantId, statementId));
}

interface PayoutPreviewFacts {
  repId: number;
  onboardingStatus: OnboardingStatus;
  payoutStatus: PayoutStatus | null;
}

/** Read only the statuses needed by the preview, without loading account secrets
 * or payout history. json_each keeps the query below SQLite's bind limit even
 * for large teams; both joins remain tenant-scoped and use existing keys. */
export function getPayoutPreviewFacts(
  tenantId: number,
  rows: readonly { repId: number; statementId: number | null }[],
): Map<number, PayoutPreviewFacts> {
  if (rows.length === 0) return new Map();
  const requested = JSON.stringify(rows.map(row => [row.repId, row.statementId]));
  const facts = rawDb.prepare<[string, number, number], PayoutPreviewFacts>(`
    SELECT json_extract(request.value, '$[0]') AS repId,
           COALESCE(account.onboarding_status, 'none') AS onboardingStatus,
           payout.status AS payoutStatus
    FROM json_each(?) AS request
    LEFT JOIN rep_payout_accounts AS account
      ON account.rep_id = json_extract(request.value, '$[0]') AND account.tenant_id = ?
    LEFT JOIN rep_payouts AS payout
      ON payout.statement_id = json_extract(request.value, '$[1]') AND payout.tenant_id = ?
  `).all(requested, tenantId, tenantId);
  return new Map(facts.map(fact => [fact.repId, fact]));
}

export function getPayoutById(tenantId: number, id: number): PayoutRow | null {
  return mapPayout(rawDb.prepare(
    "SELECT * FROM rep_payouts WHERE tenant_id = ? AND id = ?",
  ).get(tenantId, id));
}

/**
 * Create a `pending` payout row, or return the existing one for this statement.
 * The UNIQUE(statement_id) index is the hard guard: a concurrent/duplicate "Pay"
 * can't create a second row for the same statement. Returns {row, created}.
 */
export function createPendingPayout(p: {
  tenantId: number; repId: number; statementId: number | null;
  amountCents: number; destinationAccountId: string | null; createdBy: number | null;
}): { row: PayoutRow; created: boolean } {
  assertRepInTenant(p.tenantId, p.repId);
  if (p.destinationAccountId) {
    const destination = rawDb.prepare(
      "SELECT tenant_id tenantId, rep_id repId FROM rep_payout_accounts WHERE stripe_account_id = ?",
    ).get(p.destinationAccountId) as { tenantId: number; repId: number } | undefined;
    if (destination && (destination.tenantId !== p.tenantId || destination.repId !== p.repId)) {
      throw new Error("PAYOUT_DESTINATION_TENANT_MISMATCH");
    }
  }
  if (p.statementId != null) {
    const existing = getPayoutByStatement(p.tenantId, p.statementId);
    if (existing) return { row: existing, created: false };
  }
  try {
    const r = rawDb.prepare(
      `INSERT INTO rep_payouts (tenant_id, rep_id, statement_id, amount_cents, destination_account_id, created_by, status)
       VALUES (?,?,?,?,?,?, 'pending')`
    ).run(p.tenantId, p.repId, p.statementId ?? null, p.amountCents, p.destinationAccountId ?? null, p.createdBy ?? null);
    return { row: getPayoutById(p.tenantId, Number(r.lastInsertRowid))!, created: true };
  } catch (e: any) {
    // Lost a race on the unique index → return the row the winner created.
    if (p.statementId != null) {
      const existing = getPayoutByStatement(p.tenantId, p.statementId);
      if (existing) return { row: existing, created: false };
    }
    throw e;
  }
}

/** Mark a payout in-flight BEFORE the Stripe call, so a lost-response leaves an
 *  ACTIVE (non-re-payable) row that must be reconciled, never blindly re-sent. */
export function markPayoutProcessing(tenantId: number, id: number): void {
  rawDb.prepare(
    "UPDATE rep_payouts SET status = 'processing', updated_at = datetime('now') WHERE tenant_id = ? AND id = ?",
  ).run(tenantId, id);
}
export function markPayoutPaid(tenantId: number, id: number, transferId: string): void {
  rawDb.prepare(
    "UPDATE rep_payouts SET status = 'paid', stripe_transfer_id = ?, paid_at = datetime('now'), failure_reason = NULL, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?"
  ).run(transferId, tenantId, id);
}
/** Mark failed — CALLER MUST guarantee no transfer id exists (money never moved).
 *  Refuses to downgrade a row that already carries a transfer id (defence in depth). */
export function markPayoutFailed(tenantId: number, id: number, reason: string): void {
  rawDb.prepare(
    "UPDATE rep_payouts SET status = 'failed', failure_reason = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ? AND stripe_transfer_id IS NULL"
  ).run(reason.slice(0, 300), tenantId, id);
}
/** Reversal (clawback) — match by transfer id REGARDLESS of the current status
 *  (not just 'paid'), so a reversal is never silently dropped, and never re-reverse. */
export function markPayoutReversedByTransfer(tenantId: number, transferId: string): number {
  return rawDb.prepare(
    "UPDATE rep_payouts SET status = 'reversed', updated_at = datetime('now') WHERE tenant_id = ? AND stripe_transfer_id = ? AND status != 'reversed'"
  ).run(tenantId, transferId).changes;
}

/** See resolvePayoutAccountTenantForWebhook: signed reversal webhooks begin with
 * a provider id, so resolve only the tenant and require it on the mutation. */
export function resolvePayoutTenantForWebhook(transferId: string): number | null {
  const row = rawDb.prepare(
    "SELECT tenant_id tenantId FROM rep_payouts WHERE stripe_transfer_id = ? LIMIT 1",
  ).get(transferId) as { tenantId: number } | undefined;
  return row?.tenantId ?? null;
}
/** Clear a transferless retry candidate (pending/processing/failed with NO transfer
 *  id — money definitely didn't move) so the pay loop can cleanly re-create it. */
export function resetPayoutForRetry(tenantId: number, id: number): void {
  rawDb.prepare(
    "DELETE FROM rep_payouts WHERE tenant_id = ? AND id = ? AND stripe_transfer_id IS NULL AND status IN ('pending','processing','failed')",
  ).run(tenantId, id);
}

export function listPayouts(tenantId: number, opts: { repId?: number; limit?: number } = {}): PayoutRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const rows = opts.repId != null
    ? rawDb.prepare("SELECT * FROM rep_payouts WHERE tenant_id = ? AND rep_id = ? ORDER BY created_at DESC LIMIT ?").all(tenantId, opts.repId, limit)
    : rawDb.prepare("SELECT * FROM rep_payouts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?").all(tenantId, limit);
  return rows.map(mapPayout) as PayoutRow[];
}

// ── Connect webhook idempotency (reuses billing_events) ───────────────────────
export function wasConnectEventProcessed(eventId: string): boolean {
  if (!eventId) return false;
  return !!rawDb.prepare("SELECT 1 FROM billing_events WHERE event_id = ?").get(eventId);
}
export function recordConnectEvent(eventId: string, type?: string, intent?: string): void {
  if (!eventId) return;
  rawDb.prepare("INSERT OR IGNORE INTO billing_events (event_id, provider, type, intent) VALUES (?, 'stripe_connect', ?, ?)").run(eventId, type ?? null, intent ?? null);
}
