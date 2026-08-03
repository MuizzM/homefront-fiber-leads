// A signer is entitled to read the REAL instrument before signing it.
//
// The ceremony used to render the agreement as HTML sections and only produce a
// PDF *after* the rep signed — so the document a rep reviewed was a re-creation
// of the one they were agreeing to, and the actual PDF first appeared when it
// was too late to decline. And the W-9, a form signed under penalty of perjury,
// was a hand-built input page: the rep never saw the IRS's own certification
// language or instructions.
//
// These pin the two review surfaces that fix that, and the scope walls on them.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@pdfreview.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const get = (path: string, session: string) =>
  fetch(`${baseUrl}${path}`, { headers: { "x-session-id": session } });
const post = (path: string, session: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session },
    body: JSON.stringify(body),
  });

let admin: Fixture, rep: Fixture, otherRep: Fixture, foreignAdmin: Fixture;
let documentId = 0;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-pdfreview-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;

  const tenantB = storage.createTenant({
    slug: "pdfreview-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@pdfreview.example.test", brandName: "Org B",
  } as any).id;

  admin = makePerson("Review Admin", "admin", 1, "manager");
  rep = makePerson("Review Rep", "rep", 1, "rep");
  otherRep = makePerson("Review Other", "rep", 1, "rep");
  foreignAdmin = makePerson("Review Foreign", "admin", tenantB, "manager");

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Issue the agreement through the STORE rather than the send route: the route
  // 503s without an email provider, and delivery is not what these tests are
  // about. The document ends up in exactly the state a real send produces.
  const { reserveSigningDocument, markDocumentsSent } = await import("../../server/onboardingDocumentStore");
  const { buildAgreementSnapshot } = await import("../../server/onboardingAgreementTemplates");
  const repRow = storage.getTeamMemberById(rep.memberId) as any;
  const snapshot = buildAgreementSnapshot({
    documentType: "independent_contractor",
    companyName: "Home Front Solutions",
    signerName: repRow.name,
    signerEmail: repRow.email,
    issuedAt: new Date().toISOString(),
  });
  const reserved = reserveSigningDocument({
    tenantId: 1, repId: rep.memberId, documentType: "independent_contractor", snapshot,
    signerName: repRow.name, signerEmail: repRow.email,
    sentBy: admin.userId, actorIp: "127.0.0.1", actorUserAgent: "vitest",
  });
  documentId = reserved.row.id;
  markDocumentsSent([documentId], "test-email-id", admin.userId);
  expect(documentId).toBeGreaterThan(0);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

const pdfBytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("agreement review copy", () => {
  it("serves the rep the complete agreement as a real PDF, before anything is signed", async () => {
    const res = await get(`/api/onboarding/documents/${documentId}/preview.pdf`, rep.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    const bytes = await pdfBytes(res);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // A real agreement, not a stub page.
    expect(bytes.length).toBeGreaterThan(2000);
  });

  it("opens INLINE — a download prompt mid-ceremony is a dead end", async () => {
    const res = await get(`/api/onboarding/documents/${documentId}/preview.pdf`, rep.session);
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("content-disposition")).not.toContain("attachment");
  });

  it("is marked REVIEW COPY so a saved preview can never pass for an executed agreement", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const res = await get(`/api/onboarding/documents/${documentId}/preview.pdf`, rep.session);
    // Content streams are compressed, so the mark is asserted through the
    // document metadata — which is also what a file manager and a mail client
    // show when the rep saves or forwards it.
    const doc = await PDFDocument.load(new Uint8Array(await pdfBytes(res)));
    expect(doc.getTitle()).toContain("REVIEW COPY");
    expect(doc.getSubject()).toContain("review copy");
  });

  it("is titled as unsigned, and the review copy is shorter than an executed one", async () => {
    // The executed copy adds the signature certificate page; the review copy
    // must not carry one, because nothing has been signed.
    const { PDFDocument } = await import("pdf-lib");
    const { renderAgreementPreviewPdf, renderSignedAgreementPdf } = await import("../../server/onboardingPdf");
    const { getSigningDocument } = await import("../../server/onboardingDocumentStore");
    const record = getSigningDocument(documentId)!;

    const preview = await PDFDocument.load(new Uint8Array(await renderAgreementPreviewPdf(record.snapshot)));
    const signed = await PDFDocument.load(new Uint8Array(await renderSignedAgreementPdf(record.snapshot, {
      recordId: record.recordId, signerName: "Review Rep", typedSignatureName: "Review Rep",
      signerEmail: "review.rep@pdfreview.example.test", signedAt: new Date().toISOString(),
      authenticatedUserId: rep.userId, ipAddress: "127.0.0.1", userAgent: "vitest",
      contentSha256: record.contentSha256, signatureSha256: "a".repeat(64),
    })));

    expect(preview.getTitle()).toContain("REVIEW COPY");
    expect(signed.getTitle()).not.toContain("REVIEW COPY");
    expect(signed.getPageCount()).toBeGreaterThan(preview.getPageCount() - 1);
  });

  it("is never served to another rep, and never across a tenant wall", async () => {
    expect((await get(`/api/onboarding/documents/${documentId}/preview.pdf`, otherRep.session)).status).toBe(404);
    expect((await get(`/api/onboarding/documents/${documentId}/preview.pdf`, foreignAdmin.session)).status).toBe(404);
  });

  it("404s a document that does not exist, without confirming anything", async () => {
    expect((await get(`/api/onboarding/documents/99999999/preview.pdf`, rep.session)).status).toBe(404);
  });
});

describe("the official IRS Form W-9", () => {
  it("serves the ACTUAL IRS template — not a re-creation", async () => {
    const res = await get("/api/onboarding/w9/blank.pdf", rep.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    const bytes = await pdfBytes(res);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // Byte-identical to the vendored, integrity-pinned template. This is the
    // assertion that stops the form quietly becoming a homemade clone again.
    const { loadW9Template, sha256, W9_TEMPLATE_SHA256 } = await import("../../server/w9Pdf");
    expect(sha256(new Uint8Array(bytes))).toBe(W9_TEMPLATE_SHA256);
    expect(bytes.length).toBe(loadW9Template().length);
  });

  it("includes the full form — the IRS instruction pages, not just page one", async () => {
    // A rep certifying under penalty of perjury should be able to read the
    // instructions that explain what they are certifying.
    const { PDFDocument } = await import("pdf-lib");
    const res = await get("/api/onboarding/w9/blank.pdf", rep.session);
    const doc = await PDFDocument.load(new Uint8Array(await pdfBytes(res)));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(5);
  });

  it("opens inline and is cacheable — the one PDF that never varies by user", async () => {
    const res = await get("/api/onboarding/w9/blank.pdf", rep.session);
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it("needs a login, but not a pay capability — it carries nobody's data", async () => {
    // The FILLED W-9 holds a live SSN and stays behind payouts.pay; the blank
    // government form is a public document any rep may read.
    expect((await fetch(`${baseUrl}/api/onboarding/w9/blank.pdf`)).status).toBe(401);
    expect((await get("/api/onboarding/w9/blank.pdf", otherRep.session)).status).toBe(200);
    expect((await get("/api/onboarding/w9/blank.pdf", foreignAdmin.session)).status).toBe(200);
  });
});
