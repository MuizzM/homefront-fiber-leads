// The offer catalog: effective dating, automatic expiry, and the claim check.
//
// This is the module that makes "never allow unsupported claims" a mechanism
// rather than a policy sentence, so these tests are the contract for it:
// an expired promotion must vanish from every surface on its end date, and a
// number nobody configured must be flagged wherever a rep types it.
import { describe, expect, it } from "vitest";
import {
  COMPETITOR_STALE_DAYS, DEFAULT_OFFER_CATALOG,
  activeOffers, calendarDay, centsToUsd, competitorOffers, daysBetween,
  effectivePriceCents, expiredOffers, headlineOffer, isCalendarDate,
  isCompetitorStale, isOfferActive, isOfferExpired, requiredDisclosures,
  validateOffer, verifyClaim,
  type AcademyOffer, type CompetitorOffer, type OfferCatalog,
} from "../../shared/academyOffers";

function offer(over: Partial<AcademyOffer> = {}): AcademyOffer {
  return {
    id: "test-offer", provider: "kinetic", market: "*", name: "Test Fiber",
    downloadMbps: 1000, uploadMbps: 1000,
    priceCents: 6999, promoPriceCents: null, promoMonths: null,
    termMonths: 0, equipmentCents: 0, installCents: 0, unlimitedData: true,
    effectiveFrom: "2026-01-01", effectiveTo: null, disclosures: [],
    ...over,
  };
}

function catalog(offers: AcademyOffer[], competitors: CompetitorOffer[] = []): OfferCatalog {
  return { version: 1, offers, competitors };
}

