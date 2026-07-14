import { describe, expect, it } from "vitest";
import { decideFreshFiberConfirmation, isExplicitFiberTechnology } from "../../shared/freshFiberConfirmation";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const detected = "2026-07-14T10:00:00.000Z";
const base = {
  transitionFresh: true,
  currentFiberAvailable: true,
  customerSegment: "new_opportunity" as const,
  firstDetectedAt: detected,
  nowMs: NOW,
};

describe("fresh fiber confirmation gate", () => {
  it("never calls a baseline-live observation fresh", () => {
    expect(decideFreshFiberConfirmation({ ...base, transitionFresh: false, evidence: [] })).toMatchObject({ status: "rejected", confirmed: false });
  });

  it("keeps a primary-only flip provisional", () => {
    expect(decideFreshFiberConfirmation({ ...base, evidence: [] })).toMatchObject({ status: "provisional", confirmed: false, sources: ["kinetic"] });
  });

  it("does not accept cable, stale, or future evidence as fiber confirmation", () => {
    const evidence = [
      { source: "fcc_bdc_licensed", observedAt: detected, availability: "available" as const, technology: "cable" },
      { source: "third_party_licensed", observedAt: "2026-06-01T00:00:00.000Z", availability: "available" as const, technology: "fiber" },
      { source: "field_verification", observedAt: "2026-07-14T12:06:00.000Z", availability: "available" as const, technology: "FTTP" },
    ];
    expect(decideFreshFiberConfirmation({ ...base, evidence })).toMatchObject({ status: "provisional", confirmed: false });
  });

  it("confirms a fresh no-account flip with recent independent address-level fiber", () => {
    const decision = decideFreshFiberConfirmation({ ...base, evidence: [
      { source: "fcc_bdc_licensed", observedAt: "2026-07-14T11:00:00.000Z", availability: "available", technology: "Fiber to the Premises" },
    ] });
    expect(decision).toMatchObject({ status: "confirmed", confirmed: true, sources: ["kinetic", "fcc_bdc_licensed"] });
    expect(decision.confirmedAt).toBe("2026-07-14T11:00:00.000Z");
  });

  it("treats timezone-less SQLite datetimes as UTC", () => {
    const decision = decideFreshFiberConfirmation({
      ...base,
      firstDetectedAt: "2026-07-14 12:00:00",
      evidence: [{ source: "fcc_bdc_licensed", observedAt: "2026-07-14 12:00:00", availability: "available", technology: "FTTH" }],
    });
    expect(decision).toMatchObject({ status: "confirmed", confirmedAt: "2026-07-14T12:00:00.000Z" });
  });

  it("rejects an existing account and retracts a regressed flip", () => {
    const evidence = [{ source: "field_verification", observedAt: detected, availability: "available" as const, technology: "FTTH" }];
    expect(decideFreshFiberConfirmation({ ...base, customerSegment: "existing_customer", evidence }).status).toBe("rejected");
    expect(decideFreshFiberConfirmation({ ...base, currentFiberAvailable: false, evidence }).status).toBe("regressed");
  });

  it("recognizes only explicit fiber technology labels", () => {
    expect(isExplicitFiberTechnology("FTTP")).toBe(true);
    expect(isExplicitFiberTechnology("fiber optic")).toBe(true);
    expect(isExplicitFiberTechnology("fixed wireless")).toBe(false);
    expect(isExplicitFiberTechnology("cable")).toBe(false);
  });
});
