// @vitest-environment node
// ── W-9 PDF rendering: the parts that are legally load-bearing ───────────────
// This code fills a genuine IRS Form W-9 that a contractor signs under
// penalties of perjury. The assertions below pin the three things that were
// silently wrong before hardening:
//   1. the Line 3a tax classification checkbox actually reflects the signer,
//   2. Part II item 2 is struck when the signer IS subject to backup
//      withholding (at coordinates derived from the page, not guessed),
//   3. nothing fails quietly — a missing field, a tampered template, or an
//      unprintable name raises instead of producing a blank "valid" W-9.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import {
  CLASSIFICATION_CHECKBOX, W9_LLC_TAX_CLASSES, W9_TAX_CLASSIFICATIONS, W9_TEMPLATE_SHA256,
  W9FieldError, W9TemplateError, assertTemplateIntegrity, fillW9Form, loadW9Template,
  locateBackupWithholdingItem2, readPageContent, renderW9Pdf, sha256,
  type W9PdfInput, type W9TaxClassification,
} from "../../server/w9Pdf";
import { W9EncodingError, toPrintableLatin } from "../../server/w9Text";

const TEMPLATE = resolve(process.cwd(), "server", "assets", "fw9.pdf");

const P1 = "topmostSubform[0].Page1[0]";
const BOXES = `${P1}.Boxes3a-b_ReadOrder[0]`;

function input(over: Partial<W9PdfInput> = {}): W9PdfInput {
  return {
    legalName: "Dana Fieldrep",
    businessName: null,
    taxClassification: "individual",
    address: { line1: "742 Evergreen Ter", city: "Charlotte", state: "NC", zip: "28202" },
    tin: "123456789",
    tinType: "ssn",
    signatureName: "Dana Fieldrep",
    signatureDate: new Date("2026-08-03T16:00:00Z"),
    subjectToBackupWithholding: false,
    ...over,
  };
}

/** Fill a fresh copy of the template WITHOUT flattening, so widgets survive. */
async function fillFresh(over: Partial<W9PdfInput> = {}) {
  const doc = await PDFDocument.load(loadW9Template());
  const result = await fillW9Form(doc, input(over));
  return { doc, form: doc.getForm(), result };
}

describe("template integrity (Form W-9 Rev. 3-2024, Cat. No. 10231X)", () => {
  it("the vendored template matches the pinned SHA-256", () => {
    expect(sha256(readFileSync(TEMPLATE))).toBe(W9_TEMPLATE_SHA256);
  });

  it("a tampered template is rejected - a swapped revision can never be silently mis-filled", () => {
    const bytes = new Uint8Array(readFileSync(TEMPLATE));
    bytes[bytes.length - 1] ^= 0xff; // one flipped byte
    expect(() => assertTemplateIntegrity(bytes, "tampered.pdf")).toThrow(W9TemplateError);
    expect(() => assertTemplateIntegrity(bytes, "tampered.pdf")).toThrow(/does not match the pinned revision/);
  });

  it("loadW9Template accepts the real file", () => {
    expect(loadW9Template().length).toBeGreaterThan(100_000);
  });
});

