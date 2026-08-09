// ── PAY-A2: W-9 PDF rendering ────────────────────────────────────────────────
// Fills the OFFICIAL IRS Form W-9 (Rev. March 2024) acroform — the template is
// vendored at server/assets/fw9.pdf (downloaded from irs.gov/pub/irs-pdf/fw9.pdf
// at build time and committed, so runtime never touches the network). The typed
// signature + date are stamped onto the Part II signature/date lines as text
// (the official form exposes no signature acroform field); the ESIGN evidence
// (IP, user agent, consent, timestamp) lives on the w9_forms row.
//
// HARDENING (see the three rules below — every one of them was a real defect):
//  1. The tax classification is DRIVEN BY THE SIGNER, never assumed. Checking
//     "Individual/sole proprietor" for a single-member LLC or an S-corp makes
//     the signer certify something false under penalties of perjury and drives
//     the wrong 1099 treatment.
//  2. Part II item 2 is STRUCK when the signer tells us the IRS has notified
//     them they are subject to backup withholding — the form's own instruction.
//     The strike position is derived from the page's content stream, not from a
//     hardcoded guess.
//  3. Field writes FAIL LOUDLY. A swallowed getTextField() miss produced a
//     blank-but-"valid" W-9; and the template itself is pinned by SHA-256 so a
//     revision swap is detected rather than silently mis-filled.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PDFArray, PDFDocument, PDFFont, PDFPage, PDFRawStream, PDFRef, StandardFonts,
  decodePDFRawStream, rgb,
} from "pdf-lib";
import {
  W9_LLC_TAX_CLASSES, W9_TAX_CLASSIFICATIONS,
  type W9LlcTaxClass, type W9TaxClassification,
} from "./payValidation";
import { sanitizeForW9 } from "./w9Text";

export { W9EncodingError } from "./w9Text";

// SHA-256 of the vendored template: Form W-9 (Rev. 3-2024), Cat. No. 10231X.
// Every field id, MaxLen, and the Part II text geometry below were verified
// against EXACTLY this file. If the IRS publishes a new revision, re-vendor the
// PDF, re-verify the mappings, then update this constant — never the reverse.
export const W9_TEMPLATE_SHA256 = "2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53";

/** The template on disk is not the revision we mapped — refuse to fill it. */
export class W9TemplateError extends Error {
  constructor(message: string) { super(message); this.name = "W9TemplateError"; }
}

/** A field id in the map is absent from the template (revision drift). */
export class W9FieldError extends Error {
  constructor(message: string) { super(message); this.name = "W9FieldError"; }
}

// ── Tax classification (Form W-9 Line 3a) ────────────────────────────────────
// ONE definition, in the pure validation module, so the accepted values, the
// persisted column, and the checkbox map can never drift apart.
export {
  W9_TAX_CLASSIFICATIONS, W9_LLC_TAX_CLASSES,
  type W9TaxClassification, type W9LlcTaxClass,
} from "./payValidation";

export interface W9PdfInput {
  legalName: string;
  businessName: string | null;
  /** Line 3a — what the signer actually is. Drives the checkbox AND the 1099. */
  taxClassification: W9TaxClassification;
  /** Line 3a LLC letter. REQUIRED when taxClassification === "llc". */
  llcTaxClass?: W9LlcTaxClass | null;
  /** Line 3a "Other (see instructions)" free text. REQUIRED when "other". */
  otherClassification?: string | null;
  /** Line 3b — flow-through entity with foreign partners/owners (Rev. 3-2024). */
  foreignPartners?: boolean;
  /** Line 4 exempt payee code (optional, free text per IRS instructions). */
  exemptPayeeCode?: string | null;
  /** Line 4 FATCA reporting exemption code (optional, free text). */
  fatcaExemptionCode?: string | null;
  /** Line 7 account number(s) (optional). */
  accountNumbers?: string | null;
  address: { line1: string; city: string; state: string; zip: string };
  tin: string;              // 9 digits — used ONLY to fill the form, never logged
  tinType: "ssn" | "ein";
  signatureName: string;
  signatureDate: Date;
  requesterName?: string;   // company legal name (optional line)
  /** Part II: TRUE ⇒ item 2 of the certification is struck through. */
  subjectToBackupWithholding: boolean;
}

