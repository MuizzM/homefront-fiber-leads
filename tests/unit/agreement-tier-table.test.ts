// ── The rate table inside the Commission Agreement ──────────────────────────
//
// The ladder was already IN the signed document, but only as one semicolon-
// joined run-on sentence ("1–7 qualified sales — $150 per sale; 8–12 …"), and
// the only tier TABLE anywhere was on the onboarding packet's cover sheet — a
// review-only artifact stamped "REVIEW COPY — not signed". Nothing a rep put a
// signature under presented the bands as bands.
//
// Asserted on the SNAPSHOT rather than on rendered PDF bytes: pdfkit stamps a
// creation timestamp, so two renders always differ and a byte comparison would
// pass even if the table never reached the page. The snapshot is the exact
// input renderAgreementBody draws from.
import { describe, expect, it } from "vitest";
import { buildAgreementSnapshot } from "../../server/onboardingAgreementTemplates";
import { FOOTER_RULE_Y, rateTableLayout, renderAgreementPreviewPdf } from "../../server/onboardingPdf";
import { DEFAULT_COMMISSION_TERMS, tierRows, type CommissionTerms } from "@shared/commissionTerms";
import type { CommissionTier } from "@shared/commissionTiers";
import { ONBOARDING_DOCUMENT_TYPES } from "@shared/onboardingDocuments";

const base = {
  companyName: "HomeFront Solutions LLC",
  signerName: "Talal Rep",
  signerEmail: "talal@example.test",
  issuedAt: "2026-08-05T00:00:00.000Z",
};

const agreement = (compTerms?: CommissionTerms) =>
  buildAgreementSnapshot({ ...base, documentType: "commission_agreement", compTerms });

const allRows = (compTerms?: CommissionTerms) =>
  agreement(compTerms).sections.flatMap(section => section.rows ?? []);

/** A ladder with the maximum number of bands the schema allows. */
function twelveBands(): CommissionTier[] {
  return Array.from({ length: 12 }, (_, i) => ({
    position: i,
    minimumSales: i * 2 + 1,
    maximumSales: i === 11 ? null : i * 2 + 2,
    rateCents: 10_000 + i * 2_500,
    label: `band ${i + 1}`,
  }));
}

describe("the commission agreement's rate table", () => {
  it("THE REQUIREMENT: the section carries a row per band", () => {
    const custom: CommissionTerms = {
      ...DEFAULT_COMMISSION_TERMS,
      tiers: [
        { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 17_500, label: "1–6 sales" },
        { position: 1, minimumSales: 7, maximumSales: null, rateCents: 26_000, label: "7+ sales" },
      ],
    };
    expect(allRows(custom)).toEqual([
      { band: "1–6 qualified sales", rate: "$175 per sale" },
      { band: "7+ qualified sales", rate: "$260 per sale" },
    ]);
  });

  it("states the SAME numbers as the prose, because both come from tierRows", () => {
    // A document that contradicts itself about pay is worse than one that says
    // it once, so the two renderings share a source rather than being written
    // out twice.
    const snapshot = agreement(DEFAULT_COMMISSION_TERMS);
    expect(allRows(DEFAULT_COMMISSION_TERMS)).toEqual(tierRows(DEFAULT_COMMISSION_TERMS));
    const prose = snapshot.sections.flatMap(s => s.paragraphs).join("\n");
    for (const row of allRows(DEFAULT_COMMISSION_TERMS)) {
      expect(prose).toContain(row.band);
    }
  });

  it("keeps the retroactive rule in words next to the table", () => {
    // The single most misunderstood term in the plan. A table alone reads as
    // progressive ("the sales above the threshold"), which is not what is paid.
    const prose = agreement(DEFAULT_COMMISSION_TERMS).sections.flatMap(s => s.paragraphs).join("\n");
    expect(prose).toMatch(/RETROACTIVE tier ladder/);
    expect(prose).toMatch(/EVERY qualified sale in that week/);
  });

  it("gives a FLAT plan one row rather than an empty table", () => {
    expect(allRows({ ...DEFAULT_COMMISSION_TERMS, structure: "FLAT", flatRateCents: 22_500, tiers: [] }))
      .toEqual([{ band: "Every qualified sale", rate: "$225 per sale" }]);
  });

  it("puts the table only on the commission agreement", () => {
    for (const documentType of ONBOARDING_DOCUMENT_TYPES) {
      if (documentType === "commission_agreement") continue;
      const snapshot = buildAgreementSnapshot({ ...base, documentType, compTerms: DEFAULT_COMMISSION_TERMS });
      expect(snapshot.sections.flatMap(s => s.rows ?? [])).toEqual([]);
    }
  });

  it("renders a 12-band ladder — the tallest legal one — into a valid PDF", async () => {
    const twelve: CommissionTerms = { ...DEFAULT_COMMISSION_TERMS, tiers: twelveBands() };
    expect(allRows(twelve)).toHaveLength(12);
    const pdf = await renderAgreementPreviewPdf(agreement(twelve));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5_000);
  });

  it("never lets a table cross the footer rule", () => {
    // The agreement body flows continuously and does no break math of its own —
    // pdfkit wraps TEXT across pages, but a fixed-height rectangle just paints
    // wherever it is told, including over the footer. This is that rule, and it
    // is asserted as an invariant rather than by eyeballing a rendered page:
    // for EVERY legal ladder size at EVERY position down the page, a table that
    // is allowed to draw in place must finish above the footer rule.
    for (let rows = 1; rows <= 12; rows += 1) {
      for (let y = 54; y <= FOOTER_RULE_Y; y += 1) {
        const { height, needsBreak } = rateTableLayout(rows, y);
        if (!needsBreak) expect(y + height).toBeLessThan(FOOTER_RULE_Y);
      }
    }
    // And the case that motivated it: 12 bands is 256pt, so anywhere past the
    // middle of the page it must break rather than draw.
    expect(rateTableLayout(12, 500)).toEqual({ height: 256, needsBreak: true });
    expect(rateTableLayout(12, 400).needsBreak).toBe(false);
    // A fresh page always fits the tallest ladder — otherwise it would break
    // forever.
    expect(rateTableLayout(12, 54).needsBreak).toBe(false);
  });

  it("still renders an agreement issued before the table existed", async () => {
    // Legacy snapshots have no `rows` (and no compTerms at all), and packets are
    // rebuilt from stored envelopes — an undefined must not throw on a manager's
    // screen.
    const legacy = agreement();
    const stripped = { ...legacy, sections: legacy.sections.map(({ rows, ...rest }) => rest) };
    const pdf = await renderAgreementPreviewPdf(stripped as typeof legacy);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
