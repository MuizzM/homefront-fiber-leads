import { describe, it, expect } from "vitest";
import {
  PLANS, planHasFeature, canTransition, isScanningAllowed, portalAccess,
  creditsRemaining, usageFraction, usageLevel, consumeCredit, resetCycle,
  isBillingState, isOverageMode, BILLING_STATES, OVERAGE_MODES,
  type CreditState, type BillingState,
} from "../../shared/billing";

// Base credit state helper — starter plan, active, 100 included, nothing used.
const base = (over: Partial<CreditState> = {}): CreditState => ({
  planKey: "starter", state: "active", included: 100, used: 0, rollover: 0,
  purchased: 0, overageUsed: 0, overageMode: "stop", unlimited: false, ...over,
});

describe("plan catalog", () => {
  it("has all four tiers with additive features", () => {
    expect(Object.keys(PLANS)).toEqual(["starter", "growth", "professional", "enterprise"]);
    // Feature sets grow up the tiers.
    expect(planHasFeature("starter", "csv_export")).toBe(true);
    expect(planHasFeature("starter", "advanced_analytics")).toBe(false);
    expect(planHasFeature("professional", "advanced_analytics")).toBe(true);
    expect(planHasFeature("enterprise", "sso")).toBe(true);
    expect(planHasFeature("professional", "sso")).toBe(false);
  });
  it("enterprise is unlimited/custom (null credits + seats), prices unset", () => {
    expect(PLANS.enterprise.monthlyCredits).toBeNull();
    expect(PLANS.enterprise.seats).toBeNull();
    for (const p of Object.values(PLANS)) expect(p.monthlyPriceUsd).toBeNull(); // owner sets later
  });
});

describe("billing state machine", () => {
  it("permits the documented transitions and self-loops", () => {
    expect(canTransition("trial", "active")).toBe(true);
    expect(canTransition("active", "past_due")).toBe(true);
    expect(canTransition("past_due", "active")).toBe(true);      // recovery
    expect(canTransition("past_due", "suspended")).toBe(true);   // dunning exhausted
    expect(canTransition("suspended", "active")).toBe(true);     // reactivate
    expect(canTransition("canceled", "active")).toBe(true);      // reactivate
    expect(canTransition("active", "active")).toBe(true);        // idempotent self
  });
  it("rejects illegal jumps", () => {
    expect(canTransition("active", "suspended")).toBe(false);    // must pass through past_due
    expect(canTransition("suspended", "past_due")).toBe(false);
    expect(canTransition("trial", "trial")).toBe(true);          // self is allowed
    expect(canTransition("canceled", "past_due")).toBe(false);
  });
  it("scanning + portal access follow state", () => {
    const scanning: BillingState[] = ["trial", "active", "past_due"];
    for (const s of scanning) expect(isScanningAllowed(s)).toBe(true);
    expect(isScanningAllowed("suspended")).toBe(false);
    expect(isScanningAllowed("canceled")).toBe(false);
    expect(portalAccess("active")).toBe("full");
    expect(portalAccess("past_due")).toBe("full");   // grace: still full access
    expect(portalAccess("suspended")).toBe("paywall");
    expect(portalAccess("canceled")).toBe("blocked");
  });
});

describe("runtime input validators (guard untrusted route/adapter input)", () => {
  it("isBillingState accepts only the five states", () => {
    expect(BILLING_STATES).toHaveLength(5);
    for (const s of BILLING_STATES) expect(isBillingState(s)).toBe(true);
    // A bogus state must be rejected — otherwise it would persist a tenant into an
    // unrecoverable state (no legal transition escapes it).
    expect(isBillingState("frozen")).toBe(false);
    expect(isBillingState("")).toBe(false);
    expect(isBillingState(null)).toBe(false);
    expect(isBillingState(undefined)).toBe(false);
  });
  it("isOverageMode accepts only the four modes", () => {
    expect(OVERAGE_MODES).toHaveLength(4);
    for (const m of OVERAGE_MODES) expect(isOverageMode(m)).toBe(true);
    expect(isOverageMode("unlimited")).toBe(false);
    expect(isOverageMode(42 as any)).toBe(false);
  });
});

