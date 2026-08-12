// ── Order recovery - which orders need a human, and how soon ─────────────────
// PURE and framework-free. One function decides whether an order becomes a
// recovery case and at what priority, so the nightly evaluation, the
// post-import evaluation, the queue's own re-scoring and the tests all reach
// the same verdict from the same inputs.
//
// THE SHAPE OF THE PROBLEM. A submitted order is a commission that has not
// happened yet. Between submission and install it can stall in a dozen ways,
// most of them silently: the customer never sent a document, the tech knocked
// and nobody was home, the provider put it on hold pending construction. Every
// one of those is recoverable for a while and then it is not. The queue exists
// to spend a rep's attention on the ones where a phone call still changes the
// outcome.
//
// WHAT THIS MODULE REFUSES TO DO. It never decides to CONTACT anybody. Opening
// a case is a work item; sending a message is a separate decision behind
// shared/contactConsent.ts. Keeping them apart is what lets the recovery queue
// run for an org that has messaging turned off entirely, which is the default.

import {
  ATTENTION_STATUSES,
  isInstalledOrderStatus,
  wholeDaysBetween,
  type NormalizedOrderStatus,
} from "./orderStatusSource";

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const RECOVERY_REASONS = [
  "stale_submitted",          // submitted, and nothing has moved since
  "stale_accepted",           // accepted, but no install ever got scheduled
  "install_overdue",          // scheduled date passed and it never installed
  "failed_install",
  "missed_appointment",
  "pending_customer_action",
  "pending_documents",
  "on_hold",
  "recoverable_cancellation", // canceled for a reason the admin marked winnable
  "vendor_recoverable_flag",  // the provider's own reason text says it is fixable
] as const;
export type RecoveryReason = (typeof RECOVERY_REASONS)[number];

export const RECOVERY_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type RecoveryPriority = (typeof RECOVERY_PRIORITIES)[number];

export const RECOVERY_PRIORITY_RANK: Readonly<Record<RecoveryPriority, number>> = {
  urgent: 0, high: 1, medium: 2, low: 3,
};

export const RECOVERY_CASE_STATUSES = [
  "open", "in_progress", "snoozed", "resolved", "not_recoverable",
] as const;
export type RecoveryCaseStatus = (typeof RECOVERY_CASE_STATUSES)[number];

/** A case that still consumes attention. Used by the queue, the caps, and the
 *  "do not open a duplicate" rule. */
export const ACTIVE_CASE_STATUSES: readonly RecoveryCaseStatus[] = ["open", "in_progress", "snoozed"];

export const RESOLUTION_CODES = [
  "recovered_installed",      // the outcome the whole feature exists for
  "recovered_rescheduled",
  "customer_completed_action",
  "documents_received",
  "resubmitted_as_new_order",
  "not_recoverable_customer_declined",
  "not_recoverable_no_serviceability",
  "not_recoverable_unreachable",
  "not_recoverable_duplicate",
  "closed_no_action_needed",
] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

/** Resolutions that count as a WIN in the conversion report. Kept as data, not
 *  as a string test at each call site, so the recovery-to-install rate cannot
 *  quietly change meaning between two dashboards. */
export const RECOVERED_RESOLUTIONS: readonly ResolutionCode[] = [
  "recovered_installed", "recovered_rescheduled", "customer_completed_action",
  "documents_received", "resubmitted_as_new_order",
];

export function isRecoveredResolution(code: string | null | undefined): boolean {
  return code != null && (RECOVERED_RESOLUTIONS as readonly string[]).includes(code);
}

export const RECOVERY_REASON_LABELS: Readonly<Record<RecoveryReason, string>> = {
  stale_submitted: "Submitted with no progress",
  stale_accepted: "Accepted with no install date",
  install_overdue: "Install date passed with no install",
  failed_install: "Failed install",
  missed_appointment: "Missed appointment",
  pending_customer_action: "Customer action needed",
  pending_documents: "Missing documents",
  on_hold: "On hold",
  recoverable_cancellation: "Canceled and possibly recoverable",
  vendor_recoverable_flag: "Provider flagged it as fixable",
};

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * Everything an org can tune, in one object stored per organization.
 *
 * Days are the unit throughout, because that is the unit an operations manager
 * thinks in. Every window is a number rather than a hard-coded constant for the
 * same reason the mapping is data: a fibre build in a dense market moves at a
 * different speed from a rural one, and the alternative to configuring it is
 * that somebody edits a constant and redeploys.
 */