export interface W9RenderResult {
  /** Raw PDF bytes. Uint8Array (not Buffer) so the value is realm-portable and
   *  never depends on a bundler's Buffer shim. */
  pdf: Uint8Array;
  /** What was actually PRINTED — differs from the input when a non-Latin name
   *  had to be transliterated. Persisted alongside the original on w9_forms. */
  rendered: { legalName: string; businessName: string | null; signatureName: string };
  /** True when any printed value differs from the submitted value. */
  transliterated: boolean;
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
  if (!found) throw new W9TemplateError("IRS W-9 template (server/assets/fw9.pdf) not found");
  return found;
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Throw unless `bytes` is byte-for-byte the revision this module maps. */
export function assertTemplateIntegrity(bytes: Uint8Array, where = "server/assets/fw9.pdf"): void {
  const actual = sha256(bytes);
  if (actual !== W9_TEMPLATE_SHA256) {
    throw new W9TemplateError(
      `IRS W-9 template at ${where} does not match the pinned revision ` +
      `(Form W-9 Rev. 3-2024, Cat. No. 10231X). expected sha256=${W9_TEMPLATE_SHA256}, got ${actual}. ` +
      `Re-verify every acroform field mapping in server/w9Pdf.ts against the new file before updating the pin.`,
    );
  }
}

let verifiedTemplate: Uint8Array | null = null;

/** Load + integrity-check the template (memoized). Safe to call at boot.
 *  Returned as a plain Uint8Array of THIS realm — a Node Buffer read in another
 *  realm fails pdf-lib's `instanceof Uint8Array` guard. */
export function loadW9Template(): Uint8Array {
  if (verifiedTemplate) return verifiedTemplate;
  const p = templatePath();
  const bytes = new Uint8Array(fs.readFileSync(p));
  assertTemplateIntegrity(bytes, p);
  verifiedTemplate = bytes;
  return bytes;
}

// Acroform field ids on the official Rev. 3-2024 template (verified against the
// vendored file's widget rectangles + MaxLen values — see tests/unit/w9-pdf).
const BOXES = "topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0]";
const P1 = "topmostSubform[0].Page1[0]";
const F = {
  name: `${P1}.f1_01[0]`,
  business: `${P1}.f1_02[0]`,
  llcTaxClass: `${BOXES}.f1_03[0]`,          // MaxLen 1 — "C" | "S" | "P"
  otherClassification: `${BOXES}.f1_04[0]`,
  line3bForeignPartners: `${BOXES}.c1_2[0]`,
  exemptPayeeCode: `${P1}.f1_05[0]`,
  fatcaExemptionCode: `${P1}.f1_06[0]`,
  address: `${P1}.Address_ReadOrder[0].f1_07[0]`,
  cityStateZip: `${P1}.Address_ReadOrder[0].f1_08[0]`,
  requester: `${P1}.f1_09[0]`,
  accountNumbers: `${P1}.f1_10[0]`,
  ssn1: `${P1}.f1_11[0]`,                     // MaxLen 3
  ssn2: `${P1}.f1_12[0]`,                     // MaxLen 2
  ssn3: `${P1}.f1_13[0]`,                     // MaxLen 4
  ein1: `${P1}.f1_14[0]`,                     // MaxLen 2
  ein2: `${P1}.f1_15[0]`,                     // MaxLen 7
} as const;

/** Line 3a checkbox widget per classification (c1_1[0..6], in form order). */
export const CLASSIFICATION_CHECKBOX: Record<W9TaxClassification, string> = {
  individual:   `${BOXES}.c1_1[0]`,
  c_corp:       `${BOXES}.c1_1[1]`,
  s_corp:       `${BOXES}.c1_1[2]`,
  partnership:  `${BOXES}.c1_1[3]`,
  trust_estate: `${BOXES}.c1_1[4]`,
  llc:          `${BOXES}.c1_1[5]`,
  other:        `${BOXES}.c1_1[6]`,
};

// ── Page content-stream text extraction ──────────────────────────────────────
// Used ONLY to locate the Part II item-2 certification text so the strike-out
// lands on the real glyphs instead of a guessed rectangle.

export interface TextRun { text: string; x: number; y: number; size: number }

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** Decoded (de-filtered) bytes of a page's content stream(s), concatenated. */
export function readPageContent(page: PDFPage): Uint8Array {
  const ctx = page.node.context;
  const resolve = (o: any) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const contents: any = resolve(page.node.Contents());
  const parts: Uint8Array[] = [];
  const push = (o: any) => {
    const s = resolve(o);
    if (s instanceof PDFRawStream) parts.push(decodePDFRawStream(s).decode());
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) push(contents.get(i));
  } else {
    push(contents);
  }
  if (!parts.length) throw new W9TemplateError("W-9 template page 1 has no readable content stream");
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; out[off++] = 0x0a; }
  return out;
}

