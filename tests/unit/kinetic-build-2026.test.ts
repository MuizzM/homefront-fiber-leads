// Classification: what evidence produces which verdict, and - more important -
// what evidence can NEVER produce confirmed_2026.
//
// The precedence order is the spec. Each block below pins one rule and one
// reason a lower rule is unreachable, so reordering the classifier breaks a
// named test rather than silently changing which doors reps get sent to.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAD_ELIGIBLE_CLASSES,
  KINETIC_BUILD_CLASSES,
  classifyKineticBuild,
  paintTierFor,
  verificationAgeBucket,
  type FccBlockFacts,
  type KineticBuildInput,
} from "@shared/kineticBuild2026";

const NOW = Date.parse("2026-08-10T12:00:00Z");
const ms = (iso: string) => Date.parse(iso);
const daysAgo = (n: number) => NOW - n * 86_400_000;

/** A block the FCC says Kinetic did not serve at all as of D25 - the shape
 *  that supplies the "did not have it before 2026" leg. */
const BLOCK_ABSENT_D25: FccBlockFacts = {
  blockGeoid: "371590501001000",
  firstReportedVintage: null,
  latestVintage: "D25",
  baselineVintage: "J25",
  reportedLocations: 0,
  totalLocations: 24,
  addedLocations: 0,
};

/** A block fully covered by Kinetic well before 2026. */
const BLOCK_COVERED_LONG_AGO: FccBlockFacts = {
  blockGeoid: "371590501001001",
  firstReportedVintage: "J24",
  latestVintage: "D25",
  baselineVintage: "J25",
  reportedLocations: 30,
  totalLocations: 30,
  addedLocations: 0,
};

const liveNow = (overrides: Partial<KineticBuildInput> = {}): KineticBuildInput => ({
  latest: { isFiberLive: true, conclusive: true, observedAtMs: daysAgo(3), billingStatus: "N" },
  firstFiberLiveAtMs: daysAgo(3),
  residential: true,
  nowMs: NOW,
  ...overrides,
});

describe("confirmed_2026 - the only route is a conclusive address-level check", () => {
  it("confirms when fiber is live now and the FCC block was empty through D25", () => {
    const d = classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25 }));
    expect(d.classification).toBe("confirmed_2026");
    expect(d.buildYear).toBe(2026);
    expect(d.leadEligible).toBe(true);
    expect(d.sources).toContain("authorized_kinetic_qualification");
    expect(d.sources).toContain("fcc_D25_block_absent");
  });

  it("does NOT name a quarter from the FCC lower bound alone", () => {
    // Window is 2025-12-31 to 2026-08-07: seven months, three quarters.
    const d = classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25 }));
    expect(d.quarterWhenProven).toBeNull();
    expect(d.reasons.join(" ")).toContain("quarter not established");
  });

  it("names a quarter when two dated address-level observations bracket one", () => {
    const d = classifyKineticBuild(liveNow({
      lastNonFiberAtMs: ms("2026-04-10T00:00:00Z"),
      firstFiberLiveAtMs: ms("2026-05-22T00:00:00Z"),
      latest: { isFiberLive: true, conclusive: true, observedAtMs: daysAgo(2), billingStatus: "N" },
      fcc: BLOCK_ABSENT_D25,
    }));
    expect(d.classification).toBe("confirmed_2026");
    expect(d.quarterWhenProven).toBe("2026Q2");
    expect(d.reasons.join(" ")).toContain("Build proven within 2026Q2");
  });

  it("prefers the address-level lower bound over the block-level one", () => {
    // The block says nothing was served through D25, but we personally
    // observed this door unserved in April 2026 - the tighter, direct bound.
    const d = classifyKineticBuild(liveNow({
      lastNonFiberAtMs: ms("2026-04-10T00:00:00Z"),
      firstFiberLiveAtMs: ms("2026-05-22T00:00:00Z"),
      fcc: BLOCK_ABSENT_D25,
    }));
    expect(d.sources).toContain("authorized_non_fiber_observation");
    expect(d.sources).not.toContain("fcc_D25_block_absent");
    expect(d.detectionWindow!.fromMs).toBe(ms("2026-04-10T00:00:00Z"));
  });

  it("decays to medium then low as the verification ages", () => {
    const at = (days: number) => classifyKineticBuild(liveNow({
      fcc: BLOCK_ABSENT_D25,
      latest: { isFiberLive: true, conclusive: true, observedAtMs: daysAgo(days), billingStatus: "N" },
      firstFiberLiveAtMs: daysAgo(days),
    })).confidence;
    expect(at(5)).toBe("high");
    expect(at(60)).toBe("medium");
    expect(at(200)).toBe("low");
  });
});

