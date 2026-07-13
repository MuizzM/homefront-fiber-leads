import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELECTRONIC_CONSENT_VERSION } from "../../shared/onboardingDocuments";
import { buildAgreementSnapshot } from "../../server/onboardingAgreementTemplates";

let store: typeof import("../../server/onboardingDocumentStore");
let rawDb: import("better-sqlite3").Database;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-onboarding-sign-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  store = await import("../../server/onboardingDocumentStore");
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM onboarding_signature_events").run();
  rawDb.prepare("DELETE FROM onboarding_signing_documents").run();
  rawDb.prepare("DELETE FROM users WHERE id = 100").run();
  rawDb.prepare("DELETE FROM team_members WHERE id IN (10, 20)").run();
  rawDb.prepare("INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'second-tenant', 'Second Tenant', 'Owner', 'owner2@example.com', 'Second Tenant')").run();
  rawDb.prepare("INSERT INTO team_members (id, name, email, role, active, tenant_id) VALUES (10, 'Jordan Rep', 'jordan@example.com', 'rep', 1, 1)").run();
  rawDb.prepare("INSERT INTO team_members (id, name, email, role, active, tenant_id) VALUES (20, 'Taylor Rep', 'taylor@example.com', 'rep', 1, 2)").run();
  rawDb.prepare("INSERT INTO users (id, name, email, role, team_member_id, active, tenant_id) VALUES (100, 'Jordan Rep', 'jordan-sign@example.com', 'rep', 10, 1, 1)").run();
});

function reservation(over: Record<string, unknown> = {}) {
  const documentType = (over.documentType as "independent_contractor" | undefined) ?? "independent_contractor";
  const signerName = (over.signerName as string | undefined) ?? "Jordan Rep";
  const signerEmail = (over.signerEmail as string | undefined) ?? "jordan@example.com";
  return {
    tenantId: 1,
    repId: 10,
    documentType,
    snapshot: buildAgreementSnapshot({ documentType, companyName: "Home Front Solutions LLC", signerName, signerEmail, issuedAt: "2026-07-13T10:00:00.000Z" }),
    signerName,
    signerEmail,
    sentBy: null,
    actorIp: "127.0.0.1",
    actorUserAgent: "Vitest",
    ...over,
  };
}

describe("first-party onboarding signing store", () => {
  it("reserves one active agreement per rep and document type", () => {
    const first = store.reserveSigningDocument(reservation());
    const second = store.reserveSigningDocument(reservation());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(rawDb.prepare("SELECT COUNT(*) count FROM onboarding_signing_documents").get()).toMatchObject({ count: 1 });
  });

  it("allows a clean retry after Resend delivery fails", () => {
    const first = store.reserveSigningDocument(reservation());
    store.markDocumentsFailed([first.row.id], "Resend unavailable", null);
    const second = store.reserveSigningDocument(reservation());
    expect(second.created).toBe(true);
    expect(second.row.id).not.toBe(first.row.id);
    expect(store.listRepDocuments(1, 10).map(row => row.status)).toEqual(["creating", "failed"]);
  });

  it("atomically signs once and stores a hash-chained evidence trail", () => {
    const row = store.reserveSigningDocument(reservation()).row;
    store.markDocumentsSent([row.id], "resend-email-1", null, "2026-07-13T10:10:00.000Z");
    store.markDocumentViewed(row.id, 100, "127.0.0.1", "Vitest");
    const current = store.getSigningDocument(row.id)!;
    const pdf = Buffer.from("%PDF-1.7 signed-test");
    const pdfSha256 = crypto.createHash("sha256").update(pdf).digest("hex");
    const signed = store.completeSigning({
      id: row.id,
      expectedContentSha256: current.contentSha256,
      signatureName: current.signerName,
      signatureSha256: "b".repeat(64),
      consentVersion: ELECTRONIC_CONSENT_VERSION,
      signedAt: "2026-07-13T12:00:00.000Z",
      signedUserId: 100,
      ipAddress: "127.0.0.1",
      userAgent: "Vitest",
      evidence: { intentToSign: true },
      pdf,
      pdfSha256,
    });
    expect(signed.status).toBe("completed");
    expect(store.getCompletedPdf(row.id)).toEqual(pdf);
    const events = store.listDocumentEvents(row.id);
    expect(events.map(event => event.eventType)).toEqual(["document_created", "invitation_sent", "document_viewed", "document_signed"]);
    for (let index = 1; index < events.length; index += 1) expect(events[index].previousEventSha256).toBe(events[index - 1].eventSha256);
    expect(() => store.completeSigning({
      id: row.id,
      expectedContentSha256: current.contentSha256,
      signatureName: current.signerName,
      signatureSha256: "c".repeat(64),
      consentVersion: ELECTRONIC_CONSENT_VERSION,
      signedAt: "2026-07-13T12:01:00.000Z",
      signedUserId: 100,
      ipAddress: "127.0.0.1",
      userAgent: "Vitest",
      evidence: { intentToSign: true },
      pdf,
      pdfSha256,
    })).toThrow("not available");
  });

  it("keeps rep document lists tenant scoped", () => {
    store.reserveSigningDocument(reservation());
    const second = reservation({ tenantId: 2, repId: 20, signerName: "Taylor Rep", signerEmail: "taylor@example.com" });
    second.snapshot = buildAgreementSnapshot({ documentType: "independent_contractor", companyName: "Second Tenant", signerName: "Taylor Rep", signerEmail: "taylor@example.com", issuedAt: "2026-07-13T10:00:00.000Z" });
    store.reserveSigningDocument(second);
    expect(store.listRepDocuments(1, 10)).toHaveLength(1);
    expect(store.listRepDocuments(2, 20)).toHaveLength(1);
    expect(store.listRepDocuments(1, 20)).toHaveLength(0);
  });
});