export interface RecoveryPolicy {
  /** Days a `submitted` order may sit before it is stale. */
  staleSubmittedDays: number;
  /** Days an `accepted` order may sit with no scheduled install. */
  acceptedNoScheduleDays: number;
  /** Grace after a scheduled install date before it counts as overdue. */
  installOverdueGraceDays: number;
  /** How long after a cancellation an order stays worth chasing. */
  cancellationRecoveryWindowDays: number;
  /** Hours after a failure or missed appointment that count as URGENT. */
  urgentRecentIssueHours: number;
  /** Cancellation reasons an admin has marked as winnable. Matched
   *  case-insensitively as substrings of the provider's reason text. An empty
   *  list means NO cancellation is auto-recovered, which is the default. */
  recoverableCancellationReasons: string[];
  /** Cancellation and failure reasons that must never open a case, whatever
   *  else matches. Checked BEFORE the recoverable list. */
  nonRecoverableReasons: string[];
  /** Provider reason phrases that mean a human can fix it, used to open a case
   *  for a status that would otherwise look healthy. */
  vendorRecoverableReasonHints: string[];
  /** Estimated commission a single installed order is worth, in integer cents.
   *  Drives "commission at risk". Zero means the dashboard shows counts only
   *  rather than inventing a number. */
  estimatedOrderValueCents: number;
  /** Days of no progress before an open case is escalated in the queue. */
  escalateAfterDaysOpen: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  staleSubmittedDays: 7,
  acceptedNoScheduleDays: 5,
  installOverdueGraceDays: 1,
  cancellationRecoveryWindowDays: 30,
  urgentRecentIssueHours: 72,
  recoverableCancellationReasons: [],
  nonRecoverableReasons: ["fraud", "duplicate", "test order", "do not contact", "deceased"],
  vendorRecoverableReasonHints: [
    "missing", "pending customer", "reschedule", "unable to reach", "no answer",
    "documentation", "signature", "access", "gate code",
  ],
  estimatedOrderValueCents: 0,
  escalateAfterDaysOpen: 14,
};

/**
 * Merge a stored partial policy over the defaults.
 *
 * A policy row written before a new knob existed must not read as zero for that
 * knob. The result is a DEEP copy: DEFAULT_RECOVERY_POLICY is module-level and
 * its three arrays would otherwise be shared by every organization in the
 * process, so one caller pushing a reason onto its own policy would silently
 * add it to every other organization's - and to the defaults themselves, for
 * the lifetime of the process.
 */
export function resolveRecoveryPolicy(stored: Partial<RecoveryPolicy> | null | undefined): RecoveryPolicy {
  const numeric = (key: keyof RecoveryPolicy): number => {
    const v = stored?.[key];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : (DEFAULT_RECOVERY_POLICY[key] as number);
  };
  const list = (key: keyof RecoveryPolicy): string[] => {
    const v = stored?.[key];
    return Array.isArray(v)
      ? v.map((s) => String(s)).filter(Boolean)
      : [...(DEFAULT_RECOVERY_POLICY[key] as string[])];
  };
  return {
    staleSubmittedDays: numeric("staleSubmittedDays"),
    acceptedNoScheduleDays: numeric("acceptedNoScheduleDays"),
    installOverdueGraceDays: numeric("installOverdueGraceDays"),
    cancellationRecoveryWindowDays: numeric("cancellationRecoveryWindowDays"),
    urgentRecentIssueHours: numeric("urgentRecentIssueHours"),
    recoverableCancellationReasons: list("recoverableCancellationReasons"),
    nonRecoverableReasons: list("nonRecoverableReasons"),
    vendorRecoverableReasonHints: list("vendorRecoverableReasonHints"),
    estimatedOrderValueCents: numeric("estimatedOrderValueCents"),
    escalateAfterDaysOpen: numeric("escalateAfterDaysOpen"),
  };
}

// ── The evaluation ───────────────────────────────────────────────────────────

/** The order facts the decision needs. Deliberately a narrow structural type
 *  rather than the DB row: it keeps this module pure and makes every test case
 *  a literal. */
export interface RecoveryCandidate {
  normalizedStatus: NormalizedOrderStatus;
  submittedDate: Date | null;
  installScheduledAt: Date | null;
  installDate: Date | null;
  cancellationDate: Date | null;
  failureReason: string | null;
  requiredCustomerAction: string | null;
  /** The last time the PROVIDER changed anything about this order. Stale is
   *  measured against this when it is known, because an order the provider
   *  touched yesterday is not stalled however old the submission is. */
  lastVendorUpdatedAt: Date | null;

  // ── Blocking facts, resolved by the caller from CRM state ────────────────
  /** The import row matched an internal sale at high confidence. */
  identityResolved: boolean;
  /** Commission truth says this order was paid. Comes from the Commission File
   *  plane; never inferred from `installed`. */
  commissionPaid: boolean;
  /** Flagged fraudulent by an admin. */
  knownFraudulent: boolean;
  /** The linked lead or customer is marked do-not-contact. */
  doNotContact: boolean;
  /** The customer opted out of every channel we have. Note this blocks the
   *  CASE, not just the message: an operations queue full of cases nobody may
   *  ever act on is a queue reps learn to ignore. */
  optedOutEverywhere: boolean;
  /** An active case already exists for this order. */
  hasActiveCase: boolean;
}

