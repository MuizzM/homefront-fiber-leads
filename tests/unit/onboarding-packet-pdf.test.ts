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
import { renderOnboardingPacketPdf } from "../../server/onboardingPdf";
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

  it("THE REQUIREMENT: the document changes with the plan the manager chose", async () => {
    // Same signer, same four agreements — only the terms differ. If the choice
    // did not reach the paper, these would be byte-identical.
    const tiered = await packet(DEFAULT_COMMISSION_TERMS);
    const flat = await packet({
      ...DEFAULT_COMMISSION_TERMS, structure: "FLAT", flatRateCents: 22_500, tiers: [], reservePercent: 15,
    });
    expect(flat.equals(tiered)).toBe(false);
  });

  it("a different reserve percentage produces a different document", async () => {
    const ten = await packet({ ...DEFAULT_COMMISSION_TERMS, reservePercent: 10 });
    const twenty = await packet({ ...DEFAULT_COMMISSION_TERMS, reservePercent: 20 });
    expect(ten.equals(twenty)).toBe(false);
  });

  it("renders with no commission terms at all, for a rep issued before terms were stated", async () => {
    const pdf = await packet(undefined);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("renders a partial packet — a rep who has only been sent some agreements", async () => {
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
