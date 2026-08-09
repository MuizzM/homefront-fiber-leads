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

describe("Commission Agreement - required terms (spec)", () => {
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
    // Moves whenever signer-facing terms change materially (2026.08.2 stated the
    // rep's rate, tier ladder and reserve percentage instead of incorporating
    // "the structure assigned in the portal" by reference; 2026.08.4 prints that
    // ladder as a rate table AND — the substantive half — carries the ladder a
    // manager chose when INVITING the candidate into the document, where before
    // a TIERED invite with no ladder silently contracted on the house bands).
    // This assertion is meant to fail on a material change — that is how the
    // re-consent gate gets considered rather than skipped — so updating it is
    // part of making one.
    expect(AGREEMENT_VERSION).toBe("2026.08.4");
    expect(commission.documentVersion).toBe("2026.08.4");
  });
});

// ── The protective provisions ───────────────────────────────────────────────
//
// The Independent Contractor Agreement was six thin sections: engagement,
// "you're a contractor", standards, records, termination, entire agreement. For
// a commission-only, 1099, door-to-door engagement that left out most of what
// actually protects the company when something goes wrong at somebody's front
// door — indemnification, insurance, licensing and solicitation-law compliance,
// ownership of leads, offset, a limitation of liability, and any governing-law
// or venue clause at all.
//
// These assert the clauses EXIST. They deliberately do not assert they are
// enforceable — that is counsel's call, and the file's internal review note
// says so. A test cannot make a clause good law; it can stop one silently
// disappearing in a later edit.
describe("Independent Contractor Agreement - protective provisions", () => {
  const ic = buildAgreementSnapshot({
    documentType: "independent_contractor",
    companyName: "HomeFront Solutions LLC",
    signerName: "Talal Rep",
    signerEmail: "talal@example.test",
    issuedAt: "2026-08-05T00:00:00.000Z",
  });
  const body = ic.sections.flatMap(s => [s.heading, ...s.paragraphs]).join("\n");

  it("states 1099 treatment and that nothing is withheld", () => {
    expect(body).toMatch(/1099-NEC/);
    expect(body).toMatch(/will NOT withhold/i);
    expect(body).toMatch(/Form W-9/);
    expect(body).toMatch(/self-employment tax/i);
  });

  it("says commission-only and promises no minimum", () => {
    expect(body).toMatch(/does not guarantee any minimum/i);
    expect(body).toMatch(/NON-EXCLUSIVE/);
  });

  it("supports the classification with control and equipment facts, not just a label", () => {
    // Calling someone a contractor does not make them one; these are the facts
    // the IRS common-law test actually looks at.
    expect(body).toMatch(/controls the manner, means, methods/i);
    expect(body).toMatch(/directs the RESULT/);
    expect(body).toMatch(/own vehicle, phone, and ordinary equipment/i);
    expect(body).toMatch(/NO authority to bind/i);
  });

  it("requires licences and names the solicitation laws that apply to knocking doors", () => {
    expect(body).toMatch(/Telephone Consumer Protection Act/);
    expect(body).toMatch(/Do-Not-Call/i);
    expect(body).toMatch(/home-solicitation/i);
    expect(body).toMatch(/Cooling-Off Rule/i);
    expect(body).toMatch(/trespass/i);
  });

  it("carries an indemnity that survives, including a misclassification claim", () => {
    expect(body).toMatch(/indemnify, defend, and hold harmless/i);
    expect(body).toMatch(/were employees of the Company/i);
    expect(body).toMatch(/survives termination/i);
  });

  it("limits the company's liability and caps it", () => {
    expect(body).toMatch(/total cumulative liability/i);
    expect(body).toMatch(/ninety \(90\) days/);
    expect(body).toMatch(/consequential/i);
  });

  it("requires insurance", () => {
    expect(body).toMatch(/automobile liability insurance/i);
  });

  it("keeps leads and customer data as company property", () => {
    expect(body).toMatch(/exclusive property of the Company/i);
    expect(body).toMatch(/assigns it to the Company/i);
  });

  it("allows offset, and stops short of what the law forbids", () => {
    expect(body).toMatch(/set off against any amount/i);
    expect(body).toMatch(/below any limit imposed by applicable law/i);
  });

  it("keeps the non-solicit narrow, which is what makes it survivable", () => {
    // An overbroad restraint is struck rather than narrowed in NC; widening
    // this makes it likelier to fail entirely.
    expect(body).toMatch(/twelve \(12\) months/);
    expect(body).toMatch(/personally sold or serviced/i);
    expect(body).toMatch(/does not restrict Contractor from working in the industry/i);
  });

  it("names governing law and a venue", () => {
    expect(body).toMatch(/laws of the State of North Carolina/i);
    expect(body).toMatch(/Guilford County/);
  });

  it("says which sections survive, and severs rather than collapses", () => {
    expect(body).toMatch(/SURVIVAL/);
    expect(body).toMatch(/SEVERABILITY/);
  });

  it("still keeps the internal counsel-review note out of the signer's copy", () => {
    expect(body).not.toMatch(/North Carolina counsel/i);
    expect(body).not.toMatch(/INTERNAL LEGAL-REVIEW/i);
    expect(body).not.toMatch(/misclassification exposure/i);
  });
});

describe("Commission Agreement - commission-only and post-termination", () => {
  const ca = buildAgreementSnapshot({
    documentType: "commission_agreement",
    companyName: "HomeFront Solutions LLC",
    signerName: "Talal Rep",
    signerEmail: "talal@example.test",
    issuedAt: "2026-08-05T00:00:00.000Z",
  });
  const body = ca.sections.flatMap(s => [s.heading, ...s.paragraphs]).join("\n");

  it("says commission-only, with no wage, draw or guarantee", () => {
    expect(body).toMatch(/COMMISSION ONLY/);
    expect(body).toMatch(/not paid a salary, wage, hourly rate, draw, guarantee, or minimum/i);
  });

  it("answers the sale that installs after the rep leaves", () => {
    // The most common commission dispute; silence is what produces the argument.
    expect(body).toMatch(/Post-termination commissions/i);
    expect(body).toMatch(/remains payable ONLY if/i);
  });
});
