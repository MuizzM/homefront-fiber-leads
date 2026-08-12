// ── The recovery engine ──────────────────────────────────────────────────────
//
// Turns "what does the provider say about this order" into "who has to do
// something about it, and how soon". The decision itself is pure and lives in
// shared/orderRecovery.ts; this file supplies that decision with facts from the
// database, writes the outcome, and does nothing else.
//
// IT NEVER SENDS ANYTHING. Opening a case is a work item on a screen. Messaging
// is a separate, consent-gated act in orderRecoveryMessaging.ts that a human
// starts. That separation is what lets an organization run the whole recovery
// queue with messaging switched off - which is the default, and the state most
// organizations should stay in until counsel has signed off their templates.
//
// PASSES ARE IDEMPOTENT. The evaluator runs after every import and on a
// schedule, and running it twice in a row must change nothing the second time.
// The partial unique index on active cases is the backstop; the code checks
// first so the normal path never relies on catching a constraint violation.

import { rawDb } from "./db";
import * as store from "./vendorOrderStore";
import {
  DEFAULT_RECOVERY_POLICY, RECOVERY_REASON_LABELS, escalatePriority, evaluateRecovery,
  type RecoveryCandidate, type RecoveryDecision, type RecoveryPolicy, type RecoveryPriority,
} from "@shared/orderRecovery";
import { isInstalledOrderStatus, type NormalizedOrderStatus } from "@shared/orderStatusSource";

/** Orders read per page during a scan. Small enough that a pass over a large
 *  organization is a series of short reads rather than one long one - the same
 *  reason fccImportStore batches its finalize. */
const SCAN_PAGE = 250;

export interface EvaluationSummary {
  scanned: number;
  opened: number;
  escalated: number;
  autoResolved: number;
  skipped: number;
}

/**
 * Evaluate every order in one organization.
 *
 * `now` is a parameter rather than read inside, so a test can pin the clock and
 * so a single pass over thousands of orders uses ONE instant. Without that, an
 * order evaluated at 23:59:59.9 and the next one at 00:00:00.1 would be scored
 * against different days.
 */
export function evaluateTenantRecovery(tenantId: number, now: Date = new Date()): EvaluationSummary {
  const config = store.getOrgRecoveryConfig(tenantId);
  const summary: EvaluationSummary = { scanned: 0, opened: 0, escalated: 0, autoResolved: 0, skipped: 0 };

  // Installed orders first: closing a case that succeeded is the outcome the
  // whole feature exists to record, and doing it before the open-case pass
  // means a freshly installed order is never re-escalated on its way out.
  summary.autoResolved += closeCasesForInstalledOrders(tenantId, now);

  let afterId = 0;
  for (;;) {
    const page = store.listOrdersForRecoveryScan(tenantId, SCAN_PAGE, afterId);
    if (page.length === 0) break;
    for (const order of page) {
      afterId = Math.max(afterId, Number(order.id));
      summary.scanned += 1;
      const outcome = evaluateOneOrder(tenantId, order, config.policy, now);
      if (outcome === "opened") summary.opened += 1;
      else if (outcome === "escalated") summary.escalated += 1;
      else summary.skipped += 1;
    }
    if (page.length < SCAN_PAGE) break;
  }

  return summary;
}

export type OrderOutcome = "opened" | "escalated" | "unchanged";

/**
 * One order. Exported so the import worker can evaluate exactly the orders it
 * just touched, instead of re-scanning an organization after every upload.
 */
export function evaluateOneOrder(
  tenantId: number,
  order: any,
  policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
  now: Date = new Date(),
): OrderOutcome {
  const existing = store.findActiveCase(tenantId, Number(order.id));
  // Deliberately evaluated as if no case existed. The pure function refuses
  // early on `hasActiveCase`, which is the right answer for "should I OPEN
  // one" - but this call also has to answer "what would today's verdict be",
  // because that is what keeps an open case's reason and priority honest as
  // the order moves. The duplicate-case guard is the `existing` branch two
  // lines below, backed by the partial unique index.
  const candidate = toCandidate(tenantId, order, false);
  const decision = evaluateRecovery(candidate, policy, now);

  if (existing) return refreshExistingCase(tenantId, existing, order, decision, policy, now);
  if (!decision.open) return "unchanged";

  const assignment = resolveAssignment(tenantId, order);
  const caseId = store.openCase({
    tenantId,
    vendorOrderId: Number(order.id),
    saleId: order.sale_id ?? null,
    leadId: order.lead_id ?? null,
    assignedToRepId: assignment.repId,
    assignedToUserId: assignment.userId,
    reason: decision.reason,
    priority: decision.priority,
    daysStalled: decision.daysStalled,
    nextActionAt: nextActionFor(decision.priority, now),
    optOutBlocked: candidate.optedOutEverywhere,
  });
  if (caseId == null) return "unchanged"; // another pass won the race

  store.appendCaseEvent({
    tenantId, caseId, eventType: "opened", actorUserId: null, actorName: "Recovery engine",
    detail: `${RECOVERY_REASON_LABELS[decision.reason]} - ${decision.daysStalled} day${decision.daysStalled === 1 ? "" : "s"} stalled`,
  });
  if (assignment.repId != null) {
    store.appendCaseEvent({
      tenantId, caseId, eventType: "assigned", actorUserId: null, actorName: "Recovery engine",
      detail: `Assigned to the rep who sold the order${assignment.repName ? ` (${assignment.repName})` : ""}`,
    });
  }
  return "opened";
}

