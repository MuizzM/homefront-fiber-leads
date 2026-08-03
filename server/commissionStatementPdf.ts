// ── Commission statement PDF ─────────────────────────────────────────────────
// The document a rep downloads, and the one a shop hands to an accountant. It
// renders the SAME StatementDocument the on-screen statement renders, so the
// paper and the pixels can never disagree.
//
// Layout is deliberately plain: a branded header, one line per door, one column
// of totals, and a holdback panel. A pay document earns trust by being boring
// and legible, not by being decorated.

import PDFDocument from "pdfkit";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatCents, type StatementDocument, type StatementLine } from "@shared/commissionStatement";

const INK = "#12314c";       // headings / primary figures
const MUTED = "#617081";     // labels, secondary text
const HAIRLINE = "#dfe6ec";  // table rules
const BAND = "#f5f8fa";      // zebra + panel fill
const BRAND = "#3EA394";     // accent

const PAGE = { width: 612, height: 792 };
const M = { left: 46, right: 46, top: 44, bottom: 58 };
const CONTENT_W = PAGE.width - M.left - M.right;
const BODY_BOTTOM = PAGE.height - M.bottom;

// The wordmark ships with the client bundle; in production the built client
// lands in dist/public. Try both, cache the result, and fall back to type-set
// text — a missing image must never cost a rep their statement.
let logoCache: Buffer | null | undefined;
function brandLogo(): Buffer | null {
  if (logoCache !== undefined) return logoCache;
  // cwd-relative only: the server bundle runs from the repo root in dev and from
  // the image's app root in production, and `__dirname` does not exist under the
  // ESM loader the tests use.
  const candidates = [
    path.resolve(process.cwd(), "dist/public/hfs-logo.png"),
    path.resolve(process.cwd(), "client/public/hfs-logo.png"),
  ];
  for (const file of candidates) {
    try { if (existsSync(file)) { logoCache = readFileSync(file); return logoCache; } } catch { /* keep looking */ }
  }
  logoCache = null;
  return logoCache;
}

function fmtDate(iso: string, timezone: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { timeZone: timezone, month: "short", day: "numeric" });
}
function fmtStamp(iso: string, timezone: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return `${new Date(t).toLocaleString("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" })}`;
}

// Column geometry for the door table, left→right. Money columns are right-aligned
// against their own right edge so the decimal points line up down the page.
interface Col { x: number; w: number; align: "left" | "right" }
function columns(showHouse: boolean): { date: Col; door: Col; ref: Col; house: Col | null; pay: Col } {
  const right = M.left + CONTENT_W;
  const pay: Col = { x: right - 86, w: 86, align: "right" };
  const house: Col | null = showHouse ? { x: right - 178, w: 86, align: "right" } : null;
  const refRight = house ? house.x - 10 : pay.x - 10;
  const ref: Col = { x: refRight - 96, w: 96, align: "left" };
  const date: Col = { x: M.left, w: 52, align: "left" };
  const door: Col = { x: M.left + 58, w: ref.x - (M.left + 58) - 10, align: "left" };
  return { date, door, ref, house, pay };
}

function cell(doc: PDFKit.PDFDocument, text: string, col: Col, y: number) {
  doc.text(text, col.x, y, { width: col.w, align: col.align, lineBreak: false, ellipsis: true });
}

