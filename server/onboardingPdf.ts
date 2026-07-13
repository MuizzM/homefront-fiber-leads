import PDFDocument from "pdfkit";
import {
  ELECTRONIC_CONSENT_DISCLOSURE,
  ELECTRONIC_CONSENT_VERSION,
  type AgreementSnapshot,
} from "../shared/onboardingDocuments";

export interface SignatureEvidence {
  recordId: string;
  signerName: string;
  signerEmail: string;
  signedAt: string;
  authenticatedUserId: number;
  ipAddress: string;
  userAgent: string;
  contentSha256: string;
  signatureSha256: string;
}

function addFooter(doc: PDFKit.PDFDocument) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.font("Helvetica").fontSize(8).fillColor("#617081")
      .text(`Home Front Sign • Page ${index + 1} of ${range.count}`, 54, 750, { width: 504, align: "center" });
  }
}

export function renderSignedAgreementPdf(snapshot: AgreementSnapshot, evidence: SignatureEvidence): Promise<Buffer> {
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

    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#12314c").text("Electronic Signature Certificate", { align: "center" });
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(11).text(ELECTRONIC_CONSENT_DISCLOSURE.title);
    for (const paragraph of ELECTRONIC_CONSENT_DISCLOSURE.paragraphs) {
      doc.moveDown(0.35).font("Helvetica").fontSize(9.5).fillColor("#263746").text(paragraph, { lineGap: 2.2 });
    }

    doc.moveDown(1.1).roundedRect(58, doc.y, 496, 122, 8).fillAndStroke("#f7fafc", "#d9e1e8");
    const signY = doc.y + 15;
    doc.fillColor("#617081").font("Helvetica-Bold").fontSize(8).text("ELECTRONIC SIGNATURE", 74, signY);
    doc.fillColor("#12314c").font("Helvetica-Oblique").fontSize(19).text(evidence.signerName, 74, signY + 17, { width: 460 });
    doc.font("Helvetica").fontSize(9).fillColor("#263746")
      .text(`Signed: ${new Date(evidence.signedAt).toISOString()}`, 74, signY + 50)
      .text(`Authenticated account: ${evidence.signerEmail} (user ${evidence.authenticatedUserId})`, 74, signY + 66)
      .text(`IP: ${evidence.ipAddress} • Browser: ${evidence.userAgent.slice(0, 90)}`, 74, signY + 82, { width: 455 });
    doc.y = signY + 130;

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
