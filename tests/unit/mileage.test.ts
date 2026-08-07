// The pure mileage rules. Weighted toward the three things that decide whether
// a reimbursement report is defensible: money that re-sums exactly, a rate that
// never retroactively re-prices history, and a status machine that freezes an
// approved trip.
import { describe, expect, it } from "vitest";
import {
  canMileageTransition, isMileageLocked, isMileagePayable,
  resolveRateForDate, reimbursementCents, formatMiles, formatRate,
  parseRateDollars, parseMiles, straightLineMilesHundredths, computeTripDistance,
  mayStartGpsTrip, maySampleInBackground, findDuplicateTrips, validateTrip,
  summarizeMileage, MAX_TRIP_MILES, type MileageRate,
} from "@shared/mileage";

const rate = (id: number, milli: number, from: string): MileageRate =>
  ({ id, tenantId: 1, rateMilliCentsPerMile: milli, effectiveFrom: from, note: null });

describe("status machine", () => {
  it("walks the happy path", () => {
    expect(canMileageTransition("DRAFT", "SUBMITTED")).toBe(true);
    expect(canMileageTransition("SUBMITTED", "APPROVED")).toBe(true);
    expect(canMileageTransition("APPROVED", "PAID")).toBe(true);
  });

  it("FREEZES an approved trip — no path back to draft or submitted", () => {
    // This is the rule that makes a correction an adjustment rather than an
    // edit, the same way a FINALIZED statement refuses to recalculate.
    expect(canMileageTransition("APPROVED", "DRAFT")).toBe(false);
    expect(canMileageTransition("APPROVED", "SUBMITTED")).toBe(false);
    expect(canMileageTransition("APPROVED", "REJECTED")).toBe(false);
    expect(isMileageLocked("APPROVED")).toBe(true);
    expect(isMileageLocked("PAID")).toBe(true);
    expect(isMileageLocked("SUBMITTED")).toBe(false);
  });

  it("lets a rejection be fixed and resubmitted", () => {
    expect(canMileageTransition("REJECTED", "DRAFT")).toBe(true);
    expect(canMileageTransition("DRAFT", "SUBMITTED")).toBe(true);
  });

  it("is terminal at PAID", () => {
    expect(canMileageTransition("PAID", "APPROVED")).toBe(false);
    expect(canMileageTransition("PAID", "DRAFT")).toBe(false);
  });

  it("owes money only when approved", () => {
    expect(isMileagePayable("APPROVED")).toBe(true);
    expect(isMileagePayable("SUBMITTED")).toBe(false);
    expect(isMileagePayable("PAID")).toBe(false); // already paid, not owed again
  });
});

describe("rate resolution", () => {
  const rates = [rate(1, 62_500, "2026-01-01"), rate(2, 65_500, "2026-07-01")];

  it("prices a trip at the rate effective on the TRIP date, not today's", () => {
    // The whole point of effective dating: setting July's rate must not
    // re-price a March trip.
    expect(resolveRateForDate(rates, "2026-03-15")?.rateMilliCentsPerMile).toBe(62_500);
    expect(resolveRateForDate(rates, "2026-08-06")?.rateMilliCentsPerMile).toBe(65_500);
  });

  it("is inclusive of the effective date itself", () => {
    expect(resolveRateForDate(rates, "2026-07-01")?.id).toBe(2);
    expect(resolveRateForDate(rates, "2026-06-30")?.id).toBe(1);
  });

  it("returns null before any rate exists — never a guessed federal figure", () => {
    expect(resolveRateForDate(rates, "2025-12-31")).toBeNull();
    expect(resolveRateForDate([], "2026-08-06")).toBeNull();
  });

  it("breaks a same-date tie toward the later-entered row", () => {
    const dupes = [rate(1, 62_500, "2026-07-01"), rate(2, 65_500, "2026-07-01")];
    expect(resolveRateForDate(dupes, "2026-07-05")?.id).toBe(2);
  });
});