export const RECOVERY_INELIGIBLE_REASONS = [
  "INSTALLED",
  "COMMISSION_PAID",
  "KNOWN_FRAUD",
  "DO_NOT_CONTACT",
  "OPTED_OUT",
  "IDENTITY_UNRESOLVED",
  "NON_RECOVERABLE_REASON",
  "CANCELLATION_WINDOW_CLOSED",
  "CANCELLATION_NOT_RECOVERABLE",
  "ALREADY_HAS_CASE",
  "NO_TRIGGER",
] as const;
export type RecoveryIneligibleReason = (typeof RECOVERY_INELIGIBLE_REASONS)[number];

export type RecoveryDecision =
  | { open: true; reason: RecoveryReason; priority: RecoveryPriority; daysStalled: number }
  | { open: false; ineligible: RecoveryIneligibleReason };

/**
 * Should this order become a recovery case, and how urgent is it?
 *
 * The refusals are checked FIRST and in this order, because they are the ones
 * that matter when they are wrong. An installed order that opens a case wastes
 * a rep's morning; an opted-out customer that opens a case puts a phone number
 * in front of somebody who asked us to stop.
 */
export function evaluateRecovery(
  order: RecoveryCandidate,
  policy: RecoveryPolicy,
  now: Date,
): RecoveryDecision {
  // ── Never, whatever else is true ────────────────────────────────────────
  if (isInstalledOrderStatus(order.normalizedStatus)) return { open: false, ineligible: "INSTALLED" };
  if (order.commissionPaid) return { open: false, ineligible: "COMMISSION_PAID" };
  if (order.knownFraudulent) return { open: false, ineligible: "KNOWN_FRAUD" };
  if (order.doNotContact) return { open: false, ineligible: "DO_NOT_CONTACT" };
  if (order.optedOutEverywhere) return { open: false, ineligible: "OPTED_OUT" };
  // An unmatched order is not known to be ours. It goes to the match exception
  // queue instead, which is a different screen with a different job.
  if (!order.identityResolved) return { open: false, ineligible: "IDENTITY_UNRESOLVED" };

  const reasonText = `${order.failureReason ?? ""} ${order.requiredCustomerAction ?? ""}`.toLowerCase();
  if (matchesAny(reasonText, policy.nonRecoverableReasons)) {
    return { open: false, ineligible: "NON_RECOVERABLE_REASON" };
  }
  if (order.hasActiveCase) return { open: false, ineligible: "ALREADY_HAS_CASE" };

  // ── Cancellations: only under an explicit policy ────────────────────────
  if (order.normalizedStatus === "canceled") {
    const since = wholeDaysBetween(order.cancellationDate ?? order.lastVendorUpdatedAt, now);
    if (since > policy.cancellationRecoveryWindowDays) {
      return { open: false, ineligible: "CANCELLATION_WINDOW_CLOSED" };
    }
    if (!matchesAny(reasonText, policy.recoverableCancellationReasons)) {
      return { open: false, ineligible: "CANCELLATION_NOT_RECOVERABLE" };
    }
    return { open: true, reason: "recoverable_cancellation", priority: "low", daysStalled: since };
  }
  // A rejection is the provider saying no. It never auto-opens; an admin who
  // disagrees resubmits, which produces a new order.
  if (order.normalizedStatus === "rejected") return { open: false, ineligible: "NO_TRIGGER" };

  // ── Attention states: act now, no stall window ──────────────────────────
  const hoursSinceIssue = hoursBetween(order.lastVendorUpdatedAt ?? order.installScheduledAt, now);
  const recentlyBroken = hoursSinceIssue != null && hoursSinceIssue <= policy.urgentRecentIssueHours;

  switch (order.normalizedStatus) {
    case "failed_install":
      return {
        open: true, reason: "failed_install",
        priority: recentlyBroken ? "urgent" : "high",
        daysStalled: wholeDaysBetween(order.lastVendorUpdatedAt ?? order.installScheduledAt, now),
      };
    case "missed_appointment":
      return {
        open: true, reason: "missed_appointment",
        priority: recentlyBroken ? "urgent" : "high",
        daysStalled: wholeDaysBetween(order.installScheduledAt ?? order.lastVendorUpdatedAt, now),
      };
    case "pending_customer_action":
      return {
        open: true, reason: "pending_customer_action", priority: "high",
        daysStalled: wholeDaysBetween(order.lastVendorUpdatedAt ?? order.submittedDate, now),
      };
    case "pending_documents":
      return {
        open: true, reason: "pending_documents", priority: "high",
        daysStalled: wholeDaysBetween(order.lastVendorUpdatedAt ?? order.submittedDate, now),
      };
    case "on_hold":
      return {
        open: true, reason: "on_hold", priority: "medium",
        daysStalled: wholeDaysBetween(order.lastVendorUpdatedAt ?? order.submittedDate, now),
      };
    default:
      break;
  }

  // ── Scheduled but overdue ───────────────────────────────────────────────
  if (order.normalizedStatus === "install_scheduled" && order.installScheduledAt) {
    const daysPast = wholeDaysBetween(order.installScheduledAt, now);
    if (daysPast > policy.installOverdueGraceDays) {
      const hoursPast = hoursBetween(order.installScheduledAt, now);
      return {
        open: true, reason: "install_overdue",
        priority: hoursPast != null && hoursPast <= policy.urgentRecentIssueHours ? "urgent" : "high",
        daysStalled: daysPast,
      };
    }
    // Still in the future or inside the grace window. The install-reminder
    // sequence handles these; there is nothing to recover yet.
    return { open: false, ineligible: "NO_TRIGGER" };
  }

  // ── A provider reason that says a human can fix it ──────────────────────
  // Checked before the stall windows so an order the provider flagged today is
  // not left sitting for a week first.
  if (reasonText.trim() && matchesAny(reasonText, policy.vendorRecoverableReasonHints)) {
    return {
      open: true, reason: "vendor_recoverable_flag", priority: "medium",
      daysStalled: wholeDaysBetween(order.lastVendorUpdatedAt ?? order.submittedDate, now),
    };
  }

  // ── Stalls ──────────────────────────────────────────────────────────────
  // Measured from the last time ANYTHING moved, not from submission: an order
  // the provider updated yesterday is not stalled, whatever its age.
  const lastMovement = order.lastVendorUpdatedAt ?? order.submittedDate;
  const stalledDays = wholeDaysBetween(lastMovement, now);

  if (order.normalizedStatus === "accepted" && !order.installScheduledAt) {
    if (stalledDays >= policy.acceptedNoScheduleDays && lastMovement) {
      return { open: true, reason: "stale_accepted", priority: "medium", daysStalled: stalledDays };
    }
    return { open: false, ineligible: "NO_TRIGGER" };
  }

  if (order.normalizedStatus === "submitted") {
    if (stalledDays >= policy.staleSubmittedDays && lastMovement) {
      return { open: true, reason: "stale_submitted", priority: "medium", daysStalled: stalledDays };
    }
    return { open: false, ineligible: "NO_TRIGGER" };
  }

  // `unknown` deliberately falls through. An unrecognised provider status
  // drives no automatic action - it is shown for review and mapped by a human.
  return { open: false, ineligible: "NO_TRIGGER" };
}

