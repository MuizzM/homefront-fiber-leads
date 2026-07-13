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
