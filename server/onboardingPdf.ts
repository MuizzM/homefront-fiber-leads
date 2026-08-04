import PDFDocument from "pdfkit";
import {
  ELECTRONIC_CONSENT_DISCLOSURE,
  ELECTRONIC_CONSENT_VERSION,
  type AgreementSnapshot,
} from "../shared/onboardingDocuments";

export interface SignatureEvidence {
  recordId: string;
  /** Canonical account name the typed signature was matched against. */
  signerName: string;
  /** Verbatim keystrokes from the signature field — the signature itself. */
  typedSignatureName?: string;
  signerEmail: string;
  signedAt: string;
  authenticatedUserId: number;
  ipAddress: string;
  userAgent: string;
  contentSha256: string;
  signatureSha256: string;
}

// The agreement body — title, parties, every section. Shared by the REVIEW copy
// a rep reads before signing and the SIGNED copy issued afterwards, so the two
// cannot drift: a rep who scrolls the preview has read the same document that
// the certificate is later bound to. Only the signature certificate differs.
function renderAgreementBody(doc: PDFKit.PDFDocument, snapshot: AgreementSnapshot) {
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#12314c").text(snapshot.title, { align: "center" });
  doc.moveDown(0.35).font("Helvetica").fontSize(9).fillColor("#617081")
    .text(`Document version ${snapshot.documentVersion} • Issued ${new Date(snapshot.issuedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`, { align: "center" });
  doc.moveDown(1.25);
  doc.roundedRect(58, doc.y, 496, 58, 7).fillAndStroke("#f0f8f6", "#cfe7e0");
  const partyY = doc.y + 12;
  doc.fillColor("#12314c").font("Helvetica-Bold").fontSize(9).text("COMPANY", 72, partyY);
  doc.font("Helvetica").fontSize(10).text(snapshot.companyName, 72, partyY + 15, { width: 215 });
  doc.font("Helvetica-Bold").fontSize(9).text("SIGNER", 310, partyY);
  doc.font("Helvetica").fontSize(10).text(`${snapshot.signerName}\n${snapshot.signerEmail}`, 310, partyY + 15, { width: 225 });
  doc.y = partyY + 62;

  for (const section of snapshot.sections) {
    doc.moveDown(0.65).font("Helvetica-Bold").fontSize(11).fillColor("#12314c").text(section.heading);
    for (const paragraph of section.paragraphs) {
      doc.moveDown(0.28).font("Helvetica").fontSize(9.5).fillColor("#263746").text(paragraph, { lineGap: 2.2, align: "left" });
    }
    for (const bullet of section.bullets ?? []) {
      doc.moveDown(0.2).font("Helvetica").fontSize(9.5).fillColor("#263746").text(`•  ${bullet}`, { indent: 10, lineGap: 2.1 });
    }
  }
}

function addFooter(doc: PDFKit.PDFDocument, label = "Home Front Sign") {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.font("Helvetica").fontSize(8).fillColor("#617081")
      .text(`${label} • Page ${index + 1} of ${range.count}`, 54, 750, { width: 504, align: "center" });
  }
}

export interface CounterSignEvidence {
  /** The company signer's typed name (matched to their account name). */
  companySignatureName: string;
  companySignedAt: string;
  companySignerUserId: number;
}

