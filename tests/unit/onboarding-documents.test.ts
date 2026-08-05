import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ELECTRONIC_CONSENT_DISCLOSURE,
  ELECTRONIC_CONSENT_VERSION,
  canOpenSigning,
  signerNameMatches,
} from "../../shared/onboardingDocuments";
import { AGREEMENT_VERSION, buildAgreementSnapshot } from "../../server/onboardingAgreementTemplates";
import { renderSignedAgreementPdf } from "../../server/onboardingPdf";

describe("Home Front Sign regulated core", () => {
  const snapshot = buildAgreementSnapshot({
    documentType: "independent_contractor",
    companyName: "Home Front Solutions LLC",
    signerName: "Jordan Rep",
    signerEmail: "JORDAN@example.com",
    issuedAt: "2026-07-13T12:00:00.000Z",
  });

  it("builds a complete, versioned agreement snapshot", () => {
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.documentVersion).toBe(AGREEMENT_VERSION);
    expect(snapshot.signerEmail).toBe("jordan@example.com");
    expect(snapshot.sections.length).toBeGreaterThanOrEqual(5);
    expect(snapshot.sections.every(section => section.heading && (section.paragraphs.length || section.bullets?.length))).toBe(true);
  });

  it("requires the typed signature to match the assigned signer", () => {
    expect(signerNameMatches("Jordan   Rep", " jordan rep ")).toBe(true);
    expect(signerNameMatches("Jordan Rep", "Jordan R.")).toBe(false);
  });

  it("permits signing only for pending records", () => {
    expect(canOpenSigning("sent")).toBe(true);
    expect(canOpenSigning("delivered")).toBe(true);
    expect(canOpenSigning("completed")).toBe(false);
    expect(canOpenSigning("declined")).toBe(false);
    expect(canOpenSigning("failed")).toBe(false);
  });

  it("ships an explicit electronic-record disclosure", () => {
    expect(ELECTRONIC_CONSENT_VERSION).toMatch(/^esign-disclosure-/);
    expect(ELECTRONIC_CONSENT_DISCLOSURE.paragraphs.join(" ")).toContain("paper copy");
    expect(ELECTRONIC_CONSENT_DISCLOSURE.paragraphs.join(" ")).toContain("PDF");
  });

  it("renders a signed PDF containing the certificate and hashes", async () => {
    const contentSha256 = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const pdf = await renderSignedAgreementPdf(snapshot, {
      recordId: "a4db9aa5-f614-4108-bfb1-79aef96550e8",
      signerName: snapshot.signerName,
      signerEmail: snapshot.signerEmail,
      signedAt: "2026-07-13T13:00:00.000Z",
      authenticatedUserId: 42,
      ipAddress: "127.0.0.1",
      userAgent: "Vitest",
      contentSha256,
      signatureSha256: "a".repeat(64),
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(3_000);
  });
});

describe("Commission Agreement — required terms (spec)", () => {
  const commission = buildAgreementSnapshot({
    documentType: "commission_agreement",
    companyName: "Home Front Solutions LLC",
    signerName: "Jordan Rep",
    signerEmail: "jordan@example.com",
    issuedAt: "2026-08-01T12:00:00.000Z",
  });
  const text = commission.sections.flatMap(s => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])]).join("\n");

  it("names the Company with its legal address, then uses 'the Company' thereafter", () => {
    expect(text).toContain("HomeFront Solutions LLC");
    expect(text).toContain("605 Abbie Ave, High Point, NC 27263");
    expect(text).toContain("the “Company”");
    // The full legal name is used sparingly — not on every reference.
    expect((text.match(/HomeFront Solutions LLC/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it("states the 10% chargeback reserve and the 90-day post-termination release", () => {
    expect(text).toMatch(/withhold 10% of otherwise payable commissions as a chargeback reserve/i);
    expect(text).toMatch(/within 90 days after the effective termination date/i);
    expect(text).toMatch(/less valid chargebacks, reversals, offsets, debts, overpayments/i);
  });

  it("defines how the reserve is calculated, displayed, and reconciled", () => {
    expect(text).toMatch(/calculated per pay period/i);
    expect(text).toMatch(/shown on the Contractor’s commission statements/i);
    expect(text).toMatch(/drawn first against the reserve/i);
    expect(text).toMatch(/below any limit imposed by applicable law/i);
  });

  it("lists the full validation / reversal grounds", () => {
    for (const ground of ["validation", "cancellation", "nonpayment", "fraud", "duplicate orders",
      "installation requirements", "customer eligibility", "carrier", "reversals", "chargebacks"]) {
      expect(text.toLowerCase()).toContain(ground.toLowerCase());
    }
  });

  it("binds obligations to the Company alone with NO personal liability or guarantee", () => {
    expect(text).toMatch(/obligations of the Company alone/i);
    expect(text).toMatch(/representative capacity/i);
    expect(text).toMatch(/not personally liable/i);
    expect(text).toMatch(/does not create any personal guarantee/i);
    // Muizz Muhammad is never named as a personal obligor in the signer-facing text.
    expect(text).not.toContain("Muizz");
  });

  it("does not smuggle the internal counsel-review note into the signed agreement", () => {
    expect(text).not.toMatch(/North Carolina counsel/i);
    expect(text).not.toMatch(/INTERNAL LEGAL-REVIEW/i);
  });

  it("bumped the version so existing reps must re-accept the material change", () => {
    // 2026.08.1 → 2026.08.2 when the Commission Agreement started STATING the
    // rep's rate, tier ladder and reserve percentage instead of incorporating
    // "the structure assigned in the portal" by reference. This assertion is
    // meant to fail on a material change — that is how the re-consent gate gets
    // considered rather than skipped — so updating it is part of making one.
    expect(AGREEMENT_VERSION).toBe("2026.08.2");
    expect(commission.documentVersion).toBe("2026.08.2");
  });
});