/**
 * An already-open case, seen again.
 *
 * Three things can have happened since it opened: the order recovered (handled
 * by the installed pass), the order got worse, or nothing moved. Priority only
 * ever goes UP here. An admin who deliberately dropped a case to low should not
 * have the engine hand it straight back on the next run, and a case that has
 * been sitting for a fortnight should not still look like the one opened this
 * morning.
 */
function refreshExistingCase(
  tenantId: number, existing: any, order: any,
  decision: RecoveryDecision, policy: RecoveryPolicy, now: Date,
): OrderOutcome {
  // ── The order installed ────────────────────────────────────────────────
  // Closed HERE as well as in the organization-wide pass, because the import
  // worker evaluates only the orders a file touched. Without this, an install
  // that arrived on this morning's report would leave the case open - and a rep
  // chasing an order that is already in the ground - until the next full scan.
  if (isInstalledOrderStatus(order.normalized_status)) {
    store.updateCase(existing.id, {
      status: "resolved",
      resolved_at: now.toISOString(),
      resolution_code: "recovered_installed",
      resolution_note: order.install_date
        ? `The provider reported the install completed on ${String(order.install_date).slice(0, 10)}.`
        : "The provider reported the order as installed.",
    });
    store.appendCaseEvent({
      tenantId, caseId: existing.id, eventType: "resolved", actorUserId: null, actorName: "Recovery engine",
      detail: "The order installed.",
    });
    return "escalated";
  }

  // The order left the state that justified the case, and it is not installed
  // (that branch is above). Canceled or rejected: the case is not recoverable
  // any more, so close it honestly rather than leaving a rep chasing it.
  if (!decision.open && (order.normalized_status === "canceled" || order.normalized_status === "rejected")) {
    if (decision.ineligible === "CANCELLATION_NOT_RECOVERABLE" || decision.ineligible === "CANCELLATION_WINDOW_CLOSED" || decision.ineligible === "NO_TRIGGER") {
      store.updateCase(existing.id, {
        status: "not_recoverable",
        resolved_at: now.toISOString(),
        resolution_code: "not_recoverable_customer_declined",
        resolution_note: `The provider marked this order ${order.normalized_status}.`,
      });
      store.appendCaseEvent({
        tenantId, caseId: existing.id, eventType: "closed", actorUserId: null, actorName: "Recovery engine",
        detail: `Closed because the provider marked the order ${order.normalized_status}.`,
      });
      return "escalated";
    }
  }

  const daysOpen = Math.max(0, Math.floor((now.getTime() - Date.parse(existing.opened_at)) / 86_400_000));
  const scheduledHours = order.install_scheduled_at
    ? (Date.parse(order.install_scheduled_at) - now.getTime()) / 3_600_000
    : null;
  const proposed: RecoveryPriority = decision.open ? decision.priority : existing.priority;
  const escalated = escalatePriority(
    higherOf(existing.priority as RecoveryPriority, proposed),
    daysOpen,
    scheduledHours != null && scheduledHours >= 0 ? scheduledHours : null,
    policy,
  );

  const daysStalled = decision.open ? decision.daysStalled : existing.days_stalled;
  // The REASON has to follow the order. A case opened a fortnight ago as
  // "submitted with no progress" whose install has since failed is telling the
  // rep the wrong thing, and the wrong thing is what they will say on the
  // phone. The reason only ever moves to what the engine would open today.
  const reason = decision.open && decision.reason !== existing.recovery_reason ? decision.reason : null;
  const changed = escalated !== existing.priority || daysStalled !== existing.days_stalled || reason != null;
  if (!changed) return "unchanged";

  store.updateCase(existing.id, {
    priority: escalated,
    days_stalled: daysStalled,
    ...(reason ? { recovery_reason: reason } : {}),
  });
  if (reason) {
    store.appendCaseEvent({
      tenantId, caseId: existing.id, eventType: "reason_changed", actorUserId: null, actorName: "Recovery engine",
      detail: `Now ${RECOVERY_REASON_LABELS[reason]} (was ${RECOVERY_REASON_LABELS[existing.recovery_reason as keyof typeof RECOVERY_REASON_LABELS] ?? existing.recovery_reason}).`,
    });
  }
  if (escalated !== existing.priority) {
    store.appendCaseEvent({
      tenantId, caseId: existing.id, eventType: "priority_changed", actorUserId: null, actorName: "Recovery engine",
      detail: `Priority raised from ${existing.priority} to ${escalated}.`,
    });
  }
  return "escalated";
}

/**
 * Close the cases whose orders installed.
 *
 * This is the conversion event. Note what it does NOT claim: `installed` from a
 * provider report means the technician finished, and nothing more. It closes
 * the case, it advances the funnel, and it leaves the question of whether a
 * commission was earned entirely to the Commission File plane.
 */