// Content-stream string operands are raw font bytes. The template's body faces
// use WinAnsiEncoding, whose 0x80–0x9F block differs from Latin-1 (typographic
// quotes, dashes, ™ …) — decode it so extracted text is real Unicode.
const WIN_ANSI_C1 = [
  "\u20ac", " ",      "\u201a", "\u0192", "\u201e", "\u2026", "\u2020", "\u2021",
  "\u02c6", "\u2030", "\u0160", "\u2039", "\u0152", " ",      "\u017d", " ",
  " ",      "\u2018", "\u2019", "\u201c", "\u201d", "\u2022", "\u2013", "\u2014",
  "\u02dc", "\u2122", "\u0161", "\u203a", "\u0153", " ",      "\u017e", "\u0178",
];
function decodeWinAnsi(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out += c >= 0x80 && c <= 0x9f ? WIN_ANSI_C1[c - 0x80] : raw[i];
  }
  return out;
}

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "op"; v: string }
  | { t: "skip" };

function* tokenize(src: string): Generator<Token> {
  const n = src.length;
  let i = 0;
  const isWs = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
  const isDelim = (c: string) => "()<>[]{}/%".includes(c);
  while (i < n) {
    const c = src[i];
    if (isWs(c)) { i++; continue; }
    if (c === "%") { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (c === "(") {
      i++;
      let depth = 1;
      let out = "";
      while (i < n && depth > 0) {
        const ch = src[i];
        if (ch === "\\") {
          const e = src[i + 1];
          i += 2;
          if (e === "n") out += "\n";
          else if (e === "r") out += "\r";
          else if (e === "t") out += "\t";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "\n") { /* line continuation */ }
          else if (e === "\r") { if (src[i] === "\n") i++; }
          else if (e >= "0" && e <= "7") {
            let oct = e;
            while (oct.length < 3 && src[i] >= "0" && src[i] <= "7") { oct += src[i]; i++; }
            out += String.fromCharCode(parseInt(oct, 8));
          } else out += e; // \( \) \\ and every unknown escape → the char itself
          continue;
        }
        i++;
        if (ch === "(") { depth++; out += ch; continue; }
        if (ch === ")") { depth--; if (depth === 0) break; out += ch; continue; }
        out += ch;
      }
      yield { t: "str", v: decodeWinAnsi(out) };
      continue;
    }
    if (c === "<") {
      if (src[i + 1] === "<") { i += 2; yield { t: "skip" }; continue; }
      i++;
      let hex = "";
      while (i < n && src[i] !== ">") { if (!isWs(src[i])) hex += src[i]; i++; }
      i++;
      if (hex.length % 2) hex += "0";
      let out = "";
      for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      yield { t: "str", v: decodeWinAnsi(out) };
      continue;
    }
    if (c === ">") { i += src[i + 1] === ">" ? 2 : 1; yield { t: "skip" }; continue; }
    if (c === "/") {
      i++;
      while (i < n && !isWs(src[i]) && !isDelim(src[i])) i++;
      yield { t: "skip" };
      continue;
    }
    if (c === "[" || c === "]" || c === "{" || c === "}") { i++; yield { t: "skip" }; continue; }
    if ((c >= "0" && c <= "9") || c === "+" || c === "-" || c === ".") {
      let s = "";
      while (i < n && !isWs(src[i]) && !isDelim(src[i])) { s += src[i]; i++; }
      const v = Number.parseFloat(s);
      yield Number.isFinite(v) ? { t: "num", v } : { t: "skip" };
      continue;
    }
    let op = "";
    while (i < n && !isWs(src[i]) && !isDelim(src[i])) { op += src[i]; i++; }
    if (!op) { i++; continue; }
    yield { t: "op", v: op };
  }
}