/**
 * Re-score an already-open case.
 *
 * A case opened as medium a fortnight ago is not still medium. This runs on
 * every evaluation pass so the queue's ordering reflects today, and it only
 * ever raises priority: an admin who deliberately dropped a case to low should
 * not have the engine quietly hand it back.
 */
export function escalatePriority(
  current: RecoveryPriority,
  daysOpen: number,
  scheduledInstallWithinHours: number | null,
  policy: RecoveryPolicy,
): RecoveryPriority {
  let next = current;
  if (scheduledInstallWithinHours != null && scheduledInstallWithinHours <= 48) next = raise(next, "high");
  if (daysOpen >= policy.escalateAfterDaysOpen) next = raise(next, "high");
  return next;
}

function raise(a: RecoveryPriority, b: RecoveryPriority): RecoveryPriority {
  return RECOVERY_PRIORITY_RANK[b] < RECOVERY_PRIORITY_RANK[a] ? b : a;
}

/** Substring match, case-insensitive, over an admin-authored list. Substring
 *  rather than exact because provider reason text is prose: "CX CANCELLED -
 *  MOVING OUT OF AREA" has to match a configured "moving". */
function matchesAny(haystack: string, needles: readonly string[]): boolean {
  if (!haystack.trim() || needles.length === 0) return false;
  const hay = haystack.toLowerCase();
  return needles.some((n) => {
    const needle = String(n).trim().toLowerCase();
    return needle.length > 0 && hay.includes(needle);
  });
}

function hoursBetween(from: Date | null | undefined, to: Date): number | null {
  if (!from || !Number.isFinite(from.getTime())) return null;
  return Math.max(0, (to.getTime() - from.getTime()) / 3_600_000);
}

/** Statuses that need attention right now. Exported so the dashboard's tiles
 *  and the engine agree on what "needs action" counts. */
export function needsAttention(status: NormalizedOrderStatus): boolean {
  return ATTENTION_STATUSES.includes(status);
}
