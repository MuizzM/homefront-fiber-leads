import { describe, expect, it } from "vitest";
import { findProviderDate, nextRecheckAt, normalizeDate, readBuildFlags, readFutureService } from "../../shared/futureService";

const NOW = Date.parse("2026-08-22T00:00:00.000Z");
const DAY = 86_400_000;

describe("readFutureService", () => {
  it("an already-active NEW FIBER door is NOT coming soon - it is a door we lost", () => {
    // This is the exact inference availabilitySnapshot.ts makes today, and the
    // reason 294 of 330 watches never flip: somebody already holds the account.
    for (const billing of ["Y", "A"]) {
      const r = readFutureService({ householdSegmentType: "NEW FIBER", billingStatus: billing });
      expect(r.isNowActive).toBe(true);
      expect(r.isFuture).toBe(false);
      expect(r.signals).toContain("now_active");
    }
  });

  it("NEW FIBER with no account is a lead, not a future promise", () => {
    const r = readFutureService({ householdSegmentType: "NEW FIBER", billingStatus: "N" });
    expect(r.isFuture).toBe(false);
    expect(r.isNowActive).toBe(false);
  });

  it("reads an explicit pre-launch segment and keeps the provider's words", () => {
    const r = readFutureService({ householdSegmentType: "COMING SOON", billingStatus: "N" });
    expect(r.isFuture).toBe(true);
    expect(r.signals).toContain("segment_future");
    expect(r.quote).toBe("COMING SOON");
  });

  it("reads pre-launch from the market segment, the service status and the qualification", () => {
    expect(readFutureService({ marketSegmentType: "PLANNED FIBER" }).signals).toContain("market_segment_future");
    expect(readFutureService({ serviceStatus: "PENDING" }).signals).toContain("service_status_future");
    expect(readFutureService({ finalQual: "FUTURE QUAL VIA FIBER" }).signals).toContain("qualification_future");
    expect(readFutureService({ householdSegmentType: "UNDER CONSTRUCTION" }).isFuture).toBe(true);
    expect(readFutureService({ householdSegmentType: "PRE-LAUNCH" }).isFuture).toBe(true);
  });

  it("a plain copper or no-service answer promises nothing", () => {
    const r = readFutureService({ householdSegmentType: "DSL", billingStatus: "N", serviceStatus: "ACTIVE" });
    expect(r.isFuture).toBe(false);
    expect(r.promisedDate).toBeNull();
    expect(r.signals).toEqual([]);
  });

  it("a stated date is itself a promise even when the wording is unfamiliar", () => {
    const r = readFutureService({ householdSegmentType: "DSL" }, { estimatedServiceDate: "2026-11-01" });
    expect(r.isFuture).toBe(true);
    expect(r.promisedDate).toBe("2026-11-01");
    expect(r.dateSource).toBe("provider");
    expect(r.datePath).toBe("estimatedServiceDate");
  });

  it("an active account is never future, even with a date in the payload", () => {
    const r = readFutureService(
      { householdSegmentType: "NEW FIBER", billingStatus: "A" },
      { estimatedCompletionDate: "2026-11-01" },
    );
    expect(r.isNowActive).toBe(true);
    expect(r.isFuture).toBe(false);
  });
});