/**
 * Positioned text runs on a page, in content-stream order. Horizontal advance
 * between consecutive shows on one line is approximated with Helvetica metrics
 * (the form's body face is a Helvetica clone); every run that FOLLOWS a
 * positioning operator (Tm/Td/TD/T*) — which is all we rely on — is exact.
 */
export function extractTextRuns(page: PDFPage, measure: (t: string, size: number) => number): TextRun[] {
  const src = Buffer.from(readPageContent(page)).toString("latin1");
  const runs: TextRun[] = [];
  let ctm: Matrix = IDENTITY;
  const ctmStack: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let leading = 0;
  let fontSize = 0;
  let operands: Token[] = [];
  const nums = () => operands.filter(o => o.t === "num").map(o => (o as any).v as number);
  const strs = () => operands.filter(o => o.t === "str").map(o => (o as any).v as string);

  const nextLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const show = (text: string) => {
    const m = mul(tm, ctm);
    const size = fontSize * Math.hypot(m[2], m[3]);
    if (text) runs.push({ text, x: m[4], y: m[5], size });
    // The advance is only ever an approximation (glyph metrics of the template's
    // own subset fonts are not consulted); a character our measuring font cannot
    // score must not abort the scan.
    let advance = 0;
    if (size) { try { advance = measure(text, size); } catch { advance = 0; } }
    const scaleX = Math.hypot(tm[0], tm[1]) || 1;
    tm = mul([1, 0, 0, 1, advance / scaleX, 0], tm);
  };

  for (const tok of tokenize(src)) {
    if (tok.t !== "op") { operands.push(tok); continue; }
    const a = nums();
    switch (tok.v) {
      case "q": ctmStack.push(ctm); break;
      case "Q": ctm = ctmStack.pop() ?? IDENTITY; break;
      case "cm": if (a.length >= 6) ctm = mul(a.slice(-6) as Matrix, ctm); break;
      case "BT": tm = tlm = IDENTITY; break;
      case "ET": tm = tlm = IDENTITY; break;
      case "Tf": if (a.length) fontSize = a[a.length - 1]; break;
      case "TL": if (a.length) leading = a[a.length - 1]; break;
      case "Tm": if (a.length >= 6) { tlm = a.slice(-6) as Matrix; tm = tlm; } break;
      case "Td": if (a.length >= 2) nextLine(a[a.length - 2], a[a.length - 1]); break;
      case "TD": if (a.length >= 2) { leading = -a[a.length - 1]; nextLine(a[a.length - 2], a[a.length - 1]); } break;
      case "T*": nextLine(0, -leading); break;
      case "Tj": case "'": case '"': {
        if (tok.v !== "Tj") nextLine(0, -leading);
        for (const s of strs()) show(s);
        break;
      }
      case "TJ": show(strs().join("")); break;
      default: break;
    }
    operands = [];
  }
  return runs;
}