describe("reimbursement arithmetic", () => {
  it("computes a half-cent rate exactly", () => {
    // 12.34 mi × $0.655 = $8.0827 → $8.08
    expect(reimbursementCents(1234, 65_500)).toBe(808);
  });

  it("re-sums: the parts of a report equal its total", () => {
    // Float math is what breaks this. Three trips priced individually must add
    // up to the same cents as the org's report claims.
    const trips = [1234, 5678, 99];
    const each = trips.map(m => reimbursementCents(m, 65_500));
    expect(each).toEqual([808, 3719, 65]);
    expect(each.reduce((a, b) => a + b, 0)).toBe(4592);
  });

  it("is zero when the org has no rate", () => {
    expect(reimbursementCents(1234, 0)).toBe(0);
    expect(reimbursementCents(0, 65_500)).toBe(0);
  });

  it("stays symmetric for a negative correction", () => {
    expect(reimbursementCents(-1234, 65_500)).toBe(-808);
  });
});

describe("parsing at the boundary", () => {
  it("accepts a rate an operator would actually type", () => {
    expect(parseRateDollars("0.655")).toBe(65_500);
    expect(parseRateDollars(0.7)).toBe(70_000);
    expect(parseRateDollars("0")).toBe(0);
  });

  it("REJECTS a cents-entered-as-dollars typo before it multiplies", () => {
    // 65.5 means $0.655, not $65.50/mile. Catching it here saves a quarter of
    // trips priced 100× too high.
    expect(parseRateDollars("65.5")).toBeNull();
    expect(parseRateDollars(-1)).toBeNull();
    expect(parseRateDollars("abc")).toBeNull();
  });

  it("bounds a single trip's distance", () => {
    expect(parseMiles("12.34")).toBe(1234);
    expect(parseMiles(MAX_TRIP_MILES + 1)).toBeNull();
    expect(parseMiles(-3)).toBeNull();
  });

  it("formats for humans without re-deriving the number", () => {
    expect(formatMiles(1234)).toBe("12.34 mi");
    expect(formatMiles(123_456)).toBe("1,234.56 mi");
    expect(formatRate(65_500)).toBe("$0.655/mi");
  });
});

describe("distance resolution", () => {
  const raleigh = { lat: 35.7796, lng: -78.6382 };
  const durham = { lat: 35.9940, lng: -78.8986 };

  it("measures a straight line in hundredths of a mile", () => {
    const miles = straightLineMilesHundredths(raleigh, durham) / 100;
    expect(miles).toBeGreaterThan(19);
    expect(miles).toBeLessThan(22);
  });

  it("prefers the rep's own reading over a provider's", () => {
    // The rep drove it. A routing engine that picked a different road is more
    // precise, not more truthful.
    const d = computeTripDistance({
      manualMilesHundredths: 2500, routedMilesHundredths: 2100,
      start: raleigh, end: durham,
    });
    expect(d).toEqual({ milesHundredths: 2500, method: "MANUAL" });
  });

  it("prefers a routed distance over a straight line", () => {
    const d = computeTripDistance({ routedMilesHundredths: 2400, start: raleigh, end: durham });
    expect(d?.method).toBe("ROUTED");
    expect(d?.milesHundredths).toBe(2400);
  });

  it("degrades to a straight line rather than blocking the trip", () => {
    const d = computeTripDistance({ start: raleigh, end: durham });
    expect(d?.method).toBe("STRAIGHT_LINE");
  });

  it("returns null when it has nothing to work with", () => {
    expect(computeTripDistance({})).toBeNull();
  });
});

describe("location consent", () => {
  it("refuses a GPS trip until the disclosure is accepted", () => {
    expect(mayStartGpsTrip(null)).toBe(false);
    expect(mayStartGpsTrip({ disclosureAcceptedAt: null, backgroundOptIn: true })).toBe(false);
    expect(mayStartGpsTrip({ disclosureAcceptedAt: "2026-08-06T00:00:00.000Z", backgroundOptIn: false })).toBe(true);
  });

  it("treats background sampling as a SECOND consent, and only during a trip", () => {
    const accepted = { disclosureAcceptedAt: "2026-08-06T00:00:00.000Z", backgroundOptIn: false };
    const optedIn = { ...accepted, backgroundOptIn: true };
    // Agreeing to have a trip measured is not agreeing to be followed all day.
    expect(maySampleInBackground(accepted, true)).toBe(false);
    expect(maySampleInBackground(optedIn, true)).toBe(true);
    // And never without an open trip — there is no continuous-tracking state.
    expect(maySampleInBackground(optedIn, false)).toBe(false);
  });
});

