// The one function that decides what timestamp a commission write may record.
//
// It exists because there were two: `upsertSale` clamped to the correction
// window while `transitionSale`'s QUALIFY wrote the caller's timestamp verbatim,
// so a payload one route refused the other accepted. Everything below is the
// contract both paths now share.
import { describe, expect, it } from "vitest";
import { resolveEffectiveDates, BASIS_FIELD } from "@shared/commissionEffectiveDate";

const RECEIVED = "2026-06-10T12:00:00.000Z";
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(Date.parse(RECEIVED) + offsetDays * DAY).toISOString();

const policy = (over: Partial<Parameters<typeof resolveEffectiveDates>[1]> = {}) => ({
  basis: "QUALIFIED_AT" as const,
  correctionWindowDays: 30,
  serverReceivedAt: RECEIVED,
  ...over,
});

describe("resolveEffectiveDates - the correction window", () => {
  it("leaves a timestamp inside the window untouched", () => {
    const r = resolveEffectiveDates({ soldAt: at(-3), qualifiedAt: at(-2) }, policy());
    expect(r.clamps).toEqual([]);
    expect(r.applied.qualifiedAt).toBe(at(-2));
    expect(r.payWeekMoved).toBe(false);
  });

  it("pulls a backdated value forward to the window floor and says why", () => {
    const r = resolveEffectiveDates({ soldAt: at(-400), qualifiedAt: at(-400) }, policy());
    expect(r.applied.qualifiedAt).toBe(at(-30));
    expect(r.clamps).toHaveLength(2);
    expect(r.clamps.find(c => c.field === "qualifiedAt")).toMatchObject({
      reason: "BEFORE_CORRECTION_WINDOW", requested: at(-400), applied: at(-30), isBasisField: true,
    });
  });

  it("pulls a FUTURE value back to the receipt time - a clock cannot run ahead of the server", () => {
    const r = resolveEffectiveDates({ soldAt: at(5) }, policy());
    expect(r.applied.soldAt).toBe(RECEIVED);
    expect(r.clamps[0]).toMatchObject({ reason: "AFTER_SERVER_RECEIPT", isBasisField: false });
  });

  it("clamps EVERY basis-eligible field, not only soldAt", () => {
    const r = resolveEffectiveDates(
      { soldAt: at(-400), qualifiedAt: at(-400), installedAt: at(-400), activatedAt: at(-400) },
      policy(),
    );
    expect(r.clamps.map(c => c.field).sort()).toEqual(["activatedAt", "installedAt", "qualifiedAt", "soldAt"]);
    for (const v of Object.values(r.applied)) expect(v).toBe(at(-30));
  });

  it("flags payWeekMoved only when the BASIS field moved", () => {
    // Basis is QUALIFIED_AT, and only installedAt is out of window.
    const notBasis = resolveEffectiveDates({ soldAt: at(-2), qualifiedAt: at(-2), installedAt: at(-400) }, policy());
    expect(notBasis.clamps).toHaveLength(1);
    expect(notBasis.payWeekMoved).toBe(false);

    const basis = resolveEffectiveDates({ soldAt: at(-2), qualifiedAt: at(-400) }, policy());
    expect(basis.payWeekMoved).toBe(true);
  });

  it("treats an unparseable timestamp as receipt time rather than writing garbage", () => {
    const r = resolveEffectiveDates({ soldAt: "not-a-date" }, policy());
    expect(r.applied.soldAt).toBe(RECEIVED);
    expect(r.clamps[0].reason).toBe("UNPARSEABLE");
  });
});

describe("resolveEffectiveDates - the trust boundary", () => {
  it("clamps nothing for a trusted in-process caller (no serverReceivedAt)", () => {
    const r = resolveEffectiveDates({ soldAt: at(-400), qualifiedAt: at(-400) }, policy({ serverReceivedAt: null }));
    expect(r.clamps).toEqual([]);
    expect(r.applied.soldAt).toBe(at(-400));   // the boot backfill books real history
  });

  it("an unparseable receipt time falls back to trusting the caller rather than mangling dates", () => {
    const r = resolveEffectiveDates({ soldAt: at(-400) }, policy({ serverReceivedAt: "garbage" }));
    expect(r.clamps).toEqual([]);
    expect(r.applied.soldAt).toBe(at(-400));
  });
});

describe("resolveEffectiveDates - basis selection", () => {
  it("picks the basis timestamp per the configured basis", () => {
    const input = { soldAt: at(-5), qualifiedAt: at(-4), installedAt: at(-3), activatedAt: at(-2) };
    expect(resolveEffectiveDates(input, policy({ basis: "SOLD_AT" })).basisTs).toBe(at(-5));
    expect(resolveEffectiveDates(input, policy({ basis: "QUALIFIED_AT" })).basisTs).toBe(at(-4));
    expect(resolveEffectiveDates(input, policy({ basis: "INSTALLED_AT" })).basisTs).toBe(at(-3));
    expect(resolveEffectiveDates(input, policy({ basis: "ACTIVATED_AT" })).basisTs).toBe(at(-2));
  });

  it("falls back to soldAt when the basis column is not stamped yet", () => {
    const r = resolveEffectiveDates({ soldAt: at(-5) }, policy({ basis: "INSTALLED_AT" }));
    expect(r.basisTs).toBe(at(-5));
  });

  it("BASIS_FIELD maps every basis to its input field", () => {
    expect(BASIS_FIELD).toEqual({
      SOLD_AT: "soldAt", QUALIFIED_AT: "qualifiedAt", INSTALLED_AT: "installedAt", ACTIVATED_AT: "activatedAt",
    });
  });

  it("a zero-day correction window pins everything to receipt time", () => {
    const r = resolveEffectiveDates({ soldAt: at(-1) }, policy({ correctionWindowDays: 0 }));
    expect(r.applied.soldAt).toBe(RECEIVED);
  });
});
