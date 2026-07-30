import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELECTRONIC_CONSENT_VERSION, ONBOARDING_DOCUMENT_TYPES } from "../../shared/onboardingDocuments";
import { buildAgreementSnapshot } from "../../server/onboardingAgreementTemplates";

let store: typeof import("../../server/onboardingDocumentStore");
let recruitingStore: typeof import("../../server/onboardingRecruitingStore");
let workflow: typeof import("../../server/onboardingDocumentRoutes");
let pipeline: typeof import("../../server/onboardingPipeline");
let applicationService: typeof import("../../server/onboardingApplicationService");
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-onboarding-sign-"));
  process.env.ONBOARDING_INVITE_SECRET = "test-onboarding-invite-secret-with-more-than-32-characters";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  store = await import("../../server/onboardingDocumentStore");
  recruitingStore = await import("../../server/onboardingRecruitingStore");
  workflow = await import("../../server/onboardingDocumentRoutes");
  pipeline = await import("../../server/onboardingPipeline");
  applicationService = await import("../../server/onboardingApplicationService");
});

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "Home Front Test <test@example.com>";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ id: "resend-test-email" }),
  }));
  rawDb.prepare("DELETE FROM onboarding_signature_events").run();
  rawDb.prepare("DELETE FROM onboarding_signing_documents").run();
  rawDb.prepare("DELETE FROM onboarding_recruiting_invites").run();
  rawDb.prepare("DELETE FROM rep_applications").run();
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
    const sameVersion = store.reserveSigningDocument(reservation());
    expect(sameVersion.created).toBe(false);
    expect(sameVersion.row.id).toBe(row.id);
  });

  it("never leaks signer IP, user-agent, or evidence to the rep/manager document list", () => {
    // The public projection is a real allowlist, not a type cast: the old cast
    // left signedIp / signedUserAgent / evidence on the object at runtime, so
    // JSON.stringify shipped every signer's forensic session data to browsers.
    const row = store.reserveSigningDocument(reservation()).row;
    store.markDocumentsSent([row.id], "resend-email-x", null, "2026-07-13T10:10:00.000Z");
    store.markDocumentViewed(row.id, 100, "203.0.113.9", "SecretAgent/1.0");
    const current = store.getSigningDocument(row.id)!;
    const pdf = Buffer.from("%PDF leak-test");
    store.completeSigning({
      id: row.id, expectedContentSha256: current.contentSha256, signatureName: current.signerName,
      signatureSha256: "d".repeat(64), consentVersion: ELECTRONIC_CONSENT_VERSION,
      signedAt: "2026-07-13T12:00:00.000Z", signedUserId: 100, ipAddress: "203.0.113.9",
      userAgent: "SecretAgent/1.0", evidence: { intentToSign: true, secretMarker: "DO-NOT-LEAK" },
      pdf, pdfSha256: crypto.createHash("sha256").update(pdf).digest("hex"),
    });

    const publicRows = store.listRepDocuments(1, 10);
    const serialized = JSON.stringify(publicRows);
    expect(serialized).not.toContain("203.0.113.9");        // signer IP
    expect(serialized).not.toContain("SecretAgent");        // signer user-agent
    expect(serialized).not.toContain("DO-NOT-LEAK");        // evidence json
    for (const r of publicRows as any[]) {
      expect(r.signedIp).toBeUndefined();
      expect(r.signedUserAgent).toBeUndefined();
      expect(r.evidence).toBeUndefined();
      expect(r.snapshot).toBeUndefined();
    }
    // …but the SERVER-internal view still carries them, for PDFs and audit.
    const privateRows = store.listRepDocumentsPrivate(1, 10);
    expect(privateRows[0].signedIp).toBe("203.0.113.9");
    expect((privateRows[0].evidence as any)?.secretMarker).toBe("DO-NOT-LEAK");
    // The projection preserves every public field verbatim.
    expect(store.toPublicRecord(privateRows[0])).toMatchObject({
      id: row.id, status: "completed", signerEmail: current.signerEmail,
    });
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

  it("tracks pre-account recruiting invitations per tenant", () => {
    const first = recruitingStore.createRecruitingInvite({
      tenantId: 1,
      candidateName: "Casey Candidate",
      candidateEmail: "CASEY@example.com",
      invitedBy: 100,
    });
    recruitingStore.markRecruitingInviteSent(first.id, "resend-invite-1");
    expect(() => recruitingStore.createRecruitingInvite({
      tenantId: 1,
      candidateName: "Casey Again",
      candidateEmail: "casey@example.com",
      invitedBy: 100,
    })).toThrow("open invitation");
    const second = recruitingStore.createRecruitingInvite({
      tenantId: 2,
      candidateName: "Taylor Candidate",
      candidateEmail: "taylor@example.com",
      invitedBy: null,
    });
    recruitingStore.markRecruitingInviteFailed(second.id, "Mailbox unavailable");

    expect(recruitingStore.listRecruitingInvites(1)).toMatchObject([{
      candidateName: "Casey Candidate",
      candidateEmail: "casey@example.com",
      status: "invited",
      emailId: "resend-invite-1",
    }]);
    expect(recruitingStore.listRecruitingInvites(2)).toMatchObject([{
      candidateName: "Taylor Candidate",
      status: "failed",
      failureReason: "Mailbox unavailable",
    }]);
  });

  it("creates a secure pre-account invite, resolves it once, and attaches the application", () => {
    const invite = recruitingStore.createRecruitingInvite({
      tenantId: 1,
      candidateName: "Casey Candidate",
      candidateEmail: "casey@example.com",
      invitedBy: 100,
    });
    recruitingStore.markRecruitingInviteSent(invite.id, "resend-invite-1");
    const token = recruitingStore.secureTokenForInvite(invite.id);
    expect(recruitingStore.resolveRecruitingInviteToken(token)).toMatchObject({ id: invite.id, tenantId: 1, applicationId: null });
    expect(recruitingStore.resolveRecruitingInviteToken(`${token.slice(0, -1)}x`)).toBeNull();

    const application = storage.createRepApplication({
      tenantId: 1,
      inviteId: invite.id,
      fullName: "Casey Candidate",
      email: "casey@example.com",
      phone: "3365550100",
      city: "Lexington",
      zip: "27292",
      state: "NC",
      hasSalesExperience: false,
      preferredCarriers: "Kinetic",
    });
    const attached = recruitingStore.attachApplicationToInvite(invite.id, application.id);
    expect(attached).toMatchObject({ applicationId: application.id, status: "under_review" });
    expect(storage.getRepApplicationById(application.id)).toMatchObject({ inviteId: invite.id, tenantId: 1 });
    expect(recruitingStore.resolveRecruitingInviteToken(token)).toBeNull();
    expect(() => recruitingStore.attachApplicationToInvite(invite.id, application.id)).toThrow("already been used");
  });

  it("accepts a careers applicant with no account or organization membership into the owning tenant queue", () => {
    process.env.CAREERS_TENANT_SLUG = "home-front-solutions";
    const email = "public-careers-applicant@example.com";
    expect(storage.getUserByEmail(email)).toBeUndefined();

    const application = applicationService.submitPublicApplication({
      fullName: "Public Careers Applicant",
      email,
      phone: "3365550199",
      city: "Greensboro",
      state: "NC",
      zip: "27401",
      hasSalesExperience: false,
      preferredCarriers: "Kinetic Fiber",
      desiredRole: "Field Sales Representative",
      requestedSource: "careers",
      actorIp: "127.0.0.1",
    });

    expect(storage.getUserByEmail(email)).toBeUndefined();
    expect(application).toMatchObject({
      tenantId: 1,
      applicationSource: "careers",
      desiredRole: "Field Sales Representative",
      status: "pending",
      userId: null,
    });
    expect(pipeline.buildOnboardingPipeline(1, "https://portal.example.com")).toEqual(
      expect.arrayContaining([expect.objectContaining({
        applicationId: application.id,
        candidateEmail: email,
        source: "careers",
        stage: "under_review",
      })]),
    );
    expect(pipeline.buildOnboardingPipeline(2, "https://portal.example.com").some(record => record.applicationId === application.id)).toBe(false);
  });

  it("uses an invitation token as the authoritative tenant and blocks org spoofing", () => {
    const invite = recruitingStore.createRecruitingInvite({
      tenantId: 2,
      candidateName: "Invited Candidate",
      candidateEmail: "invited-candidate@example.com",
      invitedBy: null,
    });
    recruitingStore.markRecruitingInviteSent(invite.id, "invite-email-id");
    const application = applicationService.submitPublicApplication({
      fullName: "Invited Candidate",
      email: "invited-candidate@example.com",
      phone: "3365550188",
      city: "Lexington",
      state: "NC",
      zip: "27292",
      hasSalesExperience: true,
      preferredCarriers: "Kinetic Fiber",
      requestedSource: "careers",
      orgSlug: "home-front-solutions",
      inviteToken: recruitingStore.secureTokenForInvite(invite.id),
    });
    expect(application).toMatchObject({ tenantId: 2, inviteId: invite.id, applicationSource: "invited" });

    expect(() => applicationService.submitPublicApplication({
      fullName: "Spoofed Candidate",
      email: "spoofed@example.com",
      phone: "3365550177",
      city: "Lexington",
      state: "NC",
      zip: "27292",
      hasSalesExperience: false,
      preferredCarriers: "Kinetic Fiber",
      orgSlug: "tenant-that-does-not-exist",
    })).toThrow("organization application link is invalid");
  });

  it("issues the full required agreement pack once after approval", async () => {
    const issued = await workflow.issueOnboardingDocuments({
      tenantId: 1,
      repId: 10,
      sentBy: 100,
      actorIp: "127.0.0.1",
      actorUserAgent: "Vitest",
      origin: "https://portal.example.com",
    });
    expect(issued.createdCount).toBe(4);
    expect(issued.emailId).toBe("resend-test-email");
    expect(issued.results.filter(result => result.sent)).toHaveLength(4);
    expect(store.listRepDocuments(1, 10).every(document => document.status === "sent")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    const retried = await workflow.issueOnboardingDocuments({
      tenantId: 1,
      repId: 10,
      sentBy: 100,
      actorIp: "127.0.0.1",
      actorUserAgent: "Vitest",
      origin: "https://portal.example.com",
    });
    expect(retried.createdCount).toBe(0);
    expect(retried.results.filter(result => result.skipped)).toHaveLength(4);
    expect(fetch).toHaveBeenCalledTimes(1);

    const resent = await workflow.issueOnboardingDocuments({
      tenantId: 1,
      repId: 10,
      sentBy: 100,
      actorIp: "127.0.0.1",
      actorUserAgent: "Vitest",
      origin: "https://portal.example.com",
      forceEmail: true,
      deliveryAttempt: "safe-retry-1",
    });
    expect(resent.createdCount).toBe(0);
    expect(resent.results.filter(result => result.resent)).toHaveLength(4);
    expect(store.listRepDocuments(1, 10)).toHaveLength(4);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the pipeline tenant scoped and activates only after all four required signatures", async () => {
    rawDb.prepare("UPDATE team_members SET active = 0 WHERE id = 10").run();
    const invite = recruitingStore.createRecruitingInvite({
      tenantId: 1, candidateName: "Jordan Rep", candidateEmail: "jordan@example.com", invitedBy: 100,
    });
    recruitingStore.markRecruitingInviteSent(invite.id, "recruiting-email-1");
    const application = storage.createRepApplication({
      tenantId: 1, inviteId: invite.id, fullName: "Jordan Rep", email: "jordan@example.com",
      phone: "3365550100", city: "Lexington", zip: "27292", state: "NC",
      hasSalesExperience: true, preferredCarriers: "Kinetic",
    });
    recruitingStore.attachApplicationToInvite(invite.id, application.id);
    recruitingStore.markInviteApproved(invite.id);
    recruitingStore.markInviteLoginSent(invite.id, "login-email-1");
    storage.updateRepApplication(application.id, { status: "approved", userId: 100 });

    const otherTenantInvite = recruitingStore.createRecruitingInvite({
      tenantId: 2, candidateName: "Other Tenant", candidateEmail: "other@example.com", invitedBy: null,
    });
    recruitingStore.markRecruitingInviteSent(otherTenantInvite.id, "other-email");
    const tenantOneRecords = pipeline.buildOnboardingPipeline(1, "https://portal.example.com");
    expect(tenantOneRecords.map(record => record.candidateEmail)).toContain("jordan@example.com");
    expect(tenantOneRecords.map(record => record.candidateEmail)).not.toContain("other@example.com");

    const issued = await workflow.issueOnboardingDocuments({
      tenantId: 1, repId: 10, sentBy: 100, actorIp: "127.0.0.1",
      actorUserAgent: "Vitest", origin: "https://portal.example.com",
    });
    expect(issued.results.filter(result => result.sent)).toHaveLength(4);
    recruitingStore.markInviteAgreementsIssued(invite.id);

    const documents = store.listRepDocuments(1, 10);
    expect(documents).toHaveLength(ONBOARDING_DOCUMENT_TYPES.length);
    for (let index = 0; index < documents.length; index += 1) {
      const document = store.getSigningDocument(documents[index].id)!;
      const pdf = Buffer.from(`%PDF-1.7 signed-${index}`);
      store.completeSigning({
        id: document.id,
        expectedContentSha256: document.contentSha256,
        signatureName: document.signerName,
        signatureSha256: String(index + 1).repeat(64),
        consentVersion: ELECTRONIC_CONSENT_VERSION,
        signedAt: new Date(Date.UTC(2026, 6, 13, 12, index)).toISOString(),
        signedUserId: 100,
        ipAddress: "127.0.0.1",
        userAgent: "Vitest",
        evidence: { intentToSign: true },
        pdf,
        pdfSha256: crypto.createHash("sha256").update(pdf).digest("hex"),
      });
      const activation = pipeline.syncRepActivation({ tenantId: 1, repId: 10 });
      expect(activation.signedCount).toBe(index + 1);
      expect(activation.activated).toBe(index === documents.length - 1);
      expect(rawDb.prepare("SELECT active FROM team_members WHERE id = 10").get()).toMatchObject({ active: index === documents.length - 1 ? 1 : 0 });
    }
    expect(recruitingStore.getRecruitingInvite(invite.id)).toMatchObject({ status: "active" });
    expect(pipeline.buildOnboardingPipeline(1, "https://portal.example.com").find(record => record.inviteId === invite.id)).toMatchObject({
      stage: "active",
      milestones: { signedCount: 4, fullySigned: true, active: true },
    });
  });

  it("sends a CODE-FREE approval notice — never an embedded login code", async () => {
    // The welcome email must not carry an authentication secret: approval is a
    // manager action, and a code is only ever born from the rep's own request
    // on the sign-in screen. This pins that the email links to sign-in and
    // contains no 6-digit code.
    const sent = await workflow.sendOnboardingWelcome({
      email: "jordan@example.com",
      name: "Jordan Rep",
      origin: "https://portal.example.com",
    });
    expect(sent.id).toBe("resend-test-email");
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(request[1]?.body));
    expect(body.to).toEqual(["jordan@example.com"]);
    expect(body.subject).toContain("approved");
    expect(body.subject).not.toContain("code");
    expect(body.text).toContain("https://portal.example.com/#/my-documents");
    // No 6-digit login code anywhere in the rendered email.
    expect(body.text).not.toMatch(/\b\d{6}\b/);
    expect(body.html).not.toMatch(/\b\d{6}\b/);
  });
});
