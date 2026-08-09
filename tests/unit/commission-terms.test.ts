// ── The paperwork states the rep's actual numbers ───────────────────────────
//
// THE BUG: `commissionSections(_ctx)` took a context and ignored it. Every rep,
// on every plan, signed the same sentence — "the commission structure assigned
// to the Contractor in the Home Front portal" — with no rate, no ladder, and a
// hardcoded 10% reserve, whatever a manager had actually configured. A signer
// could not read what they would be paid, and a rep on a 0% or 20% hold signed
// a document that said 10%.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMISSION_TERMS,
  describeCommissionTerms,
  normalizeCommissionTerms,
  summarizeCommissionTerms,
  tierRows,
  type CommissionTerms,
} from "@shared/commissionTerms";
import { buildAgreementSnapshot } from "../../server/onboardingAgreementTemplates";

const ctx = {
  companyName: "HomeFront Solutions LLC",
  signerName: "Talal Rep",
  signerEmail: "Talal@Example.Test",
  issuedAt: "2026-08-05T00:00:00.000Z",
};
const commissionText = (compTerms?: CommissionTerms) =>
  buildAgreementSnapshot({ ...ctx, documentType: "commission_agreement", compTerms })
    .sections.flatMap((s) => s.paragraphs).join("\n");

describe("normalizeCommissionTerms", () => {
  it("defaults to the house tiered plan", () => {
    const { ok, normalized } = normalizeCommissionTerms(undefined);
    expect(ok).toBe(true);
    expect(normalized.structure).toBe("TIERED");
    expect(normalized.tiers.length).toBeGreaterThan(0);
  });

  it("refuses a flat plan with no rate rather than inventing one", () => {
    const { ok, errors } = normalizeCommissionTerms({ structure: "FLAT", flatRateCents: 0 });
    expect(ok).toBe(false);
    expect(errors.join(" ")).toMatch(/rate per qualified sale/i);
  });

  it("delegates ladder correctness to validateTiers instead of re-implementing it", () => {
    // A gap between bands: 1–7 then 9+. The commission engine would refuse to
    // pay against this, so a contract must never state it.
    const { ok, errors } = normalizeCommissionTerms({
      structure: "TIERED",
      tiers: [
        { position: 0, minimumSales: 1, maximumSales: 7, rateCents: 15000, label: "" },
        { position: 1, minimumSales: 9, maximumSales: null, rateCents: 20000, label: "" },
      ],
    });
    expect(ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("clamps a reserve percentage into 0..100", () => {
    expect(normalizeCommissionTerms({ reservePercent: 140 }).normalized.reservePercent).toBe(100);
    expect(normalizeCommissionTerms({ reservePercent: -5 }).normalized.reservePercent).toBe(0);
  });

  it("keeps a 0% reserve as a real choice, not a missing value", () => {
    const { normalized } = normalizeCommissionTerms({ reservePercent: 0 });
    expect(normalized.reservePercent).toBe(0);
  });
});

describe("the commission agreement states the terms", () => {
  it("THE REQUIREMENT: a flat plan prints its actual rate", () => {
    const text = commissionText({ ...DEFAULT_COMMISSION_TERMS, structure: "FLAT", flatRateCents: 17500, tiers: [] });
    expect(text).toContain("$175");
    expect(text).toMatch(/for each qualified sale/i);
  });

  it("THE REQUIREMENT: a tiered plan prints every band and rate", () => {
    const text = commissionText(DEFAULT_COMMISSION_TERMS);
    for (const row of tierRows(DEFAULT_COMMISSION_TERMS)) {
      expect(text).toContain(row.band);
      expect(text).toContain(row.rate);
    }
  });

  it("prints the rep's OWN reserve percentage, not a hardcoded 10", () => {
    const text = commissionText({ ...DEFAULT_COMMISSION_TERMS, reservePercent: 20 });
    expect(text).toContain("20% of otherwise payable commissions");
    expect(text).toContain("80% is paid");
    expect(text).not.toContain("10% of otherwise payable commissions");
  });

  it("says plainly when nothing is withheld, instead of describing a reserve", () => {
    const text = commissionText({ ...DEFAULT_COMMISSION_TERMS, reservePercent: 0 });
    expect(text).toMatch(/No chargeback reserve is withheld/i);
  });

  it("explains the retroactive rule in words - the most misread term in the plan", () => {
    const text = commissionText(DEFAULT_COMMISSION_TERMS);
    expect(text).toMatch(/applies to EVERY qualified sale/i);
    expect(text).toMatch(/not only to the sales above/i);
  });

  it("states the reserve cap when there is one", () => {
    const text = commissionText({ ...DEFAULT_COMMISSION_TERMS, reserveCapCents: 250_000 });
    expect(text).toContain("$2,500");
  });

  it("freezes the structured terms in the snapshot, not just the prose", () => {
    // "What was this rep actually promised" should be answerable by reading
    // data later, not by re-parsing a paragraph.
    const snap = buildAgreementSnapshot({
      ...ctx, documentType: "commission_agreement",
      compTerms: { ...DEFAULT_COMMISSION_TERMS, reservePercent: 15 },
    });
    expect(snap.compTerms?.reservePercent).toBe(15);
  });

  it("does not attach comp terms to unrelated documents", () => {
    const snap = buildAgreementSnapshot({
      ...ctx, documentType: "field_safety", compTerms: DEFAULT_COMMISSION_TERMS,
    });
    expect(snap.compTerms).toBeUndefined();
  });

  it("still renders for a caller that passes no terms at all", () => {
    // Back-compat: an older call path must not throw, and must still produce a
    // document with real numbers rather than an empty promise.
    const text = commissionText(undefined);
    expect(text).toContain("$150");
  });

  it("moves the agreement version, so the change is re-consented", () => {
    // The "sign the current version" gate is how material term changes get
    // re-signed; stating numbers where there were none is material.
    const snap = buildAgreementSnapshot({ ...ctx, documentType: "commission_agreement" });
    expect(snap.documentVersion).toBe("2026.08.4");
  });
});

describe("summarizeCommissionTerms", () => {
  it("reads as an offer at a glance", () => {
    expect(summarizeCommissionTerms({ ...DEFAULT_COMMISSION_TERMS, structure: "FLAT", flatRateCents: 20000, tiers: [] }))
      .toBe("Flat $200/sale · 10% reserve");
    expect(summarizeCommissionTerms({ ...DEFAULT_COMMISSION_TERMS, reservePercent: 0 }))
      .toContain("no reserve");
  });
});

describe("describeCommissionTerms", () => {
  it("never returns an empty description - a contract clause cannot be blank", () => {
    for (const terms of [
      DEFAULT_COMMISSION_TERMS,
      { ...DEFAULT_COMMISSION_TERMS, structure: "FLAT" as const, flatRateCents: 1, tiers: [] },
      { ...DEFAULT_COMMISSION_TERMS, reservePercent: 0 },
    ]) {
      const out = describeCommissionTerms(terms);
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((p) => p.trim().length > 20)).toBe(true);
    }
  });
});