describe("calendar dates", () => {
  it("accepts real yyyy-mm-dd dates and rejects everything else", () => {
    expect(isCalendarDate("2026-08-10")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-8-1")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
  });

  it("reads the calendar day off an instant in UTC", () => {
    expect(calendarDay(new Date("2026-08-10T23:30:00Z"))).toBe("2026-08-10");
  });

  it("counts whole days between dates", () => {
    expect(daysBetween("2026-08-01", "2026-08-10")).toBe(9);
    expect(daysBetween("2026-08-10", "2026-08-01")).toBe(-9);
  });
});

describe("effective dating", () => {
  it("is inactive before its start date", () => {
    const o = offer({ effectiveFrom: "2026-09-01" });
    expect(isOfferActive(o, "2026-08-31")).toBe(false);
    expect(isOfferActive(o, "2026-09-01")).toBe(true);
  });

  it("is active on its last day and expired the day after", () => {
    const o = offer({ effectiveFrom: "2026-01-01", effectiveTo: "2026-08-10" });
    expect(isOfferActive(o, "2026-08-10")).toBe(true);
    expect(isOfferExpired(o, "2026-08-10")).toBe(false);
    expect(isOfferActive(o, "2026-08-11")).toBe(false);
    expect(isOfferExpired(o, "2026-08-11")).toBe(true);
  });

  it("drops an expired promotion out of activeOffers and into expiredOffers", () => {
    const live = offer({ id: "live" });
    const dead = offer({ id: "dead", effectiveTo: "2026-08-01" });
    const c = catalog([live, dead]);
    expect(activeOffers(c, { day: "2026-08-10" }).map((o) => o.id)).toEqual(["live"]);
    expect(expiredOffers(c, { day: "2026-08-10" }).map((o) => o.id)).toEqual(["dead"]);
  });

  it("returns nothing quotable once every offer in a market has expired", () => {
    const c = catalog([offer({ id: "a", effectiveTo: "2026-07-01" }), offer({ id: "b", effectiveTo: "2026-08-01" })]);
    expect(activeOffers(c, { day: "2026-08-10" })).toHaveLength(0);
    expect(headlineOffer(c, { day: "2026-08-10" })).toBeNull();
    // Most recently expired first, so the UI can say when the market went quiet.
    expect(expiredOffers(c, { day: "2026-08-10" }).map((o) => o.id)).toEqual(["b", "a"]);
  });
});

describe("market scoping", () => {
  it("matches wildcard offers in every market", () => {
    const c = catalog([offer({ id: "everywhere", market: "*" })]);
    expect(activeOffers(c, { day: "2026-08-10", market: "nc-lexington" }).map((o) => o.id)).toEqual(["everywhere"]);
  });

  it("excludes an offer scoped to a different market", () => {
    const c = catalog([offer({ id: "sc-only", market: "sc-camden" })]);
    expect(activeOffers(c, { day: "2026-08-10", market: "nc-lexington" })).toHaveLength(0);
  });

  it("sorts the market-specific offer above the provider-wide fallback", () => {
    const c = catalog([
      offer({ id: "fallback", market: "*", downloadMbps: 500 }),
      offer({ id: "local", market: "nc-lexington", downloadMbps: 2000 }),
    ]);
    expect(activeOffers(c, { day: "2026-08-10", market: "nc-lexington" }).map((o) => o.id))
      .toEqual(["local", "fallback"]);
  });

  it("filters by provider", () => {
    const c = catalog([offer({ id: "k", provider: "kinetic" }), offer({ id: "s", provider: "spectrum" })]);
    expect(activeOffers(c, { day: "2026-08-10", provider: "kinetic" }).map((o) => o.id)).toEqual(["k"]);
  });
});

describe("pricing", () => {
  it("uses the promotional rate plus equipment as the first-month cost", () => {
    expect(effectivePriceCents(offer({ priceCents: 6999, promoPriceCents: 4999, promoMonths: 12, equipmentCents: 500 })))
      .toBe(5499);
  });

  it("picks the cheapest live offer as the headline", () => {
    const c = catalog([
      offer({ id: "gig", priceCents: 6999 }),
      offer({ id: "cheap", priceCents: 5499 }),
      offer({ id: "expired-cheaper", priceCents: 1999, effectiveTo: "2026-01-01" }),
    ]);
    expect(headlineOffer(c, { day: "2026-08-10" })?.id).toBe("cheap");
  });

  it("prints whole dollars without cents, and cents when they exist", () => {
    expect(centsToUsd(7000)).toBe("$70");
    expect(centsToUsd(5499)).toBe("$54.99");
    expect(centsToUsd(0)).toBe("$0");
  });
});

describe("disclosures", () => {
  it("adds the promotional-rollover sentence whenever a promo price exists", () => {
    const lines = requiredDisclosures(offer({ promoPriceCents: 4999, promoMonths: 12 }));
    expect(lines.join(" ")).toContain("12 months");
  });

  it("adds a term disclosure only when there is a term", () => {
    expect(requiredDisclosures(offer({ termMonths: 0 })).join(" ")).not.toContain("term");
    expect(requiredDisclosures(offer({ termMonths: 24 })).join(" ")).toContain("24 month term");
  });

  it("never repeats an authored disclosure", () => {
    const lines = requiredDisclosures(offer({ disclosures: ["Checked at the address.", "Checked at the address."] }));
    expect(lines).toEqual(["Checked at the address."]);
  });
});

describe("claim verification", () => {
  const live = [offer({ priceCents: 6999, downloadMbps: 1000, uploadMbps: 1000 })];

  it("passes a sentence whose numbers all match a live offer", () => {
    expect(verifyClaim("It's 1000 Mbps and it runs $69.99 a month.", live)).toHaveLength(0);
  });

  it("understands gig as a thousand megabits", () => {
    expect(verifyClaim("You'd be on a 1 gig plan.", live)).toHaveLength(0);
  });

  it("flags a price no live offer supports", () => {
    const issues = verifyClaim("I can do it for $45 a month.", live);
    expect(issues.map((i) => i.kind)).toContain("price");
    expect(issues[0].fragment).toContain("45");
  });

  it("flags a speed no live plan runs at", () => {
    expect(verifyClaim("You'd get 5000 Mbps.", live).map((i) => i.kind)).toContain("speed");
  });

  it("flags every number when the market has no live offer at all", () => {
    const issues = verifyClaim("It's $70 for a gig.", []);
    expect(issues.map((i) => i.kind).sort()).toEqual(["price", "speed"]);
    expect(issues[0].message).toContain("no live offer");
  });

  it("flags superlatives, which are unverifiable at a door", () => {
    for (const line of ["We're the fastest around.", "It's the cheapest option.", "It never goes down."]) {
      expect(verifyClaim(line, live).some((i) => i.kind === "superlative"), line).toBe(true);
    }
  });

  it("flags guarantees a rep cannot make", () => {
    expect(verifyClaim("I guarantee your bill drops.", live).some((i) => i.kind === "guarantee")).toBe(true);
    expect(verifyClaim("That price will never increase.", live).some((i) => i.kind === "guarantee")).toBe(true);
  });

  it("flags asserting serviceability before the address is checked", () => {
    expect(verifyClaim("You already have it at your house.", live).some((i) => i.kind === "availability")).toBe(true);
  });

  it("offers a supportable alternative when there is one", () => {
    const issue = verifyClaim("It's $45.", live).find((i) => i.kind === "price");
    expect(issue?.suggestion).toContain("$69.99");
  });
});

describe("competitor staleness", () => {
  const competitor: CompetitorOffer = {
    id: "spectrum-500", provider: "spectrum", market: "*", name: "Spectrum 500",
    downloadMbps: 500, uploadMbps: 20, priceCents: 7999, medium: "cable",
    source: "Published rate card", asOf: "2026-01-01",
  };

  it("marks a figure stale past the window", () => {
    expect(isCompetitorStale(competitor, "2026-03-01")).toBe(false);
    const past = new Date(Date.UTC(2026, 0, 1) + (COMPETITOR_STALE_DAYS + 1) * 86_400_000);
    expect(isCompetitorStale(competitor, calendarDay(past))).toBe(true);
  });

  it("sorts stale figures last", () => {
    const fresh = { ...competitor, id: "fresh", asOf: "2026-08-01" };
    const c = catalog([], [competitor, fresh]);
    const day = calendarDay(new Date(Date.UTC(2026, 7, 10)));
    expect(competitorOffers(c, { day }).map((o) => o.id)).toEqual(["fresh", "spectrum-500"]);
  });
});

describe("offer validation", () => {
  it("accepts a well-formed offer", () => {
    expect(validateOffer(offer())).toEqual([]);
  });

  it("requires a slug-shaped id", () => {
    expect(validateOffer(offer({ id: "Has Spaces" })).join(" ")).toContain("id must be");
  });

  it("refuses a promotional price with no length, because that is just the price", () => {
    const errors = validateOffer(offer({ promoPriceCents: 4999, promoMonths: null }));
    expect(errors.join(" ")).toContain("promoMonths");
  });

  it("refuses an end date before the start date", () => {
    const errors = validateOffer(offer({ effectiveFrom: "2026-08-10", effectiveTo: "2026-08-01" }));
    expect(errors.join(" ")).toContain("cannot be before");
  });

  it("requires a start date", () => {
    expect(validateOffer(offer({ effectiveFrom: "soon" as any })).join(" ")).toContain("effectiveFrom");
  });
});

describe("the seeded catalog", () => {
  it("ships offers that are quotable today", () => {
    const day = calendarDay(new Date());
    expect(activeOffers(DEFAULT_OFFER_CATALOG, { day }).length).toBeGreaterThan(0);
  });

  it("scopes every seeded offer to every market and carries a confirm-at-the-address disclosure", () => {
    for (const o of DEFAULT_OFFER_CATALOG.offers) {
      expect(o.market, o.id).toBe("*");
      expect(o.disclosures.join(" ").toLowerCase(), o.id).toContain("confirmed at the address");
    }
  });

  it("validates", () => {
    for (const o of DEFAULT_OFFER_CATALOG.offers) expect(validateOffer(o), o.id).toEqual([]);
  });
});
