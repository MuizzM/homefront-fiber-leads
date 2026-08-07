// The pure referral rules. Weighted toward the three things that decide whether
// the program is safe to run: qualification that cannot be gamed, a checklist
// that cannot disagree with the award rule, and a referrer that cannot be
// re-pointed once money is committed.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REFERRAL_CONFIG, canReferralTransition, isReferralLive, isReferralCommitted,
  referralStageIndex, evaluateQualification, rewardReleasable, attributionExpired,
  referralCodeFrom, normalizeReferralCode, referralUrl, rejectAttribution,
  canChangeReferrer, validateReferralConfig, REFERRAL_CODE_LENGTH,
  type ReferralFacts, type AttributionCandidate,
} from "@shared/referral";

const CONFIG = { ...DEFAULT_REFERRAL_CONFIG, enabled: true };
const HIRED = "2026-06-01T00:00:00.000Z";
const NOW = "2026-08-06T00:00:00.000Z";

const facts = (over: Partial<ReferralFacts> = {}): ReferralFacts => ({
  hiredAt: HIRED, activatedAt: "2026-06-05T00:00:00.000Z",
  approvedSalesCount: 6, trainingComplete: true, repActive: true,
  thresholdReachedAt: null, ...over,
});

describe("the recommended default rule", () => {
  it("is $500 for 6 approved sales, and ships disabled", () => {
    expect(DEFAULT_REFERRAL_CONFIG.rewardCents).toBe(50_000);
    expect(DEFAULT_REFERRAL_CONFIG.requiredApprovedSales).toBe(6);
    expect(DEFAULT_REFERRAL_CONFIG.requireTrainingComplete).toBe(true);
    expect(DEFAULT_REFERRAL_CONFIG.requireActiveStatus).toBe(true);
    // Dark by default: deploying the feature creates no liability anywhere.
    expect(DEFAULT_REFERRAL_CONFIG.enabled).toBe(false);
  });

  it("refuses a config that would pay for a signup", () => {
    // A zero-sale threshold is what turns referral fraud from possible into
    // profitable.
    expect(validateReferralConfig({ requiredApprovedSales: 0 }).join()).toMatch(/at least 1/);
    expect(validateReferralConfig({ rewardCents: -1 }).join()).toMatch(/rewardCents/);
    expect(validateReferralConfig({ requiredApprovedSales: 6, rewardCents: 50_000 })).toEqual([]);
  });
});

