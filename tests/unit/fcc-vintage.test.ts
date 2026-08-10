// The vintage attestation gate and the never-guess-a-quarter rule.
//
// These tests exist because of a specific failure mode: someone asks for
// "2026 builds", the newest two files on the FCC site get diffed, and the
// result is labelled 2026 even though both filings describe 2025. As of
// 2026-08-10 the newest published BDC vintage really is December 31, 2025
// (verified against /nbm/map/api/published/filing), so the gate below is not
// hypothetical - it is the current state of the world.
import { describe, expect, it } from "vitest";
import {
  KNOWN_PUBLISHED_VINTAGES,
  additionWindow,
  attestingVintageFor,
  compareVintages,
  expectedPublicationDate,
  parseVintageCode,
  quarterExplanation,
  sortVintages,
  vintageAsOfMs,
  vintageCanAttestYear,
  vintageOf,
  windowQuarter,
  windowYear,
  yearCoverage,
} from "@shared/fccVintage";

const ms = (iso: string) => Date.parse(iso);

describe("vintage parsing and as-of dates", () => {
  it("maps J to June 30 and D to December 31 of the filing year", () => {
    expect(vintageOf("J25").asOf).toBe("2025-06-30");
    expect(vintageOf("D25").asOf).toBe("2025-12-31");
    expect(vintageOf("D25").label).toBe("December 31, 2025");
  });

  it("parses case-insensitively and rejects anything that is not a filing code", () => {
    expect(parseVintageCode("d25")).toBe("D25");
    expect(parseVintageCode(" J26 ")).toBe("J26");
    expect(parseVintageCode("X25")).toBeNull();
    expect(parseVintageCode("D99")).toBeNull();   // out of the plausible range
    expect(parseVintageCode("D21")).toBeNull();   // predates BDC
    expect(parseVintageCode(null)).toBeNull();
    expect(parseVintageCode(2025)).toBeNull();
  });

  it("as-of is the END of the as-of day, so the whole day is covered", () => {
    expect(vintageAsOfMs("D25")).toBe(ms("2025-12-31T23:59:59.999Z"));
  });

  it("orders chronologically, not lexically", () => {
    // Lexically "D24" < "J25" < "J24"; chronologically J24 < D24 < J25.
    expect(sortVintages(["J25", "D24", "J24"])).toEqual(["J24", "D24", "J25"]);
    expect(compareVintages("D24", "J25")).toBeLessThan(0);
  });
});

describe("vintageCanAttestYear - the gate", () => {
  it("REFUSES to attest 2026 from the newest filing that exists today", () => {
    // This is the whole point. D25 describes 2025-12-31; nothing about 2026.
    expect(vintageCanAttestYear("D24", "D25", 2026)).toBe(false);
    expect(vintageCanAttestYear("J25", "D25", 2026)).toBe(false);
  });

  it("attests 2025 from a D24 baseline and a D25 current", () => {
    expect(vintageCanAttestYear("D24", "D25", 2025)).toBe(true);
  });

  it("will attest 2026 once the December-2026 filing publishes", () => {
    expect(vintageCanAttestYear("D25", "D26", 2026)).toBe(true);
  });

  it("refuses a mid-year current vintage for a full-year claim", () => {
    // J26 describes 2026-06-30 - it cannot establish anything about H2 2026,
    // so it cannot attest "gained service during 2026" as a closed statement.
    expect(vintageCanAttestYear("D25", "J26", 2026)).toBe(false);
  });

  it("refuses when the baseline is itself inside the target year", () => {
    // A J26-to-D26 diff proves an H2-2026 build, but "did not have it before
    // 2026" is not established by a baseline dated mid-2026.
    expect(vintageCanAttestYear("J26", "D26", 2026)).toBe(false);
  });

  it("names no attesting vintage for 2026 among what is published today", () => {
    expect(attestingVintageFor(2026, KNOWN_PUBLISHED_VINTAGES)).toBeNull();
    expect(attestingVintageFor(2025, KNOWN_PUBLISHED_VINTAGES)).toBe("D25");
  });

  it("projects when the missing vintage should arrive", () => {
    // Roughly seven months after the as-of date; D25 published early Aug 2026.
    expect(expectedPublicationDate("J26")).toBe("2027-01-30");
    expect(expectedPublicationDate("D26")).toBe("2027-07-31");
  });
});