describe("what can never become confirmed_2026", () => {
  it("an FCC filing alone cannot - no published vintage can attest to 2026", () => {
    // The strongest FCC evidence available today: a block Kinetic newly lit,
    // diffed across the two newest real filings. Still not a 2026 confirmation.
    const d = classifyKineticBuild({
      residential: true,
      nowMs: NOW,
      fcc: { ...BLOCK_ABSENT_D25, firstReportedVintage: "D25", reportedLocations: 12, addedLocations: 12, totalLocations: 24 },
    });
    expect(d.classification).not.toBe("confirmed_2026");
    expect(d.classification).not.toBe("reported_2026");
    expect(d.classification).toBe("likely_2026");
    expect(d.leadEligible).toBe(false);
  });

  it("a 2025 vintage diff cannot, however recently it was published", () => {
    // The D25 file was revised 04aug2026. Publication date is irrelevant -
    // what it DESCRIBES is 2025-12-31, and the diff window is all of 2025.
    const d = classifyKineticBuild({
      residential: true, nowMs: NOW,
      fcc: { ...BLOCK_ABSENT_D25, baselineVintage: "D24", latestVintage: "D25",
             firstReportedVintage: "D25", reportedLocations: 12, addedLocations: 12, totalLocations: 24 },
    });
    expect(d.classification).toBe("likely_2026");   // a candidate, not a report
  });

  it("a construction sighting cannot", () => {
    const d = classifyKineticBuild({
      residential: true, nowMs: NOW,
      field: { kind: "construction", observedAtMs: daysAgo(1), verifiedByUserId: 7 },
    });
    expect(d.classification).toBe("construction_observed");
    expect(d.leadEligible).toBe(false);
    expect(d.reasons.join(" ")).toContain("never becomes confirmed");
  });

  it("an official market announcement cannot", () => {
    const d = classifyKineticBuild({
      residential: true, nowMs: NOW,
      planned: { sourceType: "official_announcement", observedAtMs: daysAgo(10) },
    });
    expect(d.classification).toBe("planned");
    expect(d.confidence).toBe("none");
    expect(d.leadEligible).toBe(false);
  });

  it("an inconclusive provider response cannot - and stays recheckable", () => {
    const d = classifyKineticBuild({
      residential: true, nowMs: NOW, fcc: BLOCK_ABSENT_D25,
      latest: { isFiberLive: null, conclusive: false, observedAtMs: daysAgo(1) },
    });
    expect(d.classification).toBe("unverified");
    expect(d.verificationAgeDays).toBeNull();
    expect(d.reasons.join(" ")).toContain("recheckable");
  });

  it("live fiber in a block covered since 2024 is existing_fiber, not a 2026 build", () => {
    const d = classifyKineticBuild(liveNow({ fcc: BLOCK_COVERED_LONG_AGO }));
    expect(d.classification).toBe("existing_fiber");
    expect(d.leadEligible).toBe(false);
    expect(d.buildYear).toBeNull();
  });

  it("live fiber with no dated evidence at all is existing_fiber, never confirmed", () => {
    const d = classifyKineticBuild(liveNow({ fcc: null }));
    expect(d.classification).toBe("existing_fiber");
    expect(d.detectionWindow).toBeNull();
    expect(d.reasons.join(" ")).toContain("treated as pre-existing");
  });

  it("a 2025 build is reported as 2025, not rounded up to 2026", () => {
    const d = classifyKineticBuild(liveNow({
      lastNonFiberAtMs: ms("2025-03-01T00:00:00Z"),
      firstFiberLiveAtMs: ms("2025-09-01T00:00:00Z"),
      latest: { isFiberLive: true, conclusive: true, observedAtMs: daysAgo(4), billingStatus: "N" },
    }));
    expect(d.classification).toBe("existing_fiber");
    expect(d.buildYear).toBe(2025);
    expect(d.reasons.join(" ")).toContain("places the build in 2025");
  });

  it("a window straddling new year proves no year at all", () => {
    const d = classifyKineticBuild(liveNow({
      lastNonFiberAtMs: ms("2025-11-01T00:00:00Z"),
      firstFiberLiveAtMs: ms("2026-02-01T00:00:00Z"),
      latest: { isFiberLive: true, conclusive: true, observedAtMs: daysAgo(4), billingStatus: "N" },
    }));
    expect(d.classification).toBe("existing_fiber");
    expect(d.buildYear).toBeNull();
    expect(d.reasons.join(" ")).toContain("straddles the year boundary");
  });
});

