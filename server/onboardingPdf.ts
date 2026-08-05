import PDFDocument from "pdfkit";
import {
  ELECTRONIC_CONSENT_DISCLOSURE,
  ELECTRONIC_CONSENT_VERSION,
  type AgreementSnapshot,
} from "../shared/onboardingDocuments";
import { tierRows } from "../shared/commissionTerms";
import { formatUsdCents } from "../shared/commissionTiers";
import fs from "node:fs";
import path from "node:path";

// ── Brand ───────────────────────────────────────────────────────────────────
// The palette was already half-present as hex literals scattered through the
// renderers; it is stated once here so the agreements, the cover and the
// footers cannot drift apart, and so a tenant's own colour has one place to
// override.
export const BRAND = {
  navy: "#12314c",     // headings and body — the logo's house outline
  teal: "#3EA394",     // rules, accents, the company mark
  tealWash: "#f0f8f6", // panel fill
  tealEdge: "#cfe7e0", // panel border
  amber: "#E0A03C",    // the logo's door; used only to mark "not signed"
  muted: "#617081",
  ink: "#263746",
};

// The logo ships to dist/public via Vite, and lives in client/public in dev.
// Resolved once and cached: a missing file must degrade to a wordmark rather
// than throw halfway through building somebody's contract.
let logoPath: string | null | undefined;
function brandLogo(): string | null {
  if (logoPath !== undefined) return logoPath;
  const bundleDir = typeof __dirname === "string" ? __dirname : null;
  const candidates = [
    ...(bundleDir ? [path.resolve(bundleDir, "public", "hfs-logo-full.png")] : []),
    path.resolve(process.cwd(), "dist", "public", "hfs-logo-full.png"),
    path.resolve(process.cwd(), "client", "public", "hfs-logo-full.png"),
  ];
  logoPath = candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) ?? null;
  return logoPath;
}

/** Letterhead: the mark, the company, and a rule in the brand colour. Returns
 *  the y to continue at, so callers never guess at spacing. */
function letterhead(doc: PDFKit.PDFDocument, companyName: string, accent: string): number {
  const top = doc.y;
  const logo = brandLogo();
  if (logo) {
    // Height-constrained: the mark is portrait (420x512) and a width fit would
    // make it tower over the title.
    try { doc.image(logo, 58, top, { height: 42 }); } catch { /* fall through to the wordmark */ }
  }
  doc.font("Helvetica-Bold").fontSize(12).fillColor(BRAND.navy)
    .text(companyName.toUpperCase(), logo ? 108 : 58, top + 8, { width: 300, characterSpacing: 0.8 });
  doc.font("Helvetica").fontSize(8).fillColor(accent)
    .text("DIRECT TO YOUR DOOR", logo ? 108 : 58, top + 24, { width: 300, characterSpacing: 1.6 });
  const ruleY = top + 48;
  doc.moveTo(58, ruleY).lineTo(554, ruleY).lineWidth(1.5).strokeColor(accent).stroke();
  doc.y = ruleY + 14;
  return doc.y;
}

/** A tenant's own colour when it is a usable hex; the house teal otherwise.
 *  Exported because it is the whole of the brand-colour logic, and testing it
 *  directly is sound in a way that diffing two PDFs is not — pdfkit stamps a
 *  creation timestamp, so any two renders differ regardless of their content. */
export function accentFor(brandColor?: string | null): string {
  return typeof brandColor === "string" && /^#[0-9a-f]{6}$/i.test(brandColor.trim()) ? brandColor.trim() : BRAND.teal;
}


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
function renderAgreementBody(doc: PDFKit.PDFDocument, snapshot: AgreementSnapshot, accent = BRAND.teal) {
  letterhead(doc, snapshot.companyName, accent);
  doc.font("Helvetica-Bold").fontSize(18).fillColor(BRAND.navy).text(snapshot.title, { align: "center" });
  doc.moveDown(0.35).font("Helvetica").fontSize(9).fillColor(BRAND.muted)
    .text(`Document version ${snapshot.documentVersion} • Issued ${new Date(snapshot.issuedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`, { align: "center" });
  doc.moveDown(1.25);
  doc.roundedRect(58, doc.y, 496, 58, 7).fillAndStroke(BRAND.tealWash, BRAND.tealEdge);
  const partyY = doc.y + 12;
  doc.fillColor(BRAND.navy).font("Helvetica-Bold").fontSize(9).text("COMPANY", 72, partyY);
  doc.font("Helvetica").fontSize(10).text(snapshot.companyName, 72, partyY + 15, { width: 215 });
  doc.font("Helvetica-Bold").fontSize(9).text("SIGNER", 310, partyY);
  doc.font("Helvetica").fontSize(10).text(`${snapshot.signerName}\n${snapshot.signerEmail}`, 310, partyY + 15, { width: 225 });
  doc.y = partyY + 62;

  for (const section of snapshot.sections) {
    doc.moveDown(0.65).font("Helvetica-Bold").fontSize(11).fillColor(accent).text(section.heading);
    for (const paragraph of section.paragraphs) {
      doc.moveDown(0.28).font("Helvetica").fontSize(9.5).fillColor(BRAND.ink).text(paragraph, { lineGap: 2.2, align: "left" });
    }
    for (const bullet of section.bullets ?? []) {
      doc.moveDown(0.2).font("Helvetica").fontSize(9.5).fillColor(BRAND.ink).text(`•  ${bullet}`, { indent: 10, lineGap: 2.1 });
    }
  }
}

