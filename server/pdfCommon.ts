// ── The pdfkit plumbing every generated document needs, stated once ─────────
//
// pdfkit is a stream, not a function that returns bytes. Turning a document
// into a Buffer therefore takes the same eleven lines every single time: make
// the document, collect `data` chunks, reject on `error`, concatenate on `end`,
// and remember to call `doc.end()` or the promise hangs forever with no error.
//
// That harness was copied four times (three renderers in onboardingPdf.ts, one
// in commissionStatementPdf.ts). Nothing about it is document-specific, and the
// failure mode when a copy gets it subtly wrong is the worst kind: a request
// that never settles.
//
// This is PLUMBING ONLY, deliberately. Options are passed straight through —
// margins, page size and `info` differ per document and are part of that
// document's design, not something to normalise here — so every call site
// renders byte-for-byte what it rendered before. Layout, palette and letterhead
// stay with the module that owns the document.

import PDFDocument from "pdfkit";

/**
 * Build a PDF and resolve its bytes.
 *
 * `opts` reaches `new PDFDocument()` unchanged. `body` draws into the document;
 * it must NOT call `doc.end()` — the harness owns the document's lifecycle and
 * ends it once `body` returns. A throw from `body` rejects the promise, same as
 * a stream `error` does.
 */
export function renderPdfBuffer(
  opts: PDFKit.PDFDocumentOptions,
  body: (doc: PDFKit.PDFDocument) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(opts);
    const chunks: Buffer[] = [];
    doc.on("data", chunk => chunks.push(Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    body(doc);
    doc.end();
  });
}