describe("reported_2026 once a usable filing exists", () => {
  // These are the branches that stay empty until the FCC publishes something
  // newer than D25. They are tested now so the first real data does not land
  // on untested code - and because the H1 case below was a genuine bug: it
  // was gated on full-year attestation and silently produced likely_2026.
  const diff = (baselineVintage: any, latestVintage: any): FccBlockFacts => ({
    blockGeoid: "371590501001003",
    firstReportedVintage: latestVintage,
    latestVintage, baselineVintage,
    reportedLocations: 14, totalLocations: 30, addedLocations: 14,
  });

  it("reports a D25-to-J26 addition as a 2026 build (the H1-2026 case)", () => {
    // Window is 2025-12-31 to 2026-06-30 - entirely inside 2026. J26 cannot
    // speak for H2, but that is a COMPLETENESS limit, not a reason to doubt
    // this address.
    const d = classifyKineticBuild({ residential: true, nowMs: NOW, fcc: diff("D25", "J26") });
    expect(d.classification).toBe("reported_2026");
    expect(d.buildYear).toBe(2026);
    expect(d.quarterWhenProven).toBeNull();   // two quarters wide
    expect(d.leadEligible).toBe(false);       // a filing is never a lead
    expect(d.reasons.join(" ")).toContain("confirm at the door");
  });

  it("reports a J26-to-D26 addition as a 2026 build (the H2-2026 case)", () => {
    const d = classifyKineticBuild({ residential: true, nowMs: NOW, fcc: diff("J26", "D26") });
    expect(d.classification).toBe("reported_2026");
    expect(d.buildYear).toBe(2026);
  });

  it("reports a D25-to-D26 addition as a 2026 build (the full-year case)", () => {
    const d = classifyKineticBuild({ residential: true, nowMs: NOW, fcc: diff("D25", "D26") });
    expect(d.classification).toBe("reported_2026");
    expect(d.buildYear).toBe(2026);
  });

  it("REFUSES a window that straddles the new year", () => {
    // J25-to-J26 spans H2 2025 and H1 2026. The addition could be either, so
    // the year is not established and this stays a candidate.
    const d = classifyKineticBuild({ residential: true, nowMs: NOW, fcc: diff("J25", "J26") });
    expect(d.classification).toBe("likely_2026");
    expect(d.buildYear).toBeNull();
  });

  it("still cannot mint a lead, however good the filing", () => {
    for (const pair of [["D25", "J26"], ["J26", "D26"], ["D25", "D26"]] as const) {
      expect(classifyKineticBuild({ residential: true, nowMs: NOW, fcc: diff(pair[0], pair[1]) }).leadEligible).toBe(false);
    }
  });
});