describe("duplicate detection", () => {
  const base = {
    tripDate: "2026-08-06", startLocation: "123 Main St", endLocation: "456 Oak Ave",
    milesHundredths: 1200,
  };

  it("catches the same drive logged twice by address", () => {
    const found = findDuplicateTrips(base, [{ ...base, id: 9 }]);
    expect(found.map(f => f.id)).toEqual([9]);
  });

  it("normalizes punctuation and spacing before comparing", () => {
    const found = findDuplicateTrips(base, [
      { ...base, id: 9, startLocation: "123  main st.", endLocation: "456 OAK AVE" },
    ]);
    expect(found).toHaveLength(1);
  });

  it("catches a duplicate across a GPS trip and a manual one, by coordinates", () => {
    // The manual entry has no coordinates and the GPS trip has no typed
    // address — this crossing is exactly the duplicate worth catching.
    const gps = {
      tripDate: "2026-08-06", startLocation: null, endLocation: null,
      startLat: 35.7796, startLng: -78.6382, endLat: 35.7850, endLng: -78.6400,
      milesHundredths: 1200,
    };
    const near = {
      ...gps, id: 9,
      startLat: 35.7797, startLng: -78.6384, endLat: 35.7851, endLng: -78.6402,
    };
    expect(findDuplicateTrips(gps, [near])).toHaveLength(1);
  });

  it("does not flag a different day, a different route, or a different length", () => {
    expect(findDuplicateTrips(base, [{ ...base, id: 9, tripDate: "2026-08-05" }])).toHaveLength(0);
    expect(findDuplicateTrips(base, [{ ...base, id: 9, endLocation: "999 Pine Rd" }])).toHaveLength(0);
    expect(findDuplicateTrips(base, [{ ...base, id: 9, milesHundredths: 4000 }])).toHaveLength(0);
  });

  it("never flags a trip against itself", () => {
    expect(findDuplicateTrips({ ...base, id: 9 }, [{ ...base, id: 9 }])).toHaveLength(0);
  });
});

describe("trip validation", () => {
  const today = "2026-08-06";
  const ok = {
    tripDate: "2026-08-06", startLocation: "A", endLocation: "B",
    milesHundredths: 1200, purpose: "Door knocking — Oakwood", source: "MANUAL" as const,
  };

  it("accepts a well-formed manual trip", () => {
    expect(validateTrip(ok, today)).toEqual([]);
  });

  it("refuses a trip that has not happened yet", () => {
    expect(validateTrip({ ...ok, tripDate: "2026-08-07" }, today).join()).toMatch(/future/);
  });

  it("allows back-dated catch-up paperwork", () => {
    // One-sided on purpose: last month's trip is ordinary, tomorrow's is not.
    expect(validateTrip({ ...ok, tripDate: "2026-07-02" }, today)).toEqual([]);
  });

  it("requires a purpose — that is what makes the record defensible", () => {
    expect(validateTrip({ ...ok, purpose: "  " }, today).join()).toMatch(/purpose/);
  });

  it("requires endpoints for a MANUAL trip but not a GPS one", () => {
    expect(validateTrip({ ...ok, startLocation: null }, today).join()).toMatch(/startLocation/);
    // A GPS trip proves its endpoints with coordinates; demanding typed
    // addresses would make the start-trip button useless.
    expect(validateTrip({ ...ok, source: "GPS", startLocation: null, endLocation: null }, today)).toEqual([]);
  });

  it("rejects zero and absurd distances", () => {
    expect(validateTrip({ ...ok, milesHundredths: 0 }, today).join()).toMatch(/greater than zero/);
    expect(validateTrip({ ...ok, milesHundredths: (MAX_TRIP_MILES + 1) * 100 }, today).join()).toMatch(/exceed/);
  });
});

describe("summaries", () => {
  it("keeps pending money OUT of the approved liability", () => {
    // An admin liability figure that blends a claim with a debt overstates what
    // the org actually owes.
    const s = summarizeMileage([
      { status: "APPROVED", milesHundredths: 1000, reimbursementCents: 655 },
      { status: "SUBMITTED", milesHundredths: 2000, reimbursementCents: 1310 },
      { status: "PAID", milesHundredths: 500, reimbursementCents: 328 },
      { status: "REJECTED", milesHundredths: 900, reimbursementCents: 590 },
    ]);
    expect(s.approvedCents).toBe(655);
    expect(s.paidCents).toBe(328);
    expect(s.pendingEstimateCents).toBe(1310);
    expect(s.pendingMilesHundredths).toBe(2000);
    expect(s.tripCount).toBe(4);
  });
});
