import { describe, it, expect } from "vitest";
import {
  canPayoutTransition, isActivePayout, onboardingStatusFrom, payoutEligibility,
  classifyConnectEvent, formatMoney, type OnboardingStatus,
} from "../../shared/payouts";

describe("payout status machine", () => {
  it("permits the documented transitions + self-loops, blocks the rest", () => {
    expect(canPayoutTransition("pending", "paid")).toBe(true);
    expect(canPayoutTransition("pending", "failed")).toBe(true);
    expect(canPayoutTransition("failed", "paid")).toBe(true);   // retry succeeds
    expect(canPayoutTransition("paid", "reversed")).toBe(true);
    expect(canPayoutTransition("paid", "pending")).toBe(false); // can't un-pay
    expect(canPayoutTransition("reversed", "paid")).toBe(false);
    expect(canPayoutTransition("paid", "paid")).toBe(true);
  });
  it("isActivePayout blocks a duplicate for pending/processing/paid only", () => {
    expect(isActivePayout("pending")).toBe(true);
    expect(isActivePayout("processing")).toBe(true);
    expect(isActivePayout("paid")).toBe(true);
    expect(isActivePayout("failed")).toBe(false);   // retriable
    expect(isActivePayout("reversed")).toBe(false);
  });
});

describe("onboardingStatusFrom", () => {
  it("enabled only when payouts_enabled; else restricted/pending/none", () => {
    expect(onboardingStatusFrom({ payoutsEnabled: true })).toBe("enabled");
    expect(onboardingStatusFrom({ payoutsEnabled: false, disabledReason: "requirements.past_due" })).toBe("restricted");
    expect(onboardingStatusFrom({ payoutsEnabled: false, detailsSubmitted: true })).toBe("pending");
    expect(onboardingStatusFrom({})).toBe("none");
  });
});

describe("payoutEligibility — the pay guard", () => {
  const base = (over: Partial<Parameters<typeof payoutEligibility>[0]> = {}) =>
    payoutEligibility({ statementStatus: "FINALIZED", finalCents: 1000, onboardingStatus: "enabled", existingPayoutStatus: null, ...over });

  it("eligible: finalized + positive + enabled + not already paid", () => {
    expect(base()).toEqual({ eligible: true, reason: null });
  });
  it("blocks a non-finalized week", () => {
    expect(base({ statementStatus: "OPEN" })).toEqual({ eligible: false, reason: "not_finalized" });
    expect(base({ statementStatus: "REVIEW" })).toEqual({ eligible: false, reason: "not_finalized" });
  });
  it("blocks an already-PAID statement (and an active existing payout)", () => {
    expect(base({ statementStatus: "PAID" })).toEqual({ eligible: false, reason: "already_paid" });
    expect(base({ existingPayoutStatus: "paid" })).toEqual({ eligible: false, reason: "already_paid" });
    expect(base({ existingPayoutStatus: "pending" })).toEqual({ eligible: false, reason: "already_paid" });
  });
  it("allows a retry when the prior payout FAILED", () => {
    expect(base({ existingPayoutStatus: "failed" })).toEqual({ eligible: true, reason: null });
  });
  it("blocks zero / negative amounts", () => {
    expect(base({ finalCents: 0 }).reason).toBe("no_amount");
    expect(base({ finalCents: -5 }).reason).toBe("no_amount");
  });
  it("blocks reps who haven't onboarded / aren't payout-enabled", () => {
    const cases: Array<[OnboardingStatus, string]> = [["none", "not_onboarded"], ["pending", "payouts_disabled"], ["restricted", "payouts_disabled"]];
    for (const [status, reason] of cases) expect(base({ onboardingStatus: status }).reason).toBe(reason);
  });
});

describe("classifyConnectEvent", () => {
  it("account.updated → onboarding facts", () => {
    const i = classifyConnectEvent({ id: "e", type: "account.updated", account: "acct_1",
      data: { object: { id: "acct_1", payouts_enabled: true, charges_enabled: true, details_submitted: true } } });
    expect(i.kind).toBe("account_updated");
    expect(i.accountId).toBe("acct_1");
    expect(i.facts?.payoutsEnabled).toBe(true);
    expect(onboardingStatusFrom(i.facts!)).toBe("enabled");
  });
  it("transfer.reversed → transfer_reversed with the transfer id", () => {
    const i = classifyConnectEvent({ id: "e", type: "transfer.reversed", account: "acct_1", data: { object: { id: "tr_1" } } });
    expect(i.kind).toBe("transfer_reversed");
    expect(i.transferId).toBe("tr_1");
  });
  it("payout.* on the connected account are informational; unknowns ignored", () => {
    expect(classifyConnectEvent({ id: "e", type: "payout.paid", account: "a", data: { object: {} } }).kind).toBe("bank_payout_paid");
    expect(classifyConnectEvent({ id: "e", type: "payout.failed", account: "a", data: { object: {} } }).kind).toBe("bank_payout_failed");
    expect(classifyConnectEvent({ id: "e", type: "charge.succeeded", data: { object: {} } }).kind).toBe("ignore");
  });
});

describe("formatMoney", () => {
  it("cents → USD string", () => {
    expect(formatMoney(124000)).toBe("$1,240.00");
    expect(formatMoney(0)).toBe("$0.00");
  });
});