describe("Line 3a - the signer's tax classification drives the checkbox", () => {
  const widgetFor = (c: W9TaxClassification) => CLASSIFICATION_CHECKBOX[c];

  it.each(W9_TAX_CLASSIFICATIONS)("%s checks exactly its own widget and no other", async (classification) => {
    const extra: Partial<W9PdfInput> =
      classification === "llc" ? { llcTaxClass: "S" }
      : classification === "other" ? { otherClassification: "Nonprofit corporation" }
      : {};
    const { form } = await fillFresh({ taxClassification: classification, ...extra });
    for (const other of W9_TAX_CLASSIFICATIONS) {
      const checked = form.getCheckBox(widgetFor(other)).isChecked();
      expect(checked, `${other} checkbox while filling ${classification}`).toBe(other === classification);
    }
  });

  it("the seven widgets are the documented c1_1[0..6] in IRS form order", () => {
    expect(W9_TAX_CLASSIFICATIONS.map(c => CLASSIFICATION_CHECKBOX[c])).toEqual([
      `${BOXES}.c1_1[0]`, `${BOXES}.c1_1[1]`, `${BOXES}.c1_1[2]`, `${BOXES}.c1_1[3]`,
      `${BOXES}.c1_1[4]`, `${BOXES}.c1_1[5]`, `${BOXES}.c1_1[6]`,
    ]);
  });

  it.each(W9_LLC_TAX_CLASSES)("an LLC writes its %s letter into the MaxLen-1 f1_03 field", async (letter) => {
    const { form } = await fillFresh({ taxClassification: "llc", llcTaxClass: letter });
    const field = form.getTextField(`${BOXES}.f1_03[0]`);
    expect(field.getMaxLength()).toBe(1);
    expect(field.getText()).toBe(letter);
  });

  it("an LLC with no C/S/P letter is refused - the form would be incomplete", async () => {
    await expect(fillFresh({ taxClassification: "llc", llcTaxClass: null })).rejects.toThrow(W9FieldError);
    await expect(fillFresh({ taxClassification: "llc", llcTaxClass: "X" as any })).rejects.toThrow(/C, S, or P/);
  });

  it('"Other" with no description is refused', async () => {
    await expect(fillFresh({ taxClassification: "other" })).rejects.toThrow(W9FieldError);
    await expect(fillFresh({ taxClassification: "other", otherClassification: "   " })).rejects.toThrow(/requires a description/);
  });

  it('"Other" writes its description into f1_04', async () => {
    const { form } = await fillFresh({ taxClassification: "other", otherClassification: "Nonprofit corporation" });
    expect(form.getTextField(`${BOXES}.f1_04[0]`).getText()).toBe("Nonprofit corporation");
  });

  it("Line 3b (flow-through with foreign partners) is off unless asked for", async () => {
    const off = await fillFresh({ taxClassification: "partnership" });
    expect(off.form.getCheckBox(`${BOXES}.c1_2[0]`).isChecked()).toBe(false);
    const on = await fillFresh({ taxClassification: "partnership", foreignPartners: true });
    expect(on.form.getCheckBox(`${BOXES}.c1_2[0]`).isChecked()).toBe(true);
  });

  it("Line 4 exemption codes and Line 7 account numbers render when present", async () => {
    const { form } = await fillFresh({
      taxClassification: "c_corp", exemptPayeeCode: "5", fatcaExemptionCode: "A", accountNumbers: "ACCT-4471",
    });
    expect(form.getTextField(`${P1}.f1_05[0]`).getText()).toBe("5");
    expect(form.getTextField(`${P1}.f1_06[0]`).getText()).toBe("A");
    expect(form.getTextField(`${P1}.f1_10[0]`).getText()).toBe("ACCT-4471");
  });
});

describe("Part I - TIN slicing lands in the right MaxLen boxes", () => {
  it("an SSN splits 3-2-4 across f1_11 / f1_12 / f1_13", async () => {
    const { form } = await fillFresh({ tin: "123456789", tinType: "ssn" });
    const a = form.getTextField(`${P1}.f1_11[0]`);
    const b = form.getTextField(`${P1}.f1_12[0]`);
    const c = form.getTextField(`${P1}.f1_13[0]`);
    expect([a.getMaxLength(), b.getMaxLength(), c.getMaxLength()]).toEqual([3, 2, 4]);
    expect([a.getText(), b.getText(), c.getText()]).toEqual(["123", "45", "6789"]);
    // and the EIN boxes stay empty
    expect(form.getTextField(`${P1}.f1_14[0]`).getText()).toBeUndefined();
  });

  it("an EIN splits 2-7 across f1_14 / f1_15", async () => {
    const { form } = await fillFresh({ tin: "987654321", tinType: "ein" });
    const a = form.getTextField(`${P1}.f1_14[0]`);
    const b = form.getTextField(`${P1}.f1_15[0]`);
    expect([a.getMaxLength(), b.getMaxLength()]).toEqual([2, 7]);
    expect([a.getText(), b.getText()]).toEqual(["98", "7654321"]);
    expect(form.getTextField(`${P1}.f1_11[0]`).getText()).toBeUndefined();
  });
});

