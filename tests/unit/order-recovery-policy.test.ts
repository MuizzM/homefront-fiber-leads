// ── The recovery decision, pinned ────────────────────────────────────────────
//
// evaluateRecovery decides who gets a phone call. The refusals are the
// load-bearing half: an installed order that opens a case wastes a morning, but
// an opted-out customer that opens a case puts a number in front of somebody
// who asked us to stop.
//
// So the first block below is entirely about what must NEVER open a case, and
// each refusal is asserted against a candidate that would otherwise sail
// through - the failure mode being guarded is a rule that only works when the
// other rules also happen to say no.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECOVERY_POLICY, RECOVERED_RESOLUTIONS, escalatePriority, evaluateRecovery,
  isRecoveredResolution, resolveRecoveryPolicy,
  type RecoveryCandidate, type RecoveryPolicy,
} from "@shared/orderRecovery";

const NOW = new Date("2026-08-11T15:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

/** A candidate that WOULD open a case: failed install, matched, nothing
 *  blocking. Every refusal test starts from this so the refusal is the only
 *  thing doing the work. */
function candidate(over: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    normalizedStatus: "failed_install",
    submittedDate: daysAgo(20),
    installScheduledAt: daysAgo(2),
    installDate: null,
    cancellationDate: null,
    failureReason: "Technician could not access the unit",
    requiredCustomerAction: null,
    lastVendorUpdatedAt: hoursAgo(10),
    identityResolved: true,
    commissionPaid: false,
    knownFraudulent: false,
    doNotContact: false,
    optedOutEverywhere: false,
    hasActiveCase: false,
    ...over,
  };
}

const policy: RecoveryPolicy = { ...DEFAULT_RECOVERY_POLICY };

describe("what must never open a case", () => {
  it("refuses an installed order", () => {
    const d = evaluateRecovery(candidate({ normalizedStatus: "installed", installDate: daysAgo(1) }), policy, NOW);
    expect(d).toEqual({ open: false, ineligible: "INSTALLED" });
  });

  it("refuses an order whose commission has been paid", () => {
    const d = evaluateRecovery(candidate({ commissionPaid: true }), policy, NOW);
    expect(d).toEqual({ open: false, ineligible: "COMMISSION_PAID" });
  });

  it("refuses a known fraudulent order", () => {
    const d = evaluateRecovery(candidate({ knownFraudulent: true }), policy, NOW);
    expect(d).toEqual({ open: false, ineligible: "KNOWN_FRAUD" });
  });

  it("refuses a do-not-contact household", () => {
    const d = evaluateRecovery(candidate({ doNotContact: true }), policy, NOW);
    expect(d).toEqual({ open: false, ineligible: "DO_NOT_CONTACT" });
  });

  it("refuses a customer who opted out of every channel", () => {
    const d = evaluateRecovery(candidate({ optedOutEverywhere: true }), policy, NOW);
    expect(d).toEqual({ open: false, ineligible: "OPTED_OUT" });
  });

  it("refuses an order that is not matched to a sale", () => {
    const d = evaluateRecovery(candidate({ identityResolved: false }), policy, NOW);
    expect(d).toEqual({ open: false, ineligible: "IDENTITY_UNRESOLVED" });
  });

  it("refuses a reason the organization marked non-recoverable", () => {
    const d = evaluateRecovery(
      candidate({ failureReason: "Duplicate order - already installed under another account" }),
      policy, NOW,
    );
    expect(d).toEqual({ open: false, ineligible: "NON_RECOVERABLE_REASON" });
  });

  it("refuses to open a second case for the same order", () => {
    const d = evaluateRecovery(candidate({ hasActiveCase: true }), policy, NOW);
    expect(d).toEqual({ open: false, ineligible: "ALREADY_HAS_CASE" });
  });

  it("checks the refusals in an order where fraud beats everything else", () => {
    // Every refusal at once. The FIRST one wins, so a reader of the queue's
    // audit trail always sees the most serious reason rather than whichever
    // check happened to run last.
    const d = evaluateRecovery(
      candidate({ knownFraudulent: true, doNotContact: true, optedOutEverywhere: true, identityResolved: false }),
      policy, NOW,
    );
    expect(d).toEqual({ open: false, ineligible: "KNOWN_FRAUD" });
  });
});