describe("yearCoverage - partial is not the same as none", () => {
  it("reports nothing for 2026 from what is published today", () => {
    const c = yearCoverage(["D24", "J25", "D25"], 2026);
    expect(c.partial).toBe(false);
    expect(c.complete).toBe(false);
    expect(c.coveredThrough).toBeNull();
  });

  it("reports PARTIAL 2026 coverage once J26 arrives, through June 30", () => {
    // The case the classifier originally got wrong: real H1-2026 builds are
    // provable here, even though the year is not complete.
    const c = yearCoverage(["D24", "J25", "D25", "J26"], 2026);
    expect(c.partial).toBe(true);
    expect(c.complete).toBe(false);
    expect(c.coveredThrough).toBe("2026-06-30");
  });

  it("reports COMPLETE 2026 coverage once D26 arrives", () => {
    const c = yearCoverage(["D25", "J26", "D26"], 2026);
    expect(c.partial).toBe(true);
    expect(c.complete).toBe(true);
    expect(c.coveredThrough).toBe("2026-12-31");
  });

  it("needs a baseline on or before the start of the year to be complete", () => {
    // Starting at J26 leaves H1 unaccounted for, so the list is not exhaustive.
    expect(yearCoverage(["J26", "D26"], 2026).complete).toBe(false);
    expect(yearCoverage(["J26", "D26"], 2026).partial).toBe(true);
  });

  it("a single vintage covers nothing - there is no diff", () => {
    expect(yearCoverage(["D26"], 2026)).toEqual({ partial: false, complete: false, coveredThrough: null });
    expect(yearCoverage([], 2026)).toEqual({ partial: false, complete: false, coveredThrough: null });
  });

  it("reports complete 2025 coverage from what is published today", () => {
    const c = yearCoverage(["D24", "J25", "D25"], 2025);
    expect(c.partial).toBe(true);
    expect(c.complete).toBe(true);
  });
});

describe("addition windows are intervals, never dates", () => {
  it("opens at the baseline as-of and closes at the current as-of", () => {
    const window = additionWindow("D24", "D25")!;
    expect(window.fromMs).toBe(ms("2024-12-31T23:59:59.999Z"));
    expect(window.toMs).toBe(ms("2025-12-31T23:59:59.999Z"));
  });

  it("returns null when the vintages are equal or reversed", () => {
    expect(additionWindow("D25", "D25")).toBeNull();
    expect(additionWindow("D25", "D24")).toBeNull();
  });
});

describe("windowQuarter - the never-guess rule", () => {
  it("gives NO quarter for any biannual filing diff", () => {
    // A twelve-month window spans four quarters; a six-month window spans two.
    // Neither can name one, and both must say so rather than defaulting.
    expect(windowQuarter(additionWindow("D24", "D25"))).toBeNull();
    expect(windowQuarter(additionWindow("J25", "D25"))).toBeNull();
  });

  it("gives a quarter only when the whole window sits inside one", () => {
    expect(windowQuarter({ fromMs: ms("2026-04-02T00:00:00Z"), toMs: ms("2026-05-20T00:00:00Z") })).toBe("2026Q2");
    expect(windowQuarter({ fromMs: ms("2026-01-05T00:00:00Z"), toMs: ms("2026-03-31T23:00:00Z") })).toBe("2026Q1");
  });

  it("treats the window as OPEN at the start, so a boundary start still counts", () => {
    // Observed not-serviceable at the last instant of Q1 and serviceable in
    // Q2: the build happened in Q2. A closed-start window would have spanned
    // both quarters and thrown the answer away.
    expect(windowQuarter({ fromMs: ms("2026-03-31T23:59:59.999Z"), toMs: ms("2026-06-01T00:00:00Z") })).toBe("2026Q2");
  });

  it("refuses a window that crosses a quarter boundary by one day", () => {
    expect(windowQuarter({ fromMs: ms("2026-03-30T00:00:00Z"), toMs: ms("2026-04-02T00:00:00Z") })).toBeNull();
  });

  it("refuses a zero-length or inverted window", () => {
    expect(windowQuarter({ fromMs: ms("2026-05-01T00:00:00Z"), toMs: ms("2026-05-01T00:00:00Z") })).toBeNull();
    expect(windowQuarter({ fromMs: ms("2026-05-02T00:00:00Z"), toMs: ms("2026-05-01T00:00:00Z") })).toBeNull();
    expect(windowQuarter(null)).toBeNull();
  });
});

describe("windowYear", () => {
  it("names a year when the window stays inside one", () => {
    expect(windowYear({ fromMs: ms("2026-01-01T00:00:00Z"), toMs: ms("2026-11-30T00:00:00Z") })).toBe(2026);
  });

  it("refuses a window that straddles the new year - the D25-to-D26 case", () => {
    expect(windowYear(additionWindow("D24", "D25"))).toBe(2025);
    expect(windowYear({ fromMs: ms("2025-12-30T00:00:00Z"), toMs: ms("2026-02-01T00:00:00Z") })).toBeNull();
  });

  it("counts a window starting at the last instant of a year as the NEXT year", () => {
    // Exactly the FCC baseline case: D25 as-of is 2025-12-31T23:59:59.999Z, so
    // a build seen live in 2026 is a 2026 build, not an ambiguous one.
    expect(windowYear({ fromMs: ms("2025-12-31T23:59:59.999Z"), toMs: ms("2026-05-01T00:00:00Z") })).toBe(2026);
  });
});

describe("operator explanations", () => {
  it("says a quarter is not established rather than leaving a blank", () => {
    expect(quarterExplanation(additionWindow("D24", "D25"))).toContain("too wide to prove a quarter");
    expect(quarterExplanation(null)).toContain("not established");
    expect(quarterExplanation({ fromMs: ms("2026-04-02T00:00:00Z"), toMs: ms("2026-05-20T00:00:00Z") }))
      .toBe("Build proven within 2026Q2.");
  });
});
