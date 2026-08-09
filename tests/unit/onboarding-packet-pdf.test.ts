// ── The whole engagement, in one PDF ────────────────────────────────────────
//
// A rep had to open four separate agreements to see what they were joining, so
// "what am I actually agreeing to" was four downloads and no single view. The
// packet is all of them in one file, cover sheet first, with the commission
// terms lifted onto the cover — the rate is what a rep opens this to find and
// it should not be on page nine.
//
// Asserted structurally rather than by parsing text: pdfkit compresses its
// content streams, and adding a PDF parser to prove a string is present would
// be a dependency bought for a test. The content itself is covered by
// tests/unit/commission-terms.test.ts against the snapshot the PDF renders.
import { describe, expect, it } from "vitest";
import { buildAgreementSnapshot } from "../../server/onboardingAgreementTemplates";
import { accentFor, BRAND, renderOnboardingPacketPdf } from "../../server/onboardingPdf";
import { ONBOARDING_DOCUMENT_TYPES } from "@shared/onboardingDocuments";
import { DEFAULT_COMMISSION_TERMS, type CommissionTerms } from "@shared/commissionTerms";

const base = {
  companyName: "HomeFront Solutions LLC",
  signerName: "Talal Rep",
  signerEmail: "talal@example.test",
  issuedAt: "2026-08-05T00:00:00.000Z",
};

function packet(compTerms?: CommissionTerms, types = ONBOARDING_DOCUMENT_TYPES) {
  const snapshots = types.map((documentType) => buildAgreementSnapshot({ ...base, documentType, compTerms }));
  return renderOnboardingPacketPdf({
    snapshots,
    signerName: base.signerName,
    signerEmail: base.signerEmail,
    companyName: base.companyName,
  });
}

describe("the onboarding packet", () => {
  it("renders every agreement into ONE valid PDF", async () => {
    const pdf = await packet(DEFAULT_COMMISSION_TERMS);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // Four agreements plus a cover and the consent disclosure — a stub would be
    // a few hundred bytes, so this catches "rendered nothing" without pinning a
    // brittle exact size.
    expect(pdf.length).toBeGreaterThan(15_000);
  });

  it("THE REQUIREMENT: the plan reaches the pages the PDF is built from", async () => {
    // Asserted on the SNAPSHOT, not on rendered bytes: pdfkit stamps a creation
    // timestamp, so two renders always differ and a byte comparison would pass
    // even if the terms never reached the document. The snapshot is the exact
    // input renderAgreementBody draws, so proving it carries the numbers proves
    // the page does.
    const flat = buildAgreementSnapshot({
      ...base, documentType: "commission_agreement",
      compTerms: { ...DEFAULT_COMMISSION_TERMS, structure: "FLAT", flatRateCents: 22_500, tiers: [], reservePercent: 15 },
    });
    const text = flat.sections.flatMap((s) => s.paragraphs).join("\n");
    expect(text).toContain("$225");
    expect(text).toContain("15% of otherwise payable commissions");
    // And it still renders.
    const pdf = await packet({ ...DEFAULT_COMMISSION_TERMS, structure: "FLAT", flatRateCents: 22_500, tiers: [], reservePercent: 15 });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("renders with no commission terms at all, for a rep issued before terms were stated", async () => {
    const pdf = await packet(undefined);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("renders a partial packet - a rep who has only been sent some agreements", async () => {
    const pdf = await packet(DEFAULT_COMMISSION_TERMS, ["independent_contractor", "commission_agreement"] as const);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(8_000);
  });

  it("renders a packet with no commission agreement in it at all", async () => {
    // The cover reads the terms off the commission agreement; without one it
    // must still produce a document rather than throwing on a missing field.
    const pdf = await packet(DEFAULT_COMMISSION_TERMS, ["field_safety"] as const);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("branding", () => {
  it("embeds the logo - the asset must actually reach the production image", async () => {
    // The logo ships to dist/public via Vite and is read from beside the bundle
    // at runtime. If that path is ever wrong the renderer degrades silently to
    // a wordmark, which looks fine in review and wrong on a signed contract.
    // A text-only packet is ~40 KB; an embedded PNG takes it past 200 KB.
    const pdf = await packet(DEFAULT_COMMISSION_TERMS);
    expect(pdf.length).toBeGreaterThan(200_000);
  });

  // The accent is tested DIRECTLY rather than by diffing two rendered PDFs.
  // pdfkit stamps a creation timestamp into every document, so any two renders
  // differ byte-for-byte whatever their content — a comparison that "passes"
  // tells you nothing about the colour. (An earlier version of this file made
  // exactly that mistake and read as green.)
  it("uses the tenant's own brand colour when one is set", () => {
    expect(accentFor("#7C3AED")).toBe("#7C3AED");
    expect(accentFor("  #7c3aed  ")).toBe("#7c3aed");
  });

  it("falls back to the house teal for anything unusable", () => {
    for (const bad of ["", "red", "#GGGGGG", "#12345", "12345678", null, undefined]) {
      expect(accentFor(bad as string | null)).toBe(BRAND.teal);
    }
  });

  it("renders with a custom colour without throwing", async () => {
    const snapshots = ONBOARDING_DOCUMENT_TYPES.map((documentType) =>
      buildAgreementSnapshot({ ...base, documentType, compTerms: DEFAULT_COMMISSION_TERMS }));
    const pdf = await renderOnboardingPacketPdf({
      snapshots, signerName: base.signerName, signerEmail: base.signerEmail,
      companyName: base.companyName, brandColor: "#7C3AED",
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