describe("cancellations", () => {
  const canceled = (over: Partial<RecoveryCandidate> = {}) => candidate({
    normalizedStatus: "canceled",
    cancellationDate: daysAgo(3),
    failureReason: "Customer cancelled - moving out of area",
    installScheduledAt: null,
    ...over,
  });

  it("refuses by default, because no reason is configured as recoverable", () => {
    const d = evaluateRecovery(canceled(), policy, NOW);
    expect(d).toEqual({ open: false, ineligible: "CANCELLATION_NOT_RECOVERABLE" });
  });

  it("opens at low priority when the reason is on the recoverable list", () => {
    const withList = { ...policy, recoverableCancellationReasons: ["moving"] };
    const d = evaluateRecovery(canceled(), withList, NOW);
    expect(d).toMatchObject({ open: true, reason: "recoverable_cancellation", priority: "low" });
  });

  it("refuses once the recovery window has closed", () => {
    const withList = { ...policy, recoverableCancellationReasons: ["moving"], cancellationRecoveryWindowDays: 2 };
    const d = evaluateRecovery(canceled(), withList, NOW);
    expect(d).toEqual({ open: false, ineligible: "CANCELLATION_WINDOW_CLOSED" });
  });

  it("lets the non-recoverable list win over the recoverable one", () => {
    const both = {
      ...policy,
      recoverableCancellationReasons: ["cancel"],
      nonRecoverableReasons: ["moving"],
    };
    const d = evaluateRecovery(canceled(), both, NOW);
    expect(d).toEqual({ open: false, ineligible: "NON_RECOVERABLE_REASON" });
  });

  it("never auto-opens a rejection", () => {
    const d = evaluateRecovery(candidate({ normalizedStatus: "rejected", failureReason: "Credit decline" }), policy, NOW);
    expect(d).toEqual({ open: false, ineligible: "NO_TRIGGER" });
  });
});

describe("priority", () => {
  it("makes a fresh failed install urgent and an old one high", () => {
    expect(evaluateRecovery(candidate({ lastVendorUpdatedAt: hoursAgo(10) }), policy, NOW))
      .toMatchObject({ open: true, reason: "failed_install", priority: "urgent" });
    expect(evaluateRecovery(candidate({ lastVendorUpdatedAt: daysAgo(9) }), policy, NOW))
      .toMatchObject({ open: true, reason: "failed_install", priority: "high" });
  });

  it("makes a missed appointment urgent while it is still fresh", () => {
    const d = evaluateRecovery(
      candidate({ normalizedStatus: "missed_appointment", installScheduledAt: hoursAgo(20), lastVendorUpdatedAt: hoursAgo(20) }),
      policy, NOW,
    );
    expect(d).toMatchObject({ open: true, reason: "missed_appointment", priority: "urgent" });
  });

  it("puts customer action and missing documents at high", () => {
    for (const status of ["pending_customer_action", "pending_documents"] as const) {
      const d = evaluateRecovery(
        candidate({ normalizedStatus: status, failureReason: null, installScheduledAt: null, lastVendorUpdatedAt: daysAgo(4) }),
        policy, NOW,
      );
      expect(d).toMatchObject({ open: true, priority: "high" });
    }
  });

  it("puts an on-hold order at medium", () => {
    const d = evaluateRecovery(
      candidate({ normalizedStatus: "on_hold", failureReason: null, installScheduledAt: null, lastVendorUpdatedAt: daysAgo(4) }),
      policy, NOW,
    );
    expect(d).toMatchObject({ open: true, reason: "on_hold", priority: "medium" });
  });
});

describe("stalls", () => {
  it("does not open a submitted order until the window passes", () => {
    const fresh = candidate({
      normalizedStatus: "submitted", failureReason: null, requiredCustomerAction: null,
      installScheduledAt: null, submittedDate: daysAgo(3), lastVendorUpdatedAt: daysAgo(3),
    });
    expect(evaluateRecovery(fresh, policy, NOW)).toEqual({ open: false, ineligible: "NO_TRIGGER" });

    const stale = { ...fresh, submittedDate: daysAgo(20), lastVendorUpdatedAt: daysAgo(20) };
    expect(evaluateRecovery(stale, policy, NOW))
      .toMatchObject({ open: true, reason: "stale_submitted", priority: "medium", daysStalled: 20 });
  });

  it("measures the stall from the last provider update, not from submission", () => {
    // Submitted six weeks ago, but the provider touched it yesterday. Nothing
    // is stalled: somebody is working it.
    const moving = candidate({
      normalizedStatus: "submitted", failureReason: null, requiredCustomerAction: null,
      installScheduledAt: null, submittedDate: daysAgo(42), lastVendorUpdatedAt: daysAgo(1),
    });
    expect(evaluateRecovery(moving, policy, NOW)).toEqual({ open: false, ineligible: "NO_TRIGGER" });
  });

  it("opens an accepted order with no install date after the configured days", () => {
    const accepted = candidate({
      normalizedStatus: "accepted", failureReason: null, requiredCustomerAction: null,
      installScheduledAt: null, submittedDate: daysAgo(10), lastVendorUpdatedAt: daysAgo(10),
    });
    expect(evaluateRecovery(accepted, policy, NOW))
      .toMatchObject({ open: true, reason: "stale_accepted", priority: "medium" });
  });

  it("leaves an accepted order alone once an install is booked", () => {
    const booked = candidate({
      normalizedStatus: "accepted", failureReason: null, requiredCustomerAction: null,
      installScheduledAt: new Date(NOW.getTime() + 3 * 86_400_000),
      submittedDate: daysAgo(10), lastVendorUpdatedAt: daysAgo(10),
    });
    expect(evaluateRecovery(booked, policy, NOW)).toEqual({ open: false, ineligible: "NO_TRIGGER" });
  });
});