// The Part II certification, item 2 — the sentence the IRS instructs the signer
// to cross out when they ARE subject to backup withholding. Matched on its own
// text so a layout shift moves the strike with it.
const ITEM2_PREFIXES = [
  "2. I am not subject to backup withholding",
  "Service (IRS) that I am subject to backup withholding",
  "no longer subject to backup withholding",
];

export interface StrikeSegment { x: number; y: number; width: number }

/** The three baseline-relative strike segments covering Part II item 2. */
export function locateBackupWithholdingItem2(
  page: PDFPage,
  measure: (t: string, size: number) => number,
  rightMargin = 576.25,
): StrikeSegment[] {
  const runs = extractTextRuns(page, measure);
  const start = runs.findIndex(r => r.text.trimStart().startsWith(ITEM2_PREFIXES[0]));
  if (start < 0) {
    throw new W9TemplateError(
      "Part II item 2 ('I am not subject to backup withholding') was not found in the W-9 template's page-1 text - " +
      "the certification block moved. Re-derive the strike geometry before enabling backup-withholding submissions.",
    );
  }
  const picked = runs.slice(start, start + ITEM2_PREFIXES.length);
  picked.forEach((run, i) => {
    if (!run || !run.text.trimStart().startsWith(ITEM2_PREFIXES[i])) {
      throw new W9TemplateError(`Part II item 2 line ${i + 1} did not match the expected text ("${ITEM2_PREFIXES[i]}") in the W-9 template.`);
    }
  });
  return picked.map(run => {
    const text = run.text.replace(/\s+$/, "");
    const width = Math.min(measure(text, run.size), rightMargin - run.x);
    // A strike through the middle of the lowercase band: ~0.30em above baseline.
    return { x: run.x, y: run.y + run.size * 0.3, width };
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Fill (but do NOT flatten) a loaded W-9 template. Split out from renderW9Pdf
 * so the acroform state — notably WHICH Line 3a checkbox got checked — stays
 * inspectable; flattening bakes the widgets away.
 */
export async function fillW9Form(doc: PDFDocument, input: W9PdfInput): Promise<Omit<W9RenderResult, "pdf">> {
  const form = doc.getForm();
  const page = doc.getPage(0);
  const black = rgb(0, 0, 0);

  // Every printed string must be WinAnsi-encodable; non-Latin scripts are
  // transliterated here (throws W9EncodingError → 400, never a 500 from
  // form.flatten()/drawText() deep inside pdf-lib).
  const legalName = sanitizeForW9(input.legalName, "legalName");
  const businessName = input.businessName ? sanitizeForW9(input.businessName, "businessName") : null;
  const signatureName = sanitizeForW9(input.signatureName, "signatureName");
  const addressLine1 = sanitizeForW9(input.address.line1, "address.line1");
  const city = sanitizeForW9(input.address.city, "address.city");

  // LOUD field access: an unknown id throws instead of yielding a blank W-9.
  const setText = (name: string, value: string) => {
    let field;
    try { field = form.getTextField(name); }
    catch (e) {
      throw new W9FieldError(`W-9 template field "${name}" is missing or is not a text field (${(e as Error).message}). The vendored template no longer matches server/w9Pdf.ts.`);
    }
    try { field.setText(value); }
    catch (e) {
      throw new W9FieldError(`W-9 template field "${name}" rejected its value (${(e as Error).message}).`);
    }
  };
  const checkBox = (name: string) => {
    let box;
    try { box = form.getCheckBox(name); }
    catch (e) {
      throw new W9FieldError(`W-9 template checkbox "${name}" is missing (${(e as Error).message}). The vendored template no longer matches server/w9Pdf.ts.`);
    }
    box.check();
    // Vector X inside the widget rect — drawn, not font-stamped, so EVERY
    // renderer shows the mark (checkbox appearance streams are viewer-dependent).
    const widget = box.acroField.getWidgets()[0];
    if (widget) {
      const r = widget.getRectangle();
      const pad = Math.min(1.2, r.width / 4, r.height / 4);
      const x0 = r.x + pad, x1 = r.x + r.width - pad;
      const y0 = r.y + pad, y1 = r.y + r.height - pad;
      page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 1.3, color: black });
      page.drawLine({ start: { x: x0, y: y1 }, end: { x: x1, y: y0 }, thickness: 1.3, color: black });
    }
  };

  setText(F.name, legalName);
  if (businessName) setText(F.business, businessName);

  // ── Line 3a: the signer's ACTUAL federal tax classification ────────────────
  if (!W9_TAX_CLASSIFICATIONS.includes(input.taxClassification)) {
    throw new W9FieldError(`Unknown W-9 tax classification "${input.taxClassification}"`);
  }
  checkBox(CLASSIFICATION_CHECKBOX[input.taxClassification]);
  if (input.taxClassification === "llc") {
    const letter = input.llcTaxClass;
    if (!letter || !W9_LLC_TAX_CLASSES.includes(letter)) {
      throw new W9FieldError("An LLC must declare its tax classification letter (C, S, or P) on Line 3a.");
    }
    setText(F.llcTaxClass, letter);
  } else if (input.taxClassification === "other") {
    const desc = (input.otherClassification ?? "").trim();
    if (!desc) throw new W9FieldError('Tax classification "Other" requires a description on Line 3a.');
    setText(F.otherClassification, sanitizeForW9(desc, "otherClassification"));
  }
  // Line 3b — flow-through entity with foreign partners/owners (Rev. 3-2024).
  if (input.foreignPartners) checkBox(F.line3bForeignPartners);

  // Line 4 — exemption codes (optional, free text per the IRS instructions).
  if (input.exemptPayeeCode) setText(F.exemptPayeeCode, sanitizeForW9(input.exemptPayeeCode, "exemptPayeeCode"));
  if (input.fatcaExemptionCode) setText(F.fatcaExemptionCode, sanitizeForW9(input.fatcaExemptionCode, "fatcaExemptionCode"));

  setText(F.address, addressLine1);
  setText(F.cityStateZip, `${city}, ${input.address.state} ${input.address.zip}`);
  if (input.requesterName) setText(F.requester, sanitizeForW9(input.requesterName, "requesterName"));
  if (input.accountNumbers) setText(F.accountNumbers, sanitizeForW9(input.accountNumbers, "accountNumbers"));

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
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const regular: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.05, 0.1, 0.35);
  page.drawText(signatureName, { x: 115, y: 198, size: 11, font: italic, color: ink });
  const dateText = input.signatureDate.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", year: "numeric" });
  page.drawText(dateText, { x: 520, y: 198, size: 10, font: regular, color: ink });

  // ── Part II item 2: "You must cross out item 2 above if you have been
  // notified by the IRS that you are currently subject to backup withholding."
  if (input.subjectToBackupWithholding) {
    const measure = (t: string, size: number) => regular.widthOfTextAtSize(t, size);
    for (const seg of locateBackupWithholdingItem2(page, measure)) {
      page.drawLine({
        start: { x: seg.x, y: seg.y }, end: { x: seg.x + seg.width, y: seg.y },
        thickness: 1, color: black,
      });
    }
  }

  return {
    rendered: { legalName, businessName, signatureName },
    transliterated:
      legalName !== input.legalName ||
      signatureName !== input.signatureName ||
      businessName !== input.businessName,
  };
}

export async function renderW9Pdf(input: W9PdfInput): Promise<W9RenderResult> {
  const doc = await PDFDocument.load(loadW9Template());
  const filled = await fillW9Form(doc, input);
  doc.getForm().flatten(); // baked-in values: the issued PDF is a record, not a form
  return { pdf: await doc.save(), ...filled };
}