describe("credit accounting", () => {
  it("remaining = included + rollover + purchased − used, floored at 0", () => {
    expect(creditsRemaining(base({ used: 30 }))).toBe(70);
    expect(creditsRemaining(base({ rollover: 20, purchased: 5, used: 30 }))).toBe(95);
    expect(creditsRemaining(base({ used: 999 }))).toBe(0); // never negative
    expect(creditsRemaining(base({ unlimited: true }))).toBe(Infinity);
  });
  it("usage level thresholds (75% warn, 90% critical, 100% exhausted)", () => {
    expect(usageLevel(base({ used: 10 }))).toBe("ok");
    expect(usageLevel(base({ used: 75 }))).toBe("warn");
    expect(usageLevel(base({ used: 90 }))).toBe("critical");
    expect(usageLevel(base({ used: 100 }))).toBe("exhausted");
    expect(usageFraction(base({ used: 50 }))).toBeCloseTo(0.5);
    expect(usageLevel(base({ unlimited: true, used: 1e9 }))).toBe("ok"); // unlimited never warns
  });
  it("zero-allowance cap reads as fully used (avoids divide-by-zero)", () => {
    expect(usageFraction(base({ included: 0 }))).toBe(1);
    expect(usageLevel(base({ included: 0 }))).toBe("exhausted");
  });
});

describe("consumeCredit — the core delivery rule", () => {
  it("delivers + decrements while credits remain", () => {
    const r = consumeCredit(base({ used: 10 }));
    expect(r.delivered).toBe(true);
    expect(r.overage).toBe(false);
    expect(r.next.used).toBe(11);
  });
  it("unlimited always delivers, no overage", () => {
    const r = consumeCredit(base({ unlimited: true, used: 5_000 }));
    expect(r.delivered).toBe(true);
    expect(r.overage).toBe(false);
    expect(r.next.used).toBe(5_001);
  });
  it("STOP mode blocks delivery once the allowance is spent", () => {
    const r = consumeCredit(base({ used: 100, overageMode: "stop" }));
    expect(r.delivered).toBe(false);
    expect(r.next.used).toBe(100); // unchanged — nothing charged
    expect(r.reason).toMatch(/limit/i);
  });
  it("ALLOW_OVERAGE delivers past the cap and counts overage", () => {
    const r = consumeCredit(base({ used: 100, overageMode: "allow_overage" }));
    expect(r.delivered).toBe(true);
    expect(r.overage).toBe(true);
    expect(r.next.used).toBe(101);
    expect(r.next.overageUsed).toBe(1);
  });
  it("REQUIRE_APPROVAL pauses delivery and flags for approval", () => {
    const r = consumeCredit(base({ used: 100, overageMode: "require_approval" }));
    expect(r.delivered).toBe(false);
    expect(r.requiresApproval).toBe(true);
    expect(r.next.used).toBe(100);
  });
  it("a non-delivering billing state never consumes (suspended/canceled)", () => {
    for (const s of ["suspended", "canceled"] as BillingState[]) {
      const r = consumeCredit(base({ state: s, used: 0 }));
      expect(r.delivered).toBe(false);
      expect(r.next.used).toBe(0);
    }
  });
});

describe("resetCycle", () => {
  it("rolls unused credits when allowed, else drops them; clears usage", () => {
    const spent = base({ used: 40, purchased: 10, overageUsed: 3 }); // remaining 70
    const rolled = resetCycle(spent, true);
    expect(rolled.used).toBe(0);
    expect(rolled.purchased).toBe(0);
    expect(rolled.overageUsed).toBe(0);
    expect(rolled.rollover).toBe(70);           // carried forward
    expect(rolled.included).toBe(PLANS.starter.monthlyCredits);

    const dropped = resetCycle(spent, false);
    expect(dropped.rollover).toBe(0);           // use-it-or-lose-it
  });
  it("unlimited plan never rolls Infinity into a finite counter", () => {
    const r = resetCycle(base({ unlimited: true, planKey: "enterprise", used: 9 }), true);
    expect(Number.isFinite(r.rollover)).toBe(true);
    expect(r.rollover).toBe(0);
  });
});
