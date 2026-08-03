// ── PAY-A2: W-9 PDF rendering ────────────────────────────────────────────────
// Fills the OFFICIAL IRS Form W-9 (Rev. March 2024) acroform — the template is
// vendored at server/assets/fw9.pdf (downloaded from irs.gov/pub/irs-pdf/fw9.pdf
// at build time and committed, so runtime never touches the network). The typed
// signature + date are stamped onto the Part II signature/date lines as text
// (the official form exposes no signature acroform field); the ESIGN evidence
// (IP, user agent, consent, timestamp) lives on the w9_forms row.

import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface W9PdfInput {
  legalName: string;
  businessName: string | null;
  address: { line1: string; city: string; state: string; zip: string };
  tin: string;              // 9 digits — used ONLY to fill the form, never logged
  tinType: "ssn" | "ein";
  signatureName: string;
  signatureDate: Date;
  requesterName?: string;   // company legal name (optional line)
}

// Resolve the vendored template across dev (tsx, cwd=repo root), tests, and the
// prod CJS bundle (dist/index.cjs with dist/assets copied by script/build.ts).
function templatePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "server", "assets", "fw9.pdf"),
    path.resolve(process.cwd(), "dist", "assets", "fw9.pdf"),
  ];
  if (typeof __dirname !== "undefined") {
    candidates.push(path.join(__dirname, "assets", "fw9.pdf"));
    candidates.push(path.join(__dirname, "..", "server", "assets", "fw9.pdf"));
  }
  const found = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!found) throw new Error("IRS W-9 template (server/assets/fw9.pdf) not found");
  return found;
}

// Acroform field ids on the official Rev. 3-2024 template (verified against the
// vendored file's widget rectangles).
const F = {
  name: "topmostSubform[0].Page1[0].f1_01[0]",
  business: "topmostSubform[0].Page1[0].f1_02[0]",
  individualCheckbox: "topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[0]",
  address: "topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_07[0]",
  cityStateZip: "topmostSubform[0].Page1[0].Address_ReadOrder[0].f1_08[0]",
  requester: "topmostSubform[0].Page1[0].f1_09[0]",
  ssn1: "topmostSubform[0].Page1[0].f1_11[0]",
  ssn2: "topmostSubform[0].Page1[0].f1_12[0]",
  ssn3: "topmostSubform[0].Page1[0].f1_13[0]",
  ein1: "topmostSubform[0].Page1[0].f1_14[0]",
  ein2: "topmostSubform[0].Page1[0].f1_15[0]",
};

export async function renderW9Pdf(input: W9PdfInput): Promise<Buffer> {
  const bytes = fs.readFileSync(templatePath());
  // Copy into a realm-local Uint8Array: under vitest's VM context a Node Buffer
  // fails pdf-lib's `instanceof Uint8Array` check ("pdf ... of type NaN").
  const doc = await PDFDocument.load(new Uint8Array(bytes));
  const form = doc.getForm();

  const setText = (name: string, value: string) => {
    try { form.getTextField(name).setText(value); } catch { /* field absent in a future revision — never fail the signing */ }
  };
  setText(F.name, input.legalName);
  if (input.businessName) setText(F.business, input.businessName);
  // Line 3a: contractors here are individuals / sole proprietors (1099 field
  // reps). The checkbox is BOTH marked in the acroform AND stamped with a
  // ZapfDingbats ✔ glyph — some PDF viewers ignore regenerated checkbox
  // appearance streams, and the flattened output must show the mark regardless.
  try { form.getCheckBox(F.individualCheckbox).check(); } catch { /* non-fatal */ }
  // Vector X inside the 8x8pt box at (73, 603.7) — drawn, not font-stamped, so
  // EVERY renderer shows it (font checkbox glyphs are viewer-dependent).
  const page0 = doc.getPage(0);
  const black = rgb(0, 0, 0);
  page0.drawLine({ start: { x: 74.2, y: 604.9 }, end: { x: 79.8, y: 610.5 }, thickness: 1.3, color: black });
  page0.drawLine({ start: { x: 74.2, y: 610.5 }, end: { x: 79.8, y: 604.9 }, thickness: 1.3, color: black });
  setText(F.address, input.address.line1);
  setText(F.cityStateZip, `${input.address.city}, ${input.address.state} ${input.address.zip}`);
  if (input.requesterName) setText(F.requester, input.requesterName);
  if (input.tinType === "ssn") {
    setText(F.ssn1, input.tin.slice(0, 3));
    setText(F.ssn2, input.tin.slice(3, 5));
    setText(F.ssn3, input.tin.slice(5, 9));
  } else {
    setText(F.ein1, input.tin.slice(0, 2));
    setText(F.ein2, input.tin.slice(2, 9));
  }

  // Typed signature + date stamped on the Part II lines (no acroform field
  // exists for them on the official template). Coordinates measured against the
  // vendored template: the write-in lines are the bottom border of the Sign
  // Here band (y≈196pt from bottom; signature column x≈115, date column x≈520).
  const page = doc.getPage(0);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.05, 0.1, 0.35);
  page.drawText(input.signatureName, { x: 115, y: 198, size: 11, font: italic, color: ink });
  const dateText = input.signatureDate.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", year: "numeric" });
  page.drawText(dateText, { x: 520, y: 198, size: 10, font: regular, color: ink });

  form.flatten(); // baked-in values: the issued PDF is a record, not a form
  return Buffer.from(await doc.save());
}