export function renderSignedAgreementPdf(
  snapshot: AgreementSnapshot,
  evidence: SignatureEvidence,
  counterSign?: CounterSignEvidence,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 62, left: 58, right: 58 }, bufferPages: true, info: {
      Title: `${snapshot.title} — ${snapshot.signerName}`,
      Author: snapshot.companyName,
      Subject: "Electronically signed onboarding agreement",
      CreationDate: new Date(evidence.signedAt),
    } });
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    renderAgreementBody(doc, snapshot);

    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#12314c").text("Electronic Signature Certificate", { align: "center" });
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(11).text(ELECTRONIC_CONSENT_DISCLOSURE.title);
    for (const paragraph of ELECTRONIC_CONSENT_DISCLOSURE.paragraphs) {
      doc.moveDown(0.35).font("Helvetica").fontSize(9.5).fillColor("#263746").text(paragraph, { lineGap: 2.2 });
    }

    // The signature shown is what the SIGNER TYPED, verbatim. The canonical
    // account name appears separately as what it was matched against — a
    // certificate that printed the profile name as the signature would be
    // showing a name the server supplied, not a mark the human made.
    doc.moveDown(1.1).roundedRect(58, doc.y, 496, 138, 8).fillAndStroke("#f7fafc", "#d9e1e8");
    const signY = doc.y + 15;
    doc.fillColor("#617081").font("Helvetica-Bold").fontSize(8).text("ELECTRONIC SIGNATURE", 74, signY);
    doc.fillColor("#12314c").font("Helvetica-Oblique").fontSize(19)
      .text(evidence.typedSignatureName || evidence.signerName, 74, signY + 17, { width: 460 });
    doc.font("Helvetica").fontSize(9).fillColor("#263746")
      .text(`Typed by the signer and matched to account name: ${evidence.signerName}`, 74, signY + 50, { width: 455 })
      .text(`Signed: ${new Date(evidence.signedAt).toISOString()}`, 74, signY + 66)
      .text(`Authenticated account: ${evidence.signerEmail} (user ${evidence.authenticatedUserId})`, 74, signY + 82)
      .text(`IP: ${evidence.ipAddress} • Browser: ${evidence.userAgent.slice(0, 90)}`, 74, signY + 98, { width: 455 });
    doc.y = signY + 146;

    // The COMPANY counter-signature block — present only on the final,
    // dual-stamped copy issued when a manager counter-signs on behalf of the
    // company. The rep-signed-only certificate omits it, so the two artifacts
    // are visually distinguishable at a glance.
    if (counterSign) {
      doc.moveDown(0.7).roundedRect(58, doc.y, 496, 92, 8).fillAndStroke("#f0f8f6", "#cfe7e0");
      const counterY = doc.y + 15;
      doc.fillColor("#617081").font("Helvetica-Bold").fontSize(8).text("COMPANY COUNTER-SIGNATURE", 74, counterY);
      doc.fillColor("#12314c").font("Helvetica-Oblique").fontSize(17)
        .text(counterSign.companySignatureName, 74, counterY + 15, { width: 460 });
      doc.font("Helvetica").fontSize(9).fillColor("#263746")
        .text(`Counter-signed for ${snapshot.companyName} (user ${counterSign.companySignerUserId})`, 74, counterY + 44, { width: 455 })
        .text(`Counter-signed: ${new Date(counterSign.companySignedAt).toISOString()}`, 74, counterY + 60);
      doc.y = counterY + 100;
    }

    doc.font("Helvetica-Bold").fontSize(10).fillColor("#12314c").text("Tamper-evident record identifiers");
    doc.moveDown(0.35).font("Courier").fontSize(7.2).fillColor("#263746")
      .text(`Record ID: ${evidence.recordId}`)
      .text(`Document SHA-256: ${evidence.contentSha256}`)
      .text(`Signature SHA-256: ${evidence.signatureSha256}`)
      .text(`Consent version: ${ELECTRONIC_CONSENT_VERSION}`);
    doc.moveDown(0.8).font("Helvetica").fontSize(8.5).fillColor("#617081")
      .text("The signature is logically associated with the exact document hash shown above. Home Front Sign retains the immutable document snapshot, authentication context, consent record, and hash-chained event history.", { lineGap: 2 });

    addFooter(doc);
    doc.end();
  });
}

/**
 * The REVIEW copy — the complete agreement as a real, multi-page PDF, rendered
 * BEFORE anything is signed.
 *
 * Why this exists: the signing ceremony used to show the agreement as HTML
 * sections and only ever produced a PDF *after* the rep signed. So the document
 * a rep reviewed was a re-creation of the document they were agreeing to, and
 * the actual PDF was something they first saw once it was too late to decline.
 * A signer is entitled to read the real instrument, paginated exactly as it
 * will be filed, before they sign it.
 *
 * It is the same `renderAgreementBody` the signed copy uses, so "what I read"
 * and "what I signed" are the same document. The only differences are the
 * absence of the signature certificate and a standing REVIEW COPY mark, so a
 * downloaded preview can never be mistaken for an executed agreement.
 */
export function renderAgreementPreviewPdf(snapshot: AgreementSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 62, left: 58, right: 58 }, bufferPages: true, info: {
      Title: `${snapshot.title} — REVIEW COPY`,
      Author: snapshot.companyName,
      Subject: "Unsigned onboarding agreement — review copy",
    } });
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    renderAgreementBody(doc, snapshot);

    // The consent disclosure belongs in the review copy too — a rep should be
    // able to read what they are consenting to before the ceremony asks them.
    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#12314c").text(ELECTRONIC_CONSENT_DISCLOSURE.title);
    for (const paragraph of ELECTRONIC_CONSENT_DISCLOSURE.paragraphs) {
      doc.moveDown(0.35).font("Helvetica").fontSize(9.5).fillColor("#263746").text(paragraph, { lineGap: 2.2 });
    }
    doc.moveDown(1.4).roundedRect(58, doc.y, 496, 74, 8).fillAndStroke("#fffaf0", "#f0d9a8");
    const noteY = doc.y + 14;
    doc.fillColor("#8a6100").font("Helvetica-Bold").fontSize(10).text("This copy is not signed", 74, noteY);
    doc.font("Helvetica").fontSize(9).fillColor("#6b5528")
      .text("No signature has been applied to this document. Signing happens in the app, and the executed copy — with the signature certificate, timestamps and record hashes — is issued only after you complete the ceremony.",
        74, noteY + 17, { width: 464, lineGap: 2 });

    // Every page carries the mark, so a single printed page out of context
    // still reads as a draft rather than an executed agreement.
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.save();
      doc.rotate(-32, { origin: [306, 400] });
      doc.font("Helvetica-Bold").fontSize(58).fillColor("#12314c").opacity(0.055)
        .text("REVIEW COPY", 6, 360, { width: 600, align: "center" });
      doc.restore();
    }
    addFooter(doc, "Home Front Sign • REVIEW COPY — NOT SIGNED");
    doc.end();
  });
}