describe("status machine", () => {
  it("walks the documented funnel", () => {
    const path = ["CLICKED", "APPLIED", "HIRED", "ACTIVATED", "IN_PROGRESS", "QUALIFIED", "REWARD_PENDING", "APPROVED", "PAID"] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canReferralTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("never reinstates a terminal referral", () => {
    // Un-rejecting by status flip would erase why it was rejected. A second
    // chance is a NEW referral with its own audit trail.
    for (const terminal of ["REJECTED", "EXPIRED", "CLAWED_BACK"] as const) {
      expect(canReferralTransition(terminal, "APPLIED")).toBe(false);
      expect(canReferralTransition(terminal, "QUALIFIED")).toBe(false);
    }
  });

  it("reverses paid money only through CLAWED_BACK", () => {
    expect(canReferralTransition("PAID", "CLAWED_BACK")).toBe(true);
    expect(canReferralTransition("PAID", "REJECTED")).toBe(false);
    expect(canReferralTransition("PAID", "REWARD_PENDING")).toBe(false);
  });

  it("knows which states are live and which have committed money", () => {
    expect(isReferralLive("IN_PROGRESS")).toBe(true);
    expect(isReferralLive("PAID")).toBe(false);
    expect(isReferralCommitted("APPROVED")).toBe(true);
    expect(isReferralCommitted("PAID")).toBe(true);
    expect(isReferralCommitted("REWARD_PENDING")).toBe(false);
  });

  it("orders the funnel for a progress bar", () => {
    expect(referralStageIndex("CLICKED")).toBe(0);
    expect(referralStageIndex("QUALIFIED")).toBeGreaterThan(referralStageIndex("ACTIVATED"));
    expect(referralStageIndex("REJECTED")).toBe(-1);
  });
});

describe("qualification", () => {
  it("qualifies on the sixth approved sale with everything else met", () => {
    const r = evaluateQualification(facts(), CONFIG, NOW);
    expect(r.qualified).toBe(true);
    expect(r.salesRemaining).toBe(0);
    expect(r.progress).toBe(1);
  });

  it("does NOT qualify on the fifth", () => {
    const r = evaluateQualification(facts({ approvedSalesCount: 5 }), CONFIG, NOW);
    expect(r.qualified).toBe(false);
    expect(r.salesRemaining).toBe(1);
  });

  it("reports the checklist the rep sees — 3 of 6, not just false", () => {
    // The progress display and the award rule come from this one call, which is
    // what stops the dashboard promising a reward approval then refuses.
    const r = evaluateQualification(facts({ approvedSalesCount: 3 }), CONFIG, NOW);
    const sales = r.requirements.find(x => x.key === "sales")!;
    expect(sales.current).toBe(3);
    expect(sales.target).toBe(6);
    expect(sales.met).toBe(false);
    expect(r.progress).toBeCloseTo(0.5);
  });

  it("caps the displayed count at the target so it never reads '8 of 6'", () => {
    const r = evaluateQualification(facts({ approvedSalesCount: 8 }), CONFIG, NOW);
    expect(r.requirements.find(x => x.key === "sales")!.current).toBe(6);
    expect(r.progress).toBe(1);
  });

  it("blocks on incomplete training", () => {
    const r = evaluateQualification(facts({ trainingComplete: false }), CONFIG, NOW);
    expect(r.qualified).toBe(false);
    expect(r.requirements.find(x => x.key === "training")!.met).toBe(false);
  });

  it("blocks on an inactive rep", () => {
    expect(evaluateQualification(facts({ repActive: false }), CONFIG, NOW).qualified).toBe(false);
  });

  it("blocks when the rep was never hired or never activated", () => {
    expect(evaluateQualification(facts({ hiredAt: null }), CONFIG, NOW).qualified).toBe(false);
    expect(evaluateQualification(facts({ activatedAt: null }), CONFIG, NOW).qualified).toBe(false);
  });

  it("expires when the sales land outside the qualification window", () => {
    const late = "2027-06-01T00:00:00.000Z"; // a year after hire, window is 180d
    const r = evaluateQualification(facts(), CONFIG, late);
    expect(r.qualified).toBe(false);
    // "Never" is a different fact from "not yet", and the UI must say so.
    expect(r.blocked).toBe("window_expired");
  });

  it("measures the window from HIRE, not from the click", () => {
    // The referrer's job ends at hire; a slow hiring process must not eat the
    // referred rep's clock.
    const r = evaluateQualification(facts({ hiredAt: "2026-08-01T00:00:00.000Z" }), CONFIG, NOW);
    expect(r.requirements.find(x => x.key === "window")!.met).toBe(true);
  });

  it("honours an org that turns the extra requirements off", () => {
    const relaxed = { ...CONFIG, requireTrainingComplete: false, requireActiveStatus: false, qualificationWindowDays: 0 };
    const r = evaluateQualification(facts({ trainingComplete: false, repActive: false }), relaxed, "2030-01-01T00:00:00.000Z");
    expect(r.qualified).toBe(true);
    expect(r.requirements.map(x => x.key)).not.toContain("training");
  });
});

describe("the clawback holding window", () => {
  it("holds the reward until the window closes", () => {
    // A reward paid the instant the sixth sale lands is a reward paid on sales
    // that may not survive the month.
    const justQualified = rewardReleasable(NOW, CONFIG, NOW);
    expect(justQualified.releasable).toBe(false);
    expect(justQualified.daysRemaining).toBe(30);
  });

  it("releases once the window has passed", () => {
    const later = "2026-09-10T00:00:00.000Z"; // 35 days after NOW
    expect(rewardReleasable(NOW, CONFIG, later).releasable).toBe(true);
  });

  it("releases immediately when an org configures no window", () => {
    expect(rewardReleasable(NOW, { ...CONFIG, clawbackWindowDays: 0 }, NOW).releasable).toBe(true);
  });

  it("is never releasable before qualification", () => {
    expect(rewardReleasable(null, CONFIG, NOW).releasable).toBe(false);
  });
});

describe("referral codes", () => {
  it("avoids every confusable glyph", () => {
    const code = referralCodeFrom(new Uint8Array(Array.from({ length: 16 }, (_, i) => i * 7)));
    expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
    // A code is read aloud and written on a napkin. 0/O and 1/I/L are how an
    // attribution lands on nobody.
    expect(code).not.toMatch(/[01OIL]/);
  });

  it("is deterministic given the same bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(referralCodeFrom(bytes)).toBe(referralCodeFrom(bytes));
  });

  it("normalizes what a person actually types", () => {
    const code = referralCodeFrom(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(normalizeReferralCode(code.toLowerCase())).toBe(code);
    expect(normalizeReferralCode(` ${code.slice(0, 4)}-${code.slice(4)} `)).toBe(code);
  });

  it("rejects anything that cannot be a code, without a database lookup", () => {
    expect(normalizeReferralCode("SHORT")).toBeNull();
    expect(normalizeReferralCode("AAAAAAA0")).toBeNull(); // 0 is not in the alphabet
    expect(normalizeReferralCode(null)).toBeNull();
  });

  it("builds a shareable link", () => {
    expect(referralUrl("https://app.example.com/", "ABCD2345")).toBe("https://app.example.com/join?ref=ABCD2345");
  });
});

describe("anti-fraud", () => {
  const candidate = (over: Partial<AttributionCandidate> = {}): AttributionCandidate => ({
    referrerRepId: 10, referrerActive: true,
    applicantEmail: "new.person@example.com", referrerEmail: "rep@example.com",
    applicantAlreadyHasAccount: false, applicantAlreadyReferred: false,
    linkCreatedAt: "2026-08-01T00:00:00.000Z", ...over,
  });

  it("accepts a clean attribution", () => {
    expect(rejectAttribution(candidate(), CONFIG, NOW)).toBeNull();
  });

  it("refuses a self-referral", () => {
    expect(rejectAttribution(candidate({ applicantEmail: "rep@example.com" }), CONFIG, NOW)).toBe("self_referral");
  });

  it("refuses an existing user — the referred person must be NEW", () => {
    expect(rejectAttribution(candidate({ applicantAlreadyHasAccount: true }), CONFIG, NOW)).toBe("existing_user");
  });

  it("refuses a second referral for the same applicant", () => {
    expect(rejectAttribution(candidate({ applicantAlreadyReferred: true }), CONFIG, NOW)).toBe("already_referred");
  });

  it("refuses an offboarded referrer", () => {
    expect(rejectAttribution(candidate({ referrerActive: false }), CONFIG, NOW)).toBe("referrer_inactive");
  });

  it("refuses everything while the program is off", () => {
    expect(rejectAttribution(candidate(), { ...CONFIG, enabled: false }, NOW)).toBe("program_disabled");
  });

  it("expires a stale link", () => {
    const old = "2026-01-01T00:00:00.000Z"; // >90d before NOW
    expect(rejectAttribution(candidate({ linkCreatedAt: old }), CONFIG, NOW)).toBe("attribution_expired");
    expect(attributionExpired(old, CONFIG, NOW)).toBe(true);
  });

  it("reports self-referral ahead of the vaguer reasons", () => {
    // Someone gaming their own link should be told exactly that.
    const both = candidate({ applicantEmail: "rep@example.com", applicantAlreadyReferred: true });
    expect(rejectAttribution(both, CONFIG, NOW)).toBe("self_referral");
  });
});

describe("changing the referrer", () => {
  it("is free before the referred person is hired", () => {
    expect(canChangeReferrer("APPLIED", false).allowed).toBe(true);
  });

  it("needs an admin once they are hired", () => {
    expect(canChangeReferrer("HIRED", false).allowed).toBe(false);
    expect(canChangeReferrer("HIRED", true).allowed).toBe(true);
    expect(canChangeReferrer("IN_PROGRESS", false).reason).toMatch(/admin/);
  });

  it("is refused outright once the money is committed — even for an admin", () => {
    // A referrer that can be re-pointed after approval is a reward that can be
    // redirected to whoever asks last.
    expect(canChangeReferrer("APPROVED", true).allowed).toBe(false);
    expect(canChangeReferrer("PAID", true).allowed).toBe(false);
  });
});