describe("the Frontier build-out contract", () => {
  // Shapes taken from real stored payloads (kinetic_address_observations).
  const frontierPending = {
    success: true, matchType: "EXACT", techAvailable: "FIBER", offerType: "CHALLENGER1",
    addressHasExistingService: false, fiberModernization: true, fiberBuildOutStatus: "PENDING",
    isFutureFiberEligible: true, futureServiceDate: "2026-09-18", plantType: "OVERLAY", hasPendingOrder: false,
    address: { city: "DURHAM" },
  };
  const frontierNothing = {
    success: true, techAvailable: "FIBER", offerType: "CHALLENGER1", addressHasExistingService: false,
    fiberModernization: false, fiberBuildOutStatus: "", isFutureFiberEligible: false, plantType: "OVERLAY",
    hasPendingOrder: false, address: { city: "DURHAM" },
  };

  it("reads a pending build with its date as a future promise", () => {
    const r = readFutureService({}, frontierPending);
    expect(r.isFuture).toBe(true);
    expect(r.promisedDate).toBe("2026-09-18");
    expect(r.dateSource).toBe("provider");
    expect(r.datePath).toBe("futureServiceDate");
    expect(r.signals).toEqual(expect.arrayContaining(["provider_future_eligible", "build_pending", "provider_date"]));
  });

  it("a pending build with no date is still a promise, just undated", () => {
    const { futureServiceDate, ...noDate } = frontierPending;
    const r = readFutureService({}, noDate);
    expect(r.isFuture).toBe(true);
    expect(r.promisedDate).toBeNull();
    expect(r.signals).toContain("build_pending");
  });

  it("a settled Frontier address promises nothing", () => {
    const r = readFutureService({}, frontierNothing);
    expect(r.isFuture).toBe(false);
    expect(r.signals).not.toContain("build_pending");
  });

  it("records an existing account and a pending order as signals, not as a verdict", () => {
    const r = readFutureService({}, { ...frontierPending, addressHasExistingService: true, hasPendingOrder: true });
    expect(r.signals).toEqual(expect.arrayContaining(["has_existing_service", "pending_order"]));
    expect(r.isFuture).toBe(true); // an existing COPPER customer with fiber pending is an upgrade, not a skip
  });

  it("readBuildFlags reports absence as null rather than false", () => {
    expect(readBuildFlags({})).toEqual({
      futureEligible: null, buildOutStatus: null, modernization: null,
      hasExistingService: null, pendingOrder: null, plantType: null,
      futureQual: null, futureTechnology: null, completionText: null,
    });
    expect(readBuildFlags(undefined).futureEligible).toBeNull();
    expect(readBuildFlags("not an object").plantType).toBeNull();
  });

  it("a real Kinetic payload carries no build contract and no date", () => {
    const kinetic = {
      success: true, validationResult: "AddressFound", exactMatch: true, techType: "FIBER",
      dfAddressId: "800", exchangeId: "NC017", maxQual: "QUAL UP TO 2 GIG RANGE VIA FIBER",
      address: { householdSegmentType: "NEW FIBER", billingStatus: "N", addressCatalogDt: "2019-03-11" },
      overRides: [{ reasonDetails: "COPPER QUAL REMOVE FIBER AREA", dateActive: "2026-07-17" }],
      uqualProvisioningResult: JSON.stringify({ chipSetType: "FTTP", address: { addressCatalogDt: "2019-03-11" } }),
    };
    expect(readBuildFlags(kinetic).buildOutStatus).toBeNull();
    // Neither addressCatalogDt nor an override's dateActive is a turn-on date.
    expect(findProviderDate(kinetic, NOW)).toBeNull();
    const r = readFutureService({ householdSegmentType: "NEW FIBER", billingStatus: "N" }, kinetic);
    expect(r.isFuture).toBe(false);
    expect(r.promisedDate).toBeNull();
  });
});

describe("Kinetic's own future-build contract (broadbandService)", () => {
  // The exact block stored in fiber_checks.result for a Monroe door, NOV-2026.
  const kineticFuture = (eta: string | null) => ({
    success: true, validationResult: "AddressFound", techType: "COPPER",
    address: { householdSegmentType: "DSL", billingStatus: "N", city: "MONROE", addressCatalogDt: "2019-03-11" },
    broadbandService: {
      futureQual: "FutureQual", technologyType: "FUTURE_QUAL_EXTENDED", qualSpeed: "1000000",
      qualDesc: "FUTURE QUAL UP TO 1G", qualRank: "999", packages: "pFQ",
      futureTechnologyType: "FIBER", ...(eta == null ? {} : { estimatedCompletionDt: eta }),
    },
  });

  it("reads the month Kinetic states and resolves it to the first of that month", () => {
    const r = readFutureService({ householdSegmentType: "DSL", billingStatus: "N" }, kineticFuture("NOV-2026"));
    expect(r.isFuture).toBe(true);
    expect(r.promisedDate).toBe("2026-11-01");
    expect(r.dateSource).toBe("provider");
    expect(r.datePath).toBe("broadbandService.estimatedCompletionDt");
    expect(r.signals).toEqual(expect.arrayContaining(["future_qual", "provider_date"]));
  });

  it("treats the undated sentinel as a promise without a date", () => {
    const r = readFutureService({}, kineticFuture("Future Fiber Build Planned"));
    expect(r.isFuture).toBe(true);
    expect(r.promisedDate).toBeNull();
    expect(r.signals).toEqual(expect.arrayContaining(["future_qual", "future_build_planned"]));
    expect(r.quote).toBe("Future Fiber Build Planned");
  });

  it("a future qualification with no completion field at all is still a promise", () => {
    const r = readFutureService({}, kineticFuture(null));
    expect(r.isFuture).toBe(true);
    expect(r.signals).toContain("future_qual");
  });

  it("does not mistake the address catalog stamp in the same payload for the promise", () => {
    const r = readFutureService({}, kineticFuture("FEB-2027"));
    expect(r.promisedDate).toBe("2027-02-01");
  });

  it("every real MON-YYYY value observed in production parses", () => {
    for (const [eta, want] of [["NOV-2026", "2026-11-01"], ["DEC-2026", "2026-12-01"], ["JAN-2027", "2027-01-01"],
                               ["FEB-2027", "2027-02-01"], ["MAR-2027", "2027-03-01"]] as const) {
      expect(normalizeDate(eta, NOW), eta).toBe(want);
    }
    expect(normalizeDate("Future Fiber Build Planned", NOW)).toBeNull();
    expect(normalizeDate("Nov 2026", NOW)).toBe("2026-11-01");
    expect(normalizeDate("NOVEMBER-2026", NOW)).toBe("2026-11-01");
    expect(normalizeDate("XXX-2026", NOW)).toBeNull();
  });

  it("a plain Kinetic answer with no future block promises nothing", () => {
    const r = readFutureService({ householdSegmentType: "NEW FIBER", billingStatus: "N" }, {
      success: true, address: { householdSegmentType: "NEW FIBER", billingStatus: "N" },
      broadbandService: { finalQualSpeed: "1000000", technologyType: "FIBER" },
    });
    expect(r.isFuture).toBe(false);
    expect(r.promisedDate).toBeNull();
  });
});