describe("Part II item 2 - the backup-withholding strike", () => {
  it("is located from the page's own text at the certification block", async () => {
    const doc = await PDFDocument.load(loadW9Template());
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const segs = locateBackupWithholdingItem2(doc.getPage(0), (t, s) => helv.widthOfTextAtSize(t, s));
    expect(segs).toHaveLength(3);
    // Baselines 303.456 / 293.856 / 284.256 pt, struck 0.30em (2.4pt) above.
    expect(segs.map(s => Number(s.y.toFixed(3)))).toEqual([305.856, 296.256, 286.656]);
    expect(segs.map(s => s.x)).toEqual([36, 45, 45]);
    // Every segment stays inside the form's printable body (35.75 … 576.25pt)
    // and the two full-width lines are much longer than the short third line.
    for (const s of segs) {
      expect(s.width).toBeGreaterThan(100);
      expect(s.x + s.width).toBeLessThanOrEqual(576.25);
    }
    expect(segs[2].width).toBeLessThan(segs[0].width);
  });

  it("draws three strike lines into the page only when the signer is subject to it", async () => {
    const clean = await renderW9Pdf(input({ subjectToBackupWithholding: false }));
    const struck = await renderW9Pdf(input({ subjectToBackupWithholding: true }));
    // The strike is drawn straight into page 1's content stream: the item-2
    // baselines appear as line operators in the struck copy and nowhere in the
    // clean one.
    const strokes = async (pdf: Uint8Array) => {
      const doc = await PDFDocument.load(pdf);
      const ops = Buffer.from(readPageContent(doc.getPage(0))).toString("latin1");
      return [305.856, 296.256, 286.656]
        .filter(y => new RegExp(`\\b${Math.floor(y)}\\.\\d+ (m|l)\\b`).test(ops))
        .length;
    };
    expect(await strokes(struck.pdf)).toBe(3);
    expect(await strokes(clean.pdf)).toBe(0);
    expect(struck.pdf.length).not.toBe(clean.pdf.length);
  });
});

describe("loud failure - no blank-but-valid W-9", () => {
  it("a field id that is absent from the template throws W9FieldError", async () => {
    const doc = await PDFDocument.load(loadW9Template());
    const form = doc.getForm();
    // Simulate the IRS renaming a field in a future revision: rename f1_01
    // (Line 1, the legal name) in place. Before hardening this produced a W-9
    // with a BLANK name line and still returned 201.
    form.getTextField(`${P1}.f1_01[0]`).acroField.dict.set(PDFName.of("T"), PDFString.of("f1_01_renamed"));
    expect(form.getFields().some(f => f.getName() === `${P1}.f1_01[0]`)).toBe(false);
    await expect(fillW9Form(doc, input())).rejects.toThrow(W9FieldError);
    await expect(fillW9Form(doc, input())).rejects.toThrow(/no longer matches server\/w9Pdf\.ts/);
  });

  it("a value longer than a field's MaxLen throws instead of being truncated", async () => {
    const doc = await PDFDocument.load(loadW9Template());
    await expect(fillW9Form(doc, input({ taxClassification: "llc", llcTaxClass: "CS" as any })))
      .rejects.toThrow(/C, S, or P/);
  });
});

describe("non-Latin legal names", () => {
  it("ASCII and accented Latin print verbatim", async () => {
    const r = await renderW9Pdf(input({ legalName: "José Núñez", signatureName: "José Núñez" }));
    expect(r.rendered.legalName).toBe("José Núñez");
    expect(r.transliterated).toBe(false);
  });

  it("Cyrillic is transliterated (not a 500) and both forms are reported", async () => {
    const r = await renderW9Pdf(input({ legalName: "Иван Петров", signatureName: "Иван Петров" }));
    expect(r.rendered.legalName).toBe("Ivan Petrov");
    expect(r.rendered.signatureName).toBe("Ivan Petrov");
    expect(r.transliterated).toBe(true);
    expect(r.pdf.length).toBeGreaterThan(1000);
  });

  it("Vietnamese and Greek reduce to their closest Latin forms", () => {
    expect(toPrintableLatin("Nguyễn Văn Ảnh").text).toBe("Nguyen Van Anh");
    expect(toPrintableLatin("Γιώργος").text).toBe("Giorgos");
    expect(toPrintableLatin("Łukasz Ćwik").text).toBe("Lukasz Cwik");
  });

  it("CJK has no Latin representation - a typed, explainable error (→ 400), never a 500", async () => {
    await expect(renderW9Pdf(input({ legalName: "张伟", signatureName: "张伟" })))
      .rejects.toThrow(W9EncodingError);
    await expect(renderW9Pdf(input({ legalName: "张伟", signatureName: "张伟" })))
      .rejects.toThrow(/romanized/);
  });
});