function addFooter(doc: PDFKit.PDFDocument, label = "Home Front Sign") {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.moveTo(58, 742).lineTo(554, 742).lineWidth(0.5).strokeColor(BRAND.tealEdge).stroke();
    doc.font("Helvetica").fontSize(8).fillColor(BRAND.muted)
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

// ── The whole packet, as one PDF ─────────────────────────────────────────────
//
// A rep was handed four separate agreements to open, read and sign one at a
// time, and had no way to see the engagement as a single document. "What am I
// actually agreeing to" was spread across four downloads, which is how people
// end up signing without reading.
//
// This renders every agreement in the packet into ONE file, in the order they
// are presented, behind a cover sheet and a contents list — with the commission
// terms lifted out onto the cover, because the rate is the thing a rep opens
// this to find and it should not be on page nine.
//
// It is a REVIEW copy by construction. It carries no signature certificate and
// says so on every page: the executed record stays per-agreement, one signature
// bound to one document, which is what makes each signature meaningful.
export function renderOnboardingPacketPdf(input: {
  snapshots: AgreementSnapshot[];
  signerName: string;
  signerEmail: string;
  companyName: string;
  /** The tenant's own brand colour; falls back to the house teal. */
  brandColor?: string | null;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 62, left: 58, right: 58 }, bufferPages: true, info: {
      Title: `Onboarding agreements — ${input.signerName}`,
      Author: input.companyName,
      Subject: "Onboarding agreement packet — review copy",
    } });
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    // ── Cover ────────────────────────────────────────────────────────────
    const accent = accentFor(input.brandColor);
    letterhead(doc, input.companyName, accent);
    doc.moveDown(1.2);
    doc.font("Helvetica-Bold").fontSize(22).fillColor(BRAND.navy).text("Your onboarding agreements", { align: "center" });
    doc.moveDown(0.4).font("Helvetica").fontSize(11).fillColor(BRAND.muted)
      .text(`${input.signerName} · ${input.signerEmail}`, { align: "center" });
    doc.moveDown(0.15).fontSize(9)
      .text(`Prepared by ${input.companyName} · ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", dateStyle: "long" })}`, { align: "center" });

    // The money, on the cover. A rep opens this to find out what they earn.
    const commission = input.snapshots.find(s => s.documentType === "commission_agreement");
    const terms = commission?.compTerms;
    if (terms) {
      doc.moveDown(1.6);
      const boxTop = doc.y;
      const rows = terms.structure === "FLAT" && terms.flatRateCents != null
        ? [{ band: "Every qualified sale", rate: `${formatUsdCents(terms.flatRateCents)} per sale` }]
        : tierRows(terms);
      const boxHeight = 54 + rows.length * 18;
      doc.roundedRect(58, boxTop, 496, boxHeight, 8).fillAndStroke(BRAND.tealWash, BRAND.tealEdge);
      doc.fillColor(accent).font("Helvetica-Bold").fontSize(11)
        .text(terms.structure === "FLAT" ? "Your commission — flat rate" : "Your commission — tiered", 76, boxTop + 14);
      let rowY = boxTop + 34;
      for (const row of rows) {
        doc.font("Helvetica").fontSize(9.5).fillColor(BRAND.ink).text(row.band, 76, rowY, { width: 300 });
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(BRAND.navy).text(row.rate, 380, rowY, { width: 150, align: "right" });
        rowY += 18;
      }
      doc.font("Helvetica").fontSize(8.5).fillColor(BRAND.muted).text(
        terms.reservePercent > 0
          ? `${terms.reservePercent}% held as a chargeback reserve · full terms in the Commission Agreement`
          : "No chargeback reserve · full terms in the Commission Agreement",
        76, rowY + 4, { width: 460 });
      doc.y = boxTop + boxHeight + 10;
    }

    doc.moveDown(1.2).font("Helvetica-Bold").fontSize(11).fillColor(accent).text("What is in this packet");
    input.snapshots.forEach((snapshot, index) => {
      doc.moveDown(0.35).font("Helvetica").fontSize(10).fillColor(BRAND.ink)
        .text(`${index + 1}.  ${snapshot.title}`, { indent: 8 });
    });
    doc.moveDown(1.4).font("Helvetica").fontSize(9).fillColor(BRAND.amber)
      .text(
        "This packet is for reading. Signing happens one agreement at a time in the portal, so each signature is bound to the agreement it belongs to — this copy is not signed and is not an executed agreement.",
        { lineGap: 2 });

    // ── Every agreement, in order ────────────────────────────────────────
    for (const snapshot of input.snapshots) {
      doc.addPage();
      renderAgreementBody(doc, snapshot, accent);
    }

    // ── The consent disclosure, once ─────────────────────────────────────
    doc.addPage();
    letterhead(doc, input.companyName, accent);
    doc.font("Helvetica-Bold").fontSize(13).fillColor(accent).text(ELECTRONIC_CONSENT_DISCLOSURE.title);
    doc.moveDown(0.2).font("Helvetica").fontSize(8).fillColor(BRAND.muted).text(`Version ${ELECTRONIC_CONSENT_VERSION}`);
    for (const paragraph of ELECTRONIC_CONSENT_DISCLOSURE.paragraphs) {
      doc.moveDown(0.35).font("Helvetica").fontSize(9.5).fillColor(BRAND.ink).text(paragraph, { lineGap: 2.2 });
    }

    addFooter(doc, `${input.companyName} · REVIEW COPY — not signed`);
    doc.end();
  });
}
