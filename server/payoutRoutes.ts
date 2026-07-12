// ── Payout routes — Stripe Connect rep payouts ────────────────────────────────
// Rep onboarding + the "Pay reps" money action + Connect webhook. Everything is
// INERT without Stripe keys (503) and the pay action is EXPLICIT (owner clicks it).
//
// Double-pay safety: rep_payouts has UNIQUE(statement_id), so one payout row per
// finalized statement; the Stripe Transfer uses a STABLE idempotency key
// (`payout:stmt:<id>`) so a retry after a crash returns the ORIGINAL transfer
// instead of sending money twice. A `paid`/`reversed` statement is skipped; a
// stuck `pending`/`failed` one is safely re-attempted with the same key.
import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import * as commissionSvc from "./commissionService";
import * as payoutStore from "./payoutStore";
import {
  connectConfigured, connectWebhookConfigured, createConnectedAccount, createAccountLink,
  fetchAccount, createTransfer, findTransferByGroup, verifyConnectSignature, processConnectWebhook,
} from "./stripeConnect";
import { onboardingStatusFrom, payoutEligibility, BLOCK_LABEL, type PayoutStatus } from "../shared/payouts";
import type { Capability } from "@shared/capabilities";

interface Deps {
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
  requireCapability: (cap: Capability) => (req: Request, res: Response, next: NextFunction) => void;
}