export function renderCommissionStatementPdf(docModel: StatementDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tz = docModel.period.timezone || "America/New_York";
    const doc = new PDFDocument({
      size: "LETTER", margins: { top: M.top, bottom: M.bottom, left: M.left, right: M.right },
      bufferPages: true,
      info: {
        Title: `Commission Statement — ${docModel.rep.name} — ${docModel.period.label}`,
        Author: docModel.company.name,
        Subject: `Commission statement for ${docModel.period.label}`,
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", c => chunks.push(Buffer.from(c)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const cols = columns(docModel.showHouseColumn);

    // ── Header ───────────────────────────────────────────────────────────────
    const logo = brandLogo();
    let headerTextX = M.left;
    if (logo) {
      try { doc.image(logo, M.left, M.top - 4, { fit: [46, 46] }); headerTextX = M.left + 58; }
      catch { headerTextX = M.left; }
    }
    doc.font("Helvetica-Bold").fontSize(15).fillColor(INK)
      .text(docModel.company.name, headerTextX, M.top, { width: 280, lineBreak: false, ellipsis: true });
    doc.font("Helvetica").fontSize(9).fillColor(MUTED)
      .text("Commission Statement", headerTextX, M.top + 20, { width: 280, lineBreak: false });

    // Period + status, right-aligned against the header.
    const headRight = M.left + CONTENT_W - 210;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK)
      .text(docModel.period.label || "—", headRight, M.top + 2, { width: 210, align: "right", lineBreak: false });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text(`${docModel.statement.status} · Statement #${docModel.statement.id ?? "—"}`, headRight, M.top + 18, { width: 210, align: "right", lineBreak: false });

    doc.moveTo(M.left, M.top + 42).lineTo(M.left + CONTENT_W, M.top + 42).lineWidth(1).strokeColor(BRAND).stroke();

    // ── Rep + net-pay hero ───────────────────────────────────────────────────
    let y = M.top + 58;
    doc.roundedRect(M.left, y, CONTENT_W, 72, 8).fillAndStroke(BAND, HAIRLINE);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("PAID TO", M.left + 18, y + 15, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(16).fillColor(INK)
      .text(docModel.rep.name, M.left + 18, y + 29, { width: 250, lineBreak: false, ellipsis: true });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text(docModel.planLabel, M.left + 18, y + 51, { width: 250, lineBreak: false, ellipsis: true });

    const heroRight = M.left + CONTENT_W - 18 - 200;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
      .text("NET PAY THIS PERIOD", heroRight, y + 15, { width: 200, align: "right", lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(26).fillColor(INK)
      .text(formatCents(docModel.payout.netPayCents), heroRight, y + 28, { width: 200, align: "right", lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
      .text(`Earned ${formatCents(docModel.totals.earnedCents)} · Holdback ${formatCents(docModel.payout.reserveCents)}`,
        heroRight, y + 57, { width: 200, align: "right", lineBreak: false });
    y += 90;

    // ── Door table ───────────────────────────────────────────────────────────
    const drawTableHeader = (atY: number): number => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED);
      cell(doc, "DATE", cols.date, atY);
      cell(doc, "ADDRESS", cols.door, atY);
      cell(doc, "REFERENCE", cols.ref, atY);
      if (cols.house) cell(doc, "HOUSE AMOUNT", cols.house, atY);
      cell(doc, "COMMISSION", cols.pay, atY);
      doc.moveTo(M.left, atY + 12).lineTo(M.left + CONTENT_W, atY + 12).lineWidth(0.7).strokeColor(HAIRLINE).stroke();
      return atY + 19;
    };

    const ROW_H = 17;
    const ensureRoom = (need: number): void => {
      if (y + need <= BODY_BOTTOM) return;
      doc.addPage();
      y = M.top;
      y = drawTableHeader(y);
    };

    const drawRow = (line: StatementLine, index: number) => {
      ensureRoom(ROW_H + 4);
      if (index % 2 === 1) doc.rect(M.left, y - 4, CONTENT_W, ROW_H).fill(BAND);
      const tone = line.counted ? "#263746" : MUTED;
      doc.font("Helvetica").fontSize(8.5).fillColor(tone);
      cell(doc, fmtDate(line.countedAtIso, tz), cols.date, y);
      const where = line.city ? `${line.address}, ${line.city}` : line.address;
      cell(doc, where, cols.door, y);
      doc.fontSize(7.5).fillColor(MUTED);
      cell(doc, line.counted ? line.externalId : `${line.externalId} · ${line.status}`, cols.ref, y);
      doc.font(line.counted ? "Helvetica" : "Helvetica-Oblique").fontSize(8.5).fillColor(tone);
      // A door that didn't count earns the house nothing on THIS statement, and
      // it is excluded from the house total — so it shows a dash, not a price
      // that would make the column stop adding up.
      if (cols.house) {
        cell(doc, !line.counted || line.houseAmountCents == null ? "—" : formatCents(line.houseAmountCents), cols.house, y);
      }
      cell(doc, line.counted ? formatCents(line.repCommissionCents) : "—", cols.pay, y);
      y += ROW_H;
    };

    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK)
      .text(`Sales this period (${docModel.totals.countedSaleCount})`, M.left, y, { lineBreak: false });
    y += 18;
    y = drawTableHeader(y);

    const counted = docModel.lines.filter(l => l.counted);
    const uncounted = docModel.lines.filter(l => !l.counted);
    if (counted.length === 0) {
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED)
        .text("No qualified sales counted toward commission in this period.", M.left, y, { width: CONTENT_W });
      y += 22;
    } else {
      counted.forEach(drawRow);
      // Table totals rule.
      ensureRoom(26);
      doc.moveTo(M.left, y - 2).lineTo(M.left + CONTENT_W, y - 2).lineWidth(0.7).strokeColor(HAIRLINE).stroke();
      y += 5;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK);
      cell(doc, `${docModel.totals.countedSaleCount} sales`, cols.door, y);
      if (cols.house) {
        cell(doc, docModel.totals.houseAmountCents == null ? "—" : formatCents(docModel.totals.houseAmountCents), cols.house, y);
      }
      cell(doc, formatCents(docModel.totals.grossCommissionCents), cols.pay, y);
      y += 22;
      if (cols.house && !docModel.totals.houseAmountComplete) {
        doc.font("Helvetica-Oblique").fontSize(7.5).fillColor(MUTED)
          .text("Some doors have no house amount recorded, so the house total covers only the priced sales.", M.left, y, { width: CONTENT_W });
        y += 14;
      }
    }

    if (uncounted.length > 0) {
      ensureRoom(40);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(INK)
        .text(`Not counted toward this period (${uncounted.length})`, M.left, y, { lineBreak: false });
      y += 16;
      uncounted.forEach(drawRow);
      y += 6;
    }

    // ── Money summary + holdback ─────────────────────────────────────────────
    ensureRoom(190);
    y += 8;
    const boxW = 268;
    const boxX = M.left + CONTENT_W - boxW;

    const rows: Array<[string, string, boolean?]> = [];
    if (docModel.totals.hourlyPayCents !== 0) rows.push(["Hourly pay", formatCents(docModel.totals.hourlyPayCents)]);
    rows.push(["Commission on sales", formatCents(docModel.totals.grossCommissionCents)]);
    if (docModel.totals.adjustmentCents !== 0) rows.push(["Adjustments", formatCents(docModel.totals.adjustmentCents)]);
    if (docModel.totals.spiffCents !== 0) rows.push(["Spiffs", formatCents(docModel.totals.spiffCents)]);
    rows.push(["Earned this period", formatCents(docModel.totals.earnedCents), true]);
    rows.push([`Chargeback holdback (${docModel.payout.reservePercent}%)`, `-${formatCents(docModel.payout.reserveCents).replace("-", "")}`]);

    const boxH = 30 + rows.length * 16 + 34;
    doc.roundedRect(boxX, y, boxW, boxH, 8).fillAndStroke("#ffffff", HAIRLINE);
    let ry = y + 14;
    for (const [label, value, strong] of rows) {
      doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(strong ? INK : MUTED)
        .text(label, boxX + 14, ry, { width: boxW - 130, lineBreak: false });
      doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(strong ? INK : "#263746")
        .text(value, boxX + boxW - 116, ry, { width: 102, align: "right", lineBreak: false });
      ry += 16;
    }
    doc.moveTo(boxX + 14, ry + 2).lineTo(boxX + boxW - 14, ry + 2).lineWidth(0.7).strokeColor(HAIRLINE).stroke();
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
      .text("Net pay", boxX + 14, ry + 12, { width: boxW - 130, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(13).fillColor(INK)
      .text(formatCents(docModel.payout.netPayCents), boxX + boxW - 116, ry + 10, { width: 102, align: "right", lineBreak: false });

    // Holdback balance panel, beside the summary.
    const panelW = CONTENT_W - boxW - 16;
    doc.roundedRect(M.left, y, panelW, boxH, 8).fillAndStroke(BAND, HAIRLINE);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
      .text("CURRENT HOLDBACK BALANCE", M.left + 14, y + 14, { width: panelW - 28, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(20).fillColor(INK)
      .text(formatCents(docModel.payout.reserveBalanceCents), M.left + 14, y + 29, { width: panelW - 28, lineBreak: false });

    const capLine = docModel.payout.reserveCapCents == null
      ? "Held to cover chargebacks on cancelled sales."
      : docModel.payout.reserveAtCap
        ? `Cap of ${formatCents(docModel.payout.reserveCapCents)} reached — nothing further is withheld.`
        : `Builds to a cap of ${formatCents(docModel.payout.reserveCapCents)}.`;
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
      .text(capLine, M.left + 14, y + 56, { width: panelW - 28 });

    // Progress toward the cap — a rep should be able to see the end of it.
    if (docModel.payout.reserveCapCents != null && docModel.payout.reserveCapCents > 0) {
      const barY = y + boxH - 26;
      const barW = panelW - 28;
      const pct = Math.max(0, Math.min(1, docModel.payout.reserveBalanceCents / docModel.payout.reserveCapCents));
      doc.roundedRect(M.left + 14, barY, barW, 6, 3).fill("#e3ebf0");
      if (pct > 0) doc.roundedRect(M.left + 14, barY, Math.max(3, barW * pct), 6, 3).fill(BRAND);
      doc.font("Helvetica").fontSize(7).fillColor(MUTED)
        .text(`${Math.round(pct * 100)}% of cap`, M.left + 14, barY + 9, { width: barW, lineBreak: false });
    }
    y += boxH + 16;

    // ── Adjustment detail ────────────────────────────────────────────────────
    if (docModel.adjustments.length > 0) {
      ensureRoom(30 + docModel.adjustments.length * 14);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text("Adjustments applied", M.left, y, { lineBreak: false });
      y += 15;
      for (const adj of docModel.adjustments) {
        doc.font("Helvetica").fontSize(8).fillColor(MUTED)
          .text(adj.reason || "Adjustment", M.left, y, { width: CONTENT_W - 100, lineBreak: false, ellipsis: true });
        doc.fillColor("#263746")
          .text(formatCents(adj.amountCents), M.left + CONTENT_W - 96, y, { width: 96, align: "right", lineBreak: false });
        y += 14;
      }
    }

    // ── Footer on every page ─────────────────────────────────────────────────
    // The footer sits BELOW the bottom margin on purpose. pdfkit auto-paginates
    // as soon as text crosses that margin, so writing it naively appends a blank
    // page per page and the footer never renders — drop the margin to zero for
    // the duration of the sweep and restore it after.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const restoreBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(M.left, BODY_BOTTOM + 14).lineTo(M.left + CONTENT_W, BODY_BOTTOM + 14).lineWidth(0.7).strokeColor(HAIRLINE).stroke();
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
        .text(`${docModel.company.name} · Issued ${fmtStamp(docModel.statement.issuedAtIso, tz)} · Calculation v${docModel.statement.calculationVersion}`,
          M.left, BODY_BOTTOM + 22, { width: CONTENT_W - 60, lineBreak: false, ellipsis: true })
        .text(`Page ${i + 1} of ${range.count}`, M.left + CONTENT_W - 60, BODY_BOTTOM + 22, { width: 60, align: "right", lineBreak: false });
      doc.page.margins.bottom = restoreBottom;
    }

    doc.end();
  });
}