describe("findProviderDate", () => {
  it("finds a date under a service-ready key, and reports the path", () => {
    const hit = findProviderDate({ address: { city: "Rockwell" }, estimatedCompletionDate: "2026-12-15" }, NOW);
    expect(hit).toMatchObject({ date: "2026-12-15", path: "estimatedCompletionDate", key: "estimatedCompletionDate" });
  });

  it("NEVER reads addressCatalogDate as a turn-on date", () => {
    // Real responses carry this with values years in the past (2019-2024 in the
    // production copy). Treating it as an ETA would park every scanned address
    // in the hot recheck lane forever.
    expect(findProviderDate({ addressCatalogDate: "2019-03-11" }, NOW)).toBeNull();
    expect(findProviderDate({ address: { addressCatalogDate: "2024-04-18" } }, NOW)).toBeNull();
  });

  it("ignores billing, order and audit stamps", () => {
    for (const key of ["billDate", "orderDate", "createdDate", "lastUpdatedDate", "expirationDate", "disconnectDate", "startDate"]) {
      expect(findProviderDate({ [key]: "2026-11-01" }, NOW), key).toBeNull();
    }
  });

  it("descends into nested objects and into uqualProvisioningResult as a JSON string", () => {
    const raw = {
      uqualProvisioningResult: JSON.stringify({ broadBandServices: [{ technologyType: "FIBER", readyForServiceDate: "2027-01-20" }] }),
    };
    const hit = findProviderDate(raw, NOW);
    expect(hit?.date).toBe("2027-01-20");
    expect(hit?.path).toContain("uqualProvisioningResult");
  });

  it("accepts the date formats a provider realistically sends", () => {
    expect(findProviderDate({ serviceAvailableDate: "2026/11/01" }, NOW)?.date).toBe("2026-11-01");
    expect(findProviderDate({ serviceAvailableDate: "11/01/2026" }, NOW)?.date).toBe("2026-11-01");
    expect(findProviderDate({ serviceAvailableDate: "2026-11-01T12:30:00Z" }, NOW)?.date).toBe("2026-11-01");
    expect(findProviderDate({ eta: String(Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000)) }, NOW)?.date).toBe("2026-11-01");
  });

  it("rejects sentinels, junk and implausible dates", () => {
    for (const v of ["", "0", "N/A", "TBD", "unknown", "soon", "1970-01-01", "2045-01-01", "1999-01-01"]) {
      expect(findProviderDate({ estimatedReadyDate: v }, NOW), String(v)).toBeNull();
    }
  });

  it("is bounded against a hostile or huge payload", () => {
    let deep: any = { estimatedReadyDate: "2026-11-01" };
    for (let i = 0; i < 40; i++) deep = { nest: deep };
    expect(findProviderDate(deep, NOW)).toBeNull(); // deeper than MAX_DEPTH
    const wide: any = {};
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = { v: i };
    expect(() => findProviderDate(wide, NOW)).not.toThrow();
  });

  it("returns null for the payload shapes we actually see today", () => {
    // A real NEW FIBER response as recorded in the fixtures: no date anywhere.
    const real = {
      success: true, validationResult: "AddressFound", techType: "FIBER", addressCatalogDate: "2019-03-11",
      address: { householdSegmentType: "NEW FIBER", billingStatus: "N", maxQualTechnologyType: "FIBER", geoLat: 35.5, geoLong: -80.4 },
      uqualProvisioningResult: JSON.stringify({ chipSetType: "FTTP", miror: { svcKey: "K1", status: "ACTIVE" } }),
    };
    expect(findProviderDate(real, NOW)).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("normalizes to YYYY-MM-DD and rejects out-of-range", () => {
    expect(normalizeDate("2026-11-01", NOW)).toBe("2026-11-01");
    expect(normalizeDate("13/45/2026", NOW)).toBeNull();
    expect(normalizeDate(true, NOW)).toBeNull();
    expect(normalizeDate(null, NOW)).toBeNull();
  });
});

describe("nextRecheckAt", () => {
  const base = {
    firstSeenMs: NOW, lastCheckedMs: null, hotHours: 6, soonHours: 12, watchHours: 24,
    hotWindowDays: 14, flipFromDays: 2, flipToDays: 14, undatedDays: 30,
  };

  it("a passed date is hot: it should already be on", () => {
    const r = nextRecheckAt({ ...base, promisedDate: "2026-08-01" }, NOW);
    expect(r.band).toBe("hot");
    expect(r.reason).toBe("date_passed");
    expect(r.dueAtMs).toBe(NOW + 6 * 3_600_000);
  });

  it("a near date is hot; a far date is still read weekly, not parked", () => {
    expect(nextRecheckAt({ ...base, promisedDate: "2026-08-30" }, NOW).band).toBe("hot");
    const far = nextRecheckAt({ ...base, promisedDate: "2026-12-01" }, NOW);
    expect(far.band).toBe("soon");
    expect(far.reason).toBe("date_future");
    // NOT the day the hot window opens. A stated date is a plan: builds light up
    // early and silently, so the weekly floor wins while the window is far off.
    expect(far.dueAtMs).toBe(NOW + 7 * DAY);
    expect(far.dueAtMs).toBeLessThan(Date.parse("2026-12-01T00:00:00Z") - 14 * DAY);
  });

  it("the hot window still wins once it is nearer than a week", () => {
    // NOW is 2026-08-22, so a 2026-09-10 promise is still outside the 14-day hot
    // window, but its window opens on 08-27 - five days out, sooner than the
    // weekly floor. The EARLIER of the two is always the due date.
    const near = nextRecheckAt({ ...base, promisedDate: "2026-09-10" }, NOW);
    expect(near.reason).toBe("date_future");
    expect(near.dueAtMs).toBe(Date.parse("2026-09-10T00:00:00Z") - 14 * DAY);
    expect(near.dueAtMs).toBeLessThan(NOW + 7 * DAY);
  });

  it("a JAN-2027 promise is read within a week, not in December", () => {
    // The exact shape of the door that started this: TENURED + billing N with
    // broadbandService.estimatedCompletionDt "JAN-2027".
    const r = nextRecheckAt({ ...base, promisedDate: "2027-01-01" }, NOW);
    expect(r.dueAtMs).toBe(NOW + 7 * DAY);
  });

  it("honours a configured ceiling", () => {
    const r = nextRecheckAt({ ...base, promisedDate: "2027-01-01", maxWaitDays: 14 }, NOW);
    expect(r.dueAtMs).toBe(NOW + 14 * DAY);
  });

  it("an undated watch rides the observed flip window, then drops to a slow re-read", () => {
    const young = nextRecheckAt({ ...base, promisedDate: null, firstSeenMs: NOW - 5 * DAY }, NOW);
    expect(young.band).toBe("soon");
    expect(young.reason).toBe("flip_window");
    // Past the window an undated promise is months out: a 30-day re-read, not a
    // daily poll. Polling the undated population daily would cost ~24,000
    // checks a month - far more than the once-only law saves.
    const old = nextRecheckAt({ ...base, promisedDate: null, firstSeenMs: NOW - 60 * DAY }, NOW);
    expect(old.band).toBe("watch");
    expect(old.reason).toBe("undated_slow");
    // Capped by the weekly floor: 7 days after the last look, not 30.
    expect(old.dueAtMs).toBe(NOW - 60 * DAY + 7 * DAY);
  });

  it("schedules an undated re-read from the last check when there is one", () => {
    const r = nextRecheckAt({ ...base, promisedDate: null, firstSeenMs: NOW - 60 * DAY, lastCheckedMs: NOW - 2 * 3_600_000 }, NOW);
    expect(r.dueAtMs).toBe(NOW - 2 * 3_600_000 + 7 * DAY);
  });
});