function closeCasesForInstalledOrders(tenantId: number, now: Date): number {
  const rows = rawDb.prepare(`
    SELECT c.id AS case_id, o.normalized_status, o.install_date
      FROM order_recovery_cases c
      JOIN vendor_orders o ON o.id = c.vendor_order_id AND o.tenant_id = c.tenant_id
     WHERE c.tenant_id = ? AND c.status IN ('open','in_progress','snoozed')
       AND o.normalized_status = 'installed'
  `).all(tenantId) as any[];

  for (const row of rows) {
    store.updateCase(row.case_id, {
      status: "resolved",
      resolved_at: now.toISOString(),
      resolution_code: "recovered_installed",
      resolution_note: row.install_date
        ? `The provider reported the install completed on ${String(row.install_date).slice(0, 10)}.`
        : "The provider reported the order as installed.",
    });
    store.appendCaseEvent({
      tenantId, caseId: row.case_id, eventType: "resolved", actorUserId: null, actorName: "Recovery engine",
      detail: "The order installed.",
    });
  }
  return rows.length;
}

// ── Facts ────────────────────────────────────────────────────────────────────

/**
 * Assemble what the pure decision needs.
 *
 * Every blocking fact is read from a source of truth rather than inferred:
 * fraud from the sale, do-not-contact from the lead, opt-out from the
 * suppression list, commission-paid from the commission link table. A missing
 * source reads as the SAFE value, which for a block means "assume it might
 * apply" only where that cannot deadlock the queue - fraud and do-not-contact
 * default to false because a missing row genuinely means no flag was set.
 */
function toCandidate(tenantId: number, order: any, hasActiveCase: boolean): RecoveryCandidate {
  const saleFlags = order.sale_id
    ? rawDb.prepare(`SELECT fraud_flagged FROM commission_sales WHERE id = ? AND tenant_id = ?`)
        .get(order.sale_id, tenantId) as any
    : null;
  const leadFlags = order.lead_id
    ? rawDb.prepare(`SELECT do_not_knock FROM leads WHERE id = ?`).get(order.lead_id) as any
    : null;

  return {
    normalizedStatus: order.normalized_status as NormalizedOrderStatus,
    submittedDate: parseOrNull(order.submitted_date),
    installScheduledAt: parseOrNull(order.install_scheduled_at),
    installDate: parseOrNull(order.install_date),
    cancellationDate: parseOrNull(order.cancellation_date),
    failureReason: order.failure_reason ?? null,
    requiredCustomerAction: order.required_customer_action ?? null,
    lastVendorUpdatedAt: parseOrNull(order.last_vendor_updated_at) ?? parseOrNull(order.last_synced_at),

    identityResolved: order.match_status === "matched" && Number(order.match_confidence_score ?? 0) >= 0.9,
    commissionPaid: store.commissionPaidForOrder(tenantId, Number(order.id)),
    knownFraudulent: Boolean(saleFlags?.fraud_flagged),
    // do_not_knock is this repo's permanent, compliance-grade block on a door.
    // A household that told a rep never to come back is not a household to
    // start texting instead.
    doNotContact: Boolean(leadFlags?.do_not_knock),
    optedOutEverywhere: store.optedOutEverywhere(tenantId, order),
    hasActiveCase,
  };
}

function parseOrNull(value: unknown): Date | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Default routing: back to the rep who sold it. They know the customer, they
 *  have the relationship, and the commission is theirs. A manager reassigns
 *  from the queue when that is not the right answer. */
function resolveAssignment(tenantId: number, order: any): { repId: number | null; userId: number | null; repName: string | null } {
  const repId = order.rep_id != null ? Number(order.rep_id) : null;
  if (repId == null) return { repId: null, userId: null, repName: null };
  const rep = rawDb.prepare(`SELECT id, name, active, tenant_id FROM team_members WHERE id = ?`).get(repId) as any;
  if (!rep || rep.tenant_id !== tenantId || !rep.active) {
    // An offboarded rep's recoveries go to the queue unassigned rather than to
    // a seat nobody sits in.
    return { repId: null, userId: null, repName: null };
  }
  const user = rawDb.prepare(`SELECT id FROM users WHERE team_member_id = ? AND active = 1 LIMIT 1`).get(repId) as any;
  return { repId, userId: user?.id ?? null, repName: rep.name ?? null };
}

/** When the queue should surface a case next. Urgent means today. */
function nextActionFor(priority: RecoveryPriority, now: Date): string {
  const hours = priority === "urgent" ? 2 : priority === "high" ? 24 : priority === "medium" ? 72 : 168;
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

function higherOf(a: RecoveryPriority, b: RecoveryPriority): RecoveryPriority {
  const rank: Record<RecoveryPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  return rank[b] < rank[a] ? b : a;
}

/** Used by the dashboard tiles and by the tests: the funnel counts, unfiltered
 *  by any recovery state. */
export function orderFunnel(tenantId: number, repIds: number[] | null): Record<string, number> {
  return store.orderStatusCounts(tenantId, repIds);
}

export { isInstalledOrderStatus };