export function registerPayoutRoutes(app: Express, { requireAuth, requireCapability }: Deps) {
  const tid = (req: Request): number => ((req as any).user?.tenantId ?? 0);
  const uid = (req: Request): number | null => ((req as any).user?.id ?? null);
  const myRepId = (req: Request): number | null => ((req as any).user?.teamMemberId ?? null);
  const repById = (tenantId: number, repId: number) => storage.getTeamMembers(tenantId).find((m: any) => m.id === repId);

  // ── Rep onboarding ──────────────────────────────────────────────────────────
  // Ensure a connected account for the acting rep, return a hosted onboarding URL.
  app.post("/api/payouts/connect", requireAuth, requireCapability("commission.read.self"), async (req: Request, res: Response) => {
    if (!connectConfigured()) return res.status(503).json({ error: "Payouts aren't enabled yet." });
    const repId = myRepId(req);
    if (!repId) return res.status(400).json({ error: "No rep profile linked to your login." });
    const tenantId = tid(req);
    try {
      const acct = payoutStore.ensurePayoutAccount(repId, tenantId);
      let stripeAccountId = acct.stripeAccountId;
      if (!stripeAccountId) {
        const rep = repById(tenantId, repId);
        stripeAccountId = await createConnectedAccount({ email: rep?.email ?? null, repId, tenantId });
        payoutStore.setStripeAccountId(repId, stripeAccountId);
      }
      const origin = (req.headers.origin as string) || `https://${req.headers.host}`;
      const url = await createAccountLink(stripeAccountId, `${origin}/#/my-commission?onboard=refresh`, `${origin}/#/my-commission?onboard=done`);
      res.json({ url });
    } catch (e: any) {
      res.status(502).json({ error: e.message || "Could not start onboarding" });
    }
  });

  // The acting rep's payout-account status (stored; cheap — no Stripe call).
  app.get("/api/payouts/account", requireAuth, requireCapability("commission.read.self"), (req: Request, res: Response) => {
    const repId = myRepId(req);
    if (!repId) return res.json({ hasRepProfile: false });
    const acct = payoutStore.getPayoutAccount(repId);
    res.json({
      hasRepProfile: true,
      enabled: connectConfigured(),
      onboardingStatus: acct?.onboardingStatus ?? "none",
      payoutsEnabled: !!acct?.payoutsEnabled,
      detailsSubmitted: !!acct?.detailsSubmitted,
      history: payoutStore.listPayouts(tid(req), { repId, limit: 25 }),
    });
  });

  // Re-sync from Stripe (called when the rep returns from the hosted onboarding).
  app.post("/api/payouts/account/refresh", requireAuth, requireCapability("commission.read.self"), async (req: Request, res: Response) => {
    if (!connectConfigured()) return res.status(503).json({ error: "Payouts aren't enabled yet." });
    const repId = myRepId(req);
    if (!repId) return res.status(400).json({ error: "No rep profile linked to your login." });
    const acct = payoutStore.getPayoutAccount(repId);
    if (!acct?.stripeAccountId) return res.status(409).json({ error: "No payout account yet." });
    try {
      const facts = await fetchAccount(acct.stripeAccountId);
      payoutStore.updateAccountFromStripe(acct.stripeAccountId, { ...facts, onboardingStatus: onboardingStatusFrom(facts) });
      const fresh = payoutStore.getPayoutAccount(repId);
      res.json({ onboardingStatus: fresh?.onboardingStatus, payoutsEnabled: !!fresh?.payoutsEnabled });
    } catch (e: any) {
      res.status(502).json({ error: e.message || "Could not refresh account" });
    }
  });

  // ── Admin: preview a finalized week's payouts (who's eligible + why not) ──────
  app.get("/api/payouts/week", requireAuth, requireCapability("commission.read.all"), (req: Request, res: Response) => {
    const tenantId = tid(req);
    const weekRef = typeof req.query.week === "string" ? req.query.week : new Date().toISOString();
    const overview = commissionSvc.getWeekOverview(tenantId, uid(req), weekRef, null);
    const rows = overview.rows.map((r: any) => {
      const acct = payoutStore.getPayoutAccount(r.repId);
      const existing = r.statementId ? payoutStore.getPayoutByStatement(r.statementId) : null;
      const elig = payoutEligibility({
        statementStatus: r.status,
        finalCents: r.finalCommissionCents,
        onboardingStatus: acct?.onboardingStatus ?? "none",
        existingPayoutStatus: (existing?.status as PayoutStatus) ?? null,
      });
      // Surface a clawed-back (reversed) payout as needs-attention, not a bland "paid".
      const reversed = existing?.status === "reversed";
      return {
        repId: r.repId, repName: r.repName, statementId: r.statementId, status: r.status,
        finalCommissionCents: r.finalCommissionCents,
        onboardingStatus: acct?.onboardingStatus ?? "none",
        payoutStatus: existing?.status ?? null,
        eligible: elig.eligible,
        blockReason: reversed ? "payout_reversed" : elig.reason,
        blockLabel: reversed ? "Payout was reversed — needs attention" : (elig.reason ? BLOCK_LABEL[elig.reason] : null),
      };
    });
    const payableCents = rows.filter(r => r.eligible).reduce((s, r) => s + r.finalCommissionCents, 0);
    res.json({
      stripeEnabled: connectConfigured(),
      week: overview.bounds.localWeekLabel,
      rows,
      payableCount: rows.filter(r => r.eligible).length,
      payableCents,
    });
  });

  // ── Admin: PAY REPS (the money button) — EXPLICIT, OWNER-only, inert w/o keys ──
  // Gated on payouts.pay (admin/owner ONLY — NOT a manager read role). Each rep is
  // paid through a reconcile-first, processing-before-call, never-fail-after-transfer
  // flow so a lost response / crash / >24h retry can NEVER double-pay.
  app.post("/api/payouts/week/pay", requireAuth, requireCapability("payouts.pay"), async (req: Request, res: Response) => {
    if (!connectConfigured()) return res.status(503).json({ error: "Payouts aren't enabled yet." });
    const tenantId = tid(req);
    const actorId = uid(req);
    const weekRef = typeof req.body?.week === "string" ? req.body.week : new Date().toISOString();
    const onlyRepIds: number[] | null = Array.isArray(req.body?.repIds) ? req.body.repIds.map(Number) : null;
    const overview = commissionSvc.getWeekOverview(tenantId, actorId, weekRef, null);

    // Advance a statement to PAID; a failure here NEVER fails the payout (money moved).
    const safeTransition = (statementId: number) => {
      try { commissionSvc.transitionStatement(tenantId, actorId, statementId, "MARK_PAID"); }
      catch (e: any) { console.warn(`[payouts] statement ${statementId} paid but MARK_PAID lagged: ${e.message}`); }
    };

    const results: any[] = [];
    for (const r of overview.rows as any[]) {
      if (onlyRepIds && !onlyRepIds.includes(r.repId)) continue;
      const statementId: number | null = r.statementId;
      if (statementId == null) continue; // only finalized statements are payable
      const acct = payoutStore.getPayoutAccount(r.repId);
      const group = `payout-stmt-${statementId}`;
      let existing = statementId ? payoutStore.getPayoutByStatement(statementId) : null;

      // ── Reconcile any existing row BEFORE deciding to pay ──────────────────────
      if (existing) {
        if (existing.status === "paid") {
          if (r.status === "FINALIZED") safeTransition(statementId!); // heal crash-between
          results.push({ repId: r.repId, skipped: true, reason: "already_paid" });
          continue;
        }
        if (existing.status === "reversed") { results.push({ repId: r.repId, skipped: true, reason: "reversed" }); continue; }
        // pending / processing / failed — money MIGHT have moved. Ask Stripe.
        if (existing.stripeTransferId) {
          payoutStore.markPayoutPaid(existing.id, existing.stripeTransferId); safeTransition(statementId!);
          results.push({ repId: r.repId, paid: true, reconciled: true, transferId: existing.stripeTransferId });
          continue;
        }
        const found = await findTransferByGroup(group).catch(() => null);
        if (found) { // a transfer exists but our row missed it (lost response) → adopt, don't re-send
          payoutStore.markPayoutPaid(existing.id, found.transferId); safeTransition(statementId!);
          results.push({ repId: r.repId, paid: true, reconciled: true, transferId: found.transferId });
          continue;
        }
        // No transfer exists anywhere → safe to retry: clear the stale row + re-create clean.
        payoutStore.resetPayoutForRetry(existing.id);
        existing = null;
      }

      // ── Fresh eligibility (finalized + positive + onboarded + no active payout) ─
      const elig = payoutEligibility({
        statementStatus: r.status, finalCents: r.finalCommissionCents,
        onboardingStatus: acct?.onboardingStatus ?? "none", existingPayoutStatus: null,
      });
      if (!elig.eligible) { if (elig.reason) results.push({ repId: r.repId, skipped: true, reason: elig.reason }); continue; }

      // Belt-and-suspenders vs the 24h idempotency-key window: has a transfer already
      // been made for this statement (from a prior run whose row was wiped)?
      const prior = await findTransferByGroup(group).catch(() => null);
      const { row } = payoutStore.createPendingPayout({
        tenantId, repId: r.repId, statementId,
        amountCents: r.finalCommissionCents, destinationAccountId: acct!.stripeAccountId, createdBy: actorId,
      });
      if (prior) {
        payoutStore.markPayoutPaid(row.id, prior.transferId); safeTransition(statementId!);
        results.push({ repId: r.repId, paid: true, reconciled: true, transferId: prior.transferId });
        continue;
      }
      // Mark IN-FLIGHT before the call so a lost response leaves an active row.
      payoutStore.markPayoutProcessing(row.id);
      let transferId: string | undefined;
      try {
        ({ transferId } = await createTransfer({
          amountCents: r.finalCommissionCents,
          destinationAccountId: acct!.stripeAccountId!,
          idempotencyKey: `payout:stmt:${statementId}`,
          transferGroup: group,
          metadata: { statementId: String(statementId), repId: String(r.repId), tenantId: String(tenantId) },
        }));
      } catch (e: any) {
        // The transfer might still have landed (lost response). Reconcile before failing.
        const late = await findTransferByGroup(group).catch(() => null);
        if (late) {
          payoutStore.markPayoutPaid(row.id, late.transferId); safeTransition(statementId!);
          results.push({ repId: r.repId, paid: true, reconciled: true, transferId: late.transferId });
        } else {
          payoutStore.markPayoutFailed(row.id, e.message || "transfer error"); // safe: no transfer id
          results.push({ repId: r.repId, failed: true, reason: e.message || "transfer error" });
        }
        continue;
      }
      // Success: persist paid (with transfer id) FIRST — this is the source of truth.
      payoutStore.markPayoutPaid(row.id, transferId);
      safeTransition(statementId!); // bookkeeping — never downgrades the payout on failure
      results.push({ repId: r.repId, paid: true, amountCents: r.finalCommissionCents, transferId });
    }
    const paid = results.filter(r => r.paid);
    storage.logActivity(actorId, "payouts.week.paid", "commission_statement", undefined,
      { week: overview.bounds.localWeekLabel, paid: paid.length, totalCents: paid.reduce((s, r) => s + (r.amountCents || 0), 0) }, req.ip);
    res.json({ week: overview.bounds.localWeekLabel, results, paidCount: paid.length });
  });

  // Payout history (admin: all; rep would use /account). Tenant-scoped.
  app.get("/api/payouts", requireAuth, requireCapability("commission.read.all"), (req: Request, res: Response) => {
    res.json({ payouts: payoutStore.listPayouts(tid(req), { limit: 200 }) });
  });

  // ── Connect webhook (account.updated, transfer.reversed, payout.*) ────────────
  // NO session auth — HMAC-signed. CSRF-exempt (see index.ts). Inert (503) until
  // STRIPE_SECRET_KEY + STRIPE_CONNECT_WEBHOOK_SECRET are set.
  app.post("/api/payouts/webhook/stripe", (req: Request, res: Response) => {
    if (!connectConfigured() || !connectWebhookConfigured()) return res.status(503).json({ error: "not configured" });
    const raw = (req as any).rawBody;
    const sig = req.headers["stripe-signature"] as string | undefined;
    if (!raw || !verifyConnectSignature(raw, sig)) return res.status(400).json({ error: "invalid signature" });
    const event = req.body;
    if (!event?.id) return res.status(400).json({ error: "missing event id" });
    try {
      const r = processConnectWebhook(event);
      res.json({ received: true, applied: r.applied, kind: r.kind, duplicate: !!r.duplicate });
    } catch (e: any) {
      console.error(`[payouts] webhook ${event.type} error: ${e.message}`);
      res.status(500).json({ error: "handler error" });
    }
  });
}