describe("scheduled installs", () => {
  it("leaves a future appointment alone", () => {
    const future = candidate({
      normalizedStatus: "install_scheduled", failureReason: null,
      installScheduledAt: new Date(NOW.getTime() + 2 * 86_400_000),
    });
    expect(evaluateRecovery(future, policy, NOW)).toEqual({ open: false, ineligible: "NO_TRIGGER" });
  });

  it("leaves an appointment inside the grace window alone", () => {
    const yesterday = candidate({
      normalizedStatus: "install_scheduled", failureReason: null, installScheduledAt: hoursAgo(20),
    });
    expect(evaluateRecovery(yesterday, policy, NOW)).toEqual({ open: false, ineligible: "NO_TRIGGER" });
  });

  it("opens an overdue install as urgent while it is fresh", () => {
    const overdue = candidate({
      normalizedStatus: "install_scheduled", failureReason: null, installScheduledAt: hoursAgo(50),
    });
    expect(evaluateRecovery(overdue, policy, NOW))
      .toMatchObject({ open: true, reason: "install_overdue", priority: "urgent", daysStalled: 2 });
  });

  it("drops an old overdue install to high", () => {
    const old = candidate({
      normalizedStatus: "install_scheduled", failureReason: null, installScheduledAt: daysAgo(15),
    });
    expect(evaluateRecovery(old, policy, NOW))
      .toMatchObject({ open: true, reason: "install_overdue", priority: "high" });
  });
});

describe("provider reason hints", () => {
  it("opens a case for a healthy-looking status whose reason says a human can fix it", () => {
    const flagged = candidate({
      normalizedStatus: "submitted",
      failureReason: "Unable to reach customer to confirm gate code",
      installScheduledAt: null, submittedDate: daysAgo(2), lastVendorUpdatedAt: daysAgo(2),
    });
    expect(evaluateRecovery(flagged, policy, NOW))
      .toMatchObject({ open: true, reason: "vendor_recoverable_flag", priority: "medium" });
  });

  it("leaves an unknown status alone entirely", () => {
    const unknown = candidate({
      normalizedStatus: "unknown", failureReason: null, requiredCustomerAction: null,
      installScheduledAt: null, submittedDate: daysAgo(90), lastVendorUpdatedAt: daysAgo(90),
    });
    expect(evaluateRecovery(unknown, policy, NOW)).toEqual({ open: false, ineligible: "NO_TRIGGER" });
  });
});

describe("escalation", () => {
  it("raises priority but never lowers it", () => {
    expect(escalatePriority("medium", 20, null, policy)).toBe("high");
    expect(escalatePriority("urgent", 20, null, policy)).toBe("urgent");
    expect(escalatePriority("low", 1, 12, policy)).toBe("high");
    expect(escalatePriority("low", 1, null, policy)).toBe("low");
  });
});

describe("policy resolution", () => {
  it("fills every missing knob from the defaults", () => {
    const partial = resolveRecoveryPolicy({ staleSubmittedDays: 3 } as any);
    expect(partial.staleSubmittedDays).toBe(3);
    expect(partial.acceptedNoScheduleDays).toBe(DEFAULT_RECOVERY_POLICY.acceptedNoScheduleDays);
    expect(partial.nonRecoverableReasons).toEqual(DEFAULT_RECOVERY_POLICY.nonRecoverableReasons);
  });

  it("rejects a negative or non-numeric window rather than storing it", () => {
    const bad = resolveRecoveryPolicy({ staleSubmittedDays: -5, urgentRecentIssueHours: "soon" } as any);
    expect(bad.staleSubmittedDays).toBe(DEFAULT_RECOVERY_POLICY.staleSubmittedDays);
    expect(bad.urgentRecentIssueHours).toBe(DEFAULT_RECOVERY_POLICY.urgentRecentIssueHours);
  });

  it("returns a copy, so a caller cannot mutate the shared defaults", () => {
    const a = resolveRecoveryPolicy(null);
    a.nonRecoverableReasons.push("mutated");
    expect(DEFAULT_RECOVERY_POLICY.nonRecoverableReasons).not.toContain("mutated");
  });
});

describe("what counts as recovered", () => {
  it("counts every recovered resolution and nothing else", () => {
    for (const code of RECOVERED_RESOLUTIONS) expect(isRecoveredResolution(code)).toBe(true);
    expect(isRecoveredResolution("not_recoverable_unreachable")).toBe(false);
    expect(isRecoveredResolution("closed_no_action_needed")).toBe(false);
    expect(isRecoveredResolution(null)).toBe(false);
  });
});