describe("precedence - higher rules make lower ones unreachable", () => {
  it("suppression beats a perfect confirmed build", () => {
    const d = classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25, suppression: "dnc" }));
    expect(d.classification).toBe("suppressed");
    expect(d.leadEligible).toBe(false);
    expect(d.confidence).toBe("none");
  });

  it("every suppression reason blocks lead creation", () => {
    for (const reason of ["dnc", "do_not_knock", "out_of_territory", "unauthorized_market", "competitor", "scope"] as const) {
      const d = classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25, suppression: reason }));
      expect(d.classification).toBe("suppressed");
      expect(d.leadEligible).toBe(false);
    }
  });

  it("a non-residential address is suppressed even when serviceable", () => {
    const d = classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25, residential: false }));
    expect(d.classification).toBe("suppressed");
    expect(d.sources).toContain("suppression:non_residential");
  });

  it("an existing customer beats a confirmed build", () => {
    const d = classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25, existingCustomer: true }));
    expect(d.classification).toBe("existing_customer");
    expect(d.leadEligible).toBe(false);
  });

  it("reads an active subscriber straight off the billing status", () => {
    const d = classifyKineticBuild(liveNow({
      fcc: BLOCK_ABSENT_D25,
      latest: { isFiberLive: true, conclusive: true, observedAtMs: daysAgo(1), billingStatus: "Y" },
    }));
    expect(d.classification).toBe("existing_customer");
  });

  it("a conclusive negative for this door beats a served block", () => {
    const d = classifyKineticBuild({
      residential: true, nowMs: NOW,
      fcc: { ...BLOCK_COVERED_LONG_AGO, addedLocations: 8, reportedLocations: 20, totalLocations: 30 },
      latest: { isFiberLive: false, conclusive: true, observedAtMs: daysAgo(2) },
    });
    expect(d.classification).toBe("not_serviceable");
  });

  it("a fully covered block yields no likely_2026 candidates", () => {
    // Nothing left to build there, so no leading edge.
    const d = classifyKineticBuild({
      residential: true, nowMs: NOW,
      fcc: { ...BLOCK_COVERED_LONG_AGO, addedLocations: 5, reportedLocations: 30, totalLocations: 30 },
    });
    expect(d.classification).toBe("unverified");
  });
});

describe("lead eligibility policy", () => {
  it("defaults to confirmed_2026 only", () => {
    expect(DEFAULT_LEAD_ELIGIBLE_CLASSES).toEqual(["confirmed_2026"]);
  });

  it("widening the policy still cannot mint a suppressed or customer door", () => {
    const wide = KINETIC_BUILD_CLASSES;
    expect(classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25, suppression: "dnc" }), wide).leadEligible).toBe(false);
    expect(classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25, existingCustomer: true }), wide).leadEligible).toBe(false);
    // ...because those classifications never set the flag in the first place.
    expect(classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25 }), wide).leadEligible).toBe(true);
  });

  it("narrowing the policy revokes eligibility", () => {
    expect(classifyKineticBuild(liveNow({ fcc: BLOCK_ABSENT_D25 }), ["reported_2026"]).leadEligible).toBe(false);
  });
});

describe("map paint tiers", () => {
  it("reserves gold for a confirmed build verified recently", () => {
    expect(paintTierFor("confirmed_2026", "fresh")).toBe("gold");
    expect(paintTierFor("confirmed_2026", "aging")).toBe("blue");
    expect(paintTierFor("confirmed_2026", "stale")).toBe("blue");
  });

  it("maps the remaining tiers to the legend", () => {
    expect(paintTierFor("reported_2026", "never")).toBe("lightblue");
    expect(paintTierFor("likely_2026", "never")).toBe("amber");
    expect(paintTierFor("construction_observed", "never")).toBe("amber");
    expect(paintTierFor("existing_fiber", "aging")).toBe("gray");
    expect(paintTierFor("existing_customer", "never")).toBe("gray");
    expect(paintTierFor("suppressed", "never")).toBe("muted");
  });

  it("buckets verification age on the same thresholds the confidence decay uses", () => {
    expect(verificationAgeBucket(null)).toBe("never");
    expect(verificationAgeBucket(30)).toBe("fresh");
    expect(verificationAgeBucket(31)).toBe("aging");
    expect(verificationAgeBucket(90)).toBe("aging");
    expect(verificationAgeBucket(91)).toBe("stale");
  });
});
