// ── Company counter-signature (grafted onto the existing signing chain) ──────
// The rep's signature completes the rep half of an onboarding agreement and
// queues the COMPANY counter-signature (counter_sign_status 'none' →
// 'pending'). A manager holding onboarding.documents.manage counter-signs for
// the company ('pending' → 'completed'): a counter_signed link lands on the
// hash chain, the completed PDF is re-stamped with BOTH signatures, and the
// database trigger permits exactly that one post-completion write — nothing
// else about a signed agreement can ever change.
//
// Pinned here: the full lifecycle, the chain verification, the self-deal
// guard (company signer ≠ signing rep), the capability boundary (team_lead
// can never bind the company), cross-tenant invisibility, the immutability
// trigger's narrow exception, and the grandfathering of pre-graft completed
// documents (counter_sign_status 'none' — untouched by all of this).
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSigningTables } from "../helpers/signingTables";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
const realFetch = globalThis.fetch.bind(globalThis);

type Person = { userId: number; memberId: number; session: string; name: string };

function person(name: string, loginRole: string, tenantId = 1, memberRole = loginRole, memberId?: number): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@counter-sign.example.test`;
  const member = memberId != null
    ? storage.getTeamMemberById(memberId)!
    : storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId: null, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id, name };
}

function call(path: string, sessionId: string, init: RequestInit = {}) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, "x-csrf-token": sessionId, ...init.headers },
  });
}

let manager: Person, teamLead: Person, rep: Person, selfDealManager: Person, otherManager: Person;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-counter-sign-"));
  process.env.NODE_ENV = "test";
  process.env.APP_ORIGIN = "https://portal.example.com";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "Home Front Test <test@example.com>";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare("INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'other-tenant', 'Other Tenant', 'Other Owner', 'other-owner@example.com', 'Other Tenant')").run();

  manager = person("Counter Manager", "manager");
  teamLead = person("Counter Lead", "team_lead");
  rep = person("Counter Rep", "rep");
  // A manager login linked to the REP's team-member profile: same human would
  // be executing both halves of the contract — the self-deal case.
  selfDealManager = person("Selfdeal Manager", "manager", 1, "manager", rep.memberId);
  otherManager = person("Other Manager", "manager", 2);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  resetSigningTables(rawDb);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200, statusText: "OK",
    json: async () => ({ id: `resend-${crypto.randomUUID()}` }),
  }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

/** Issue one agreement to the rep and have them sign it. Returns ids + hashes. */
async function issueAndSign(documentType = "independent_contractor") {
  const sent = await call(`/api/onboarding/documents/reps/${rep.memberId}/send`, manager.session, {
    method: "POST", body: JSON.stringify({ documentTypes: [documentType] }),
  });
  expect(sent.status).toBe(200);
  const docRow = rawDb.prepare(
    "SELECT id FROM onboarding_signing_documents WHERE rep_id = ? ORDER BY id DESC LIMIT 1",
  ).get(rep.memberId) as any;
  const content = await (await call(`/api/onboarding/documents/${docRow.id}/content`, rep.session)).json() as any;
  const signed = await call(`/api/onboarding/documents/${docRow.id}/sign`, rep.session, {
    method: "POST",
    body: JSON.stringify({
      typedName: "counter rep",
      documentSha256: content.contentSha256,
      consentToElectronicRecords: true,
      acknowledgeRead: true,
      intentToSign: true,
    }),
  });
  const signedBody = await signed.json() as any;
  expect(signed.status, JSON.stringify(signedBody)).toBe(200);
  return { id: docRow.id as number, repPdfSha256: signedBody.completedPdfSha256 as string };
}

const docRow = (id: number) =>
  rawDb.prepare("SELECT * FROM onboarding_signing_documents WHERE id = ?").get(id) as any;

describe("company counter-sign lifecycle", () => {
  it("rep sign queues the company; manager counter-sign executes it and extends the chain", async () => {
    const { id, repPdfSha256 } = await issueAndSign();

    // Completion flipped the counter-sign state, not the legal status.
    expect(docRow(id)).toMatchObject({ status: "completed", counter_sign_status: "pending", company_signer_user_id: null });

    // …and the document is on the manager's queue (rep-facing views agree).
    const queue = (await (await call("/api/onboarding/documents/counter-sign-queue", manager.session)).json()) as any;
    expect(queue.queue.map((d: any) => d.id)).toContain(id);
    const mine = (await (await call("/api/onboarding/documents/me", rep.session)).json()) as any;
    expect(mine.history.find((d: any) => d.id === id)).toMatchObject({ status: "completed", counterSignStatus: "pending", companySignatureName: null });
    // The queue is a manager surface.
    expect((await call("/api/onboarding/documents/counter-sign-queue", rep.session)).status).toBe(403);

    // A typed name that is not the manager's profile name is refused.
    expect((await call(`/api/onboarding/documents/${id}/counter-sign`, manager.session, {
      method: "POST", body: JSON.stringify({ signatureName: "Not The Manager" }),
    })).status).toBe(400);

    const counterSigned = await call(`/api/onboarding/documents/${id}/counter-sign`, manager.session, {
      method: "POST", body: JSON.stringify({ signatureName: "counter manager" }),
    });
    const body = await counterSigned.json() as any;
    expect(counterSigned.status, JSON.stringify(body)).toBe(200);
    expect(body.counterSigned).toBe(true);
    expect(body.document).toMatchObject({
      status: "completed",
      counterSignStatus: "completed",
      companySignatureName: "counter manager",
    });
    expect(body.document.companySignedAt).toBeTruthy();
    // The dual-stamped PDF replaced the rep-only certificate.
    expect(body.completedPdfSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(body.completedPdfSha256).not.toBe(repPdfSha256);
    expect(body.verification).toMatchObject({ ok: true });

    // The chain carries the counter_signed link (after the completion-receipt
    // bookkeeping event) and still verifies end-to-end.
    const events = (await (await call(`/api/onboarding/documents/${id}/events`, manager.session)).json()) as any;
    expect(events.verification).toMatchObject({ ok: true, eventCount: 6 });
    expect(events.events.map((e: any) => e.eventType)).toEqual([
      "document_created", "invitation_sent", "document_viewed",
      "document_signed", "completion_receipt_sent", "counter_signed",
    ]);
    const counterEvent = events.events.find((e: any) => e.eventType === "counter_signed");
    expect(counterEvent).toBeTruthy();
    expect(counterEvent.actorUserId).toBe(manager.userId);
    expect(counterEvent.payload).toMatchObject({ companySignatureName: "counter manager", documentSha256: docRow(id).content_sha256 });

    // Off the queue; a second counter-sign is a conflict, not a rewrite.
    const after = (await (await call("/api/onboarding/documents/counter-sign-queue", manager.session)).json()) as any;
    expect(after.queue.map((d: any) => d.id)).not.toContain(id);
    expect((await call(`/api/onboarding/documents/${id}/counter-sign`, manager.session, {
      method: "POST", body: JSON.stringify({ signatureName: "counter manager" }),
    })).status).toBe(409);

    // The download now serves the dual-stamped copy, digest-advertised.
    const download = await call(`/api/onboarding/documents/${id}/download`, rep.session);
    expect(download.status).toBe(200);
    expect(download.headers.get("x-document-sha256")).toBe(body.completedPdfSha256);
    const pdf = Buffer.from(await download.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    // The audit trail recorded who bound the company.
    const audit = rawDb.prepare(
      "SELECT * FROM activity_log WHERE action = 'onboarding.document.counter_signed' AND entity_id = ?",
    ).get(id) as any;
    expect(audit).toBeTruthy();
  });

  it("self-deal is refused: the company signer must not be the rep who signed", async () => {
    const { id } = await issueAndSign();
    const response = await call(`/api/onboarding/documents/${id}/counter-sign`, selfDealManager.session, {
      method: "POST", body: JSON.stringify({ signatureName: "selfdeal manager" }),
    });
    expect(response.status).toBe(403);
    expect((await response.json() as any).code).toBe("COUNTER_SIGN_SELF_DEAL");
    expect(docRow(id).counter_sign_status).toBe("pending");
  });

  it("a team_lead can never bind the company, and other tenants cannot see the document", async () => {
    const { id } = await issueAndSign();
    expect((await call(`/api/onboarding/documents/${id}/counter-sign`, teamLead.session, {
      method: "POST", body: JSON.stringify({ signatureName: "counter lead" }),
    })).status).toBe(403);
    expect((await call(`/api/onboarding/documents/${id}/counter-sign`, otherManager.session, {
      method: "POST", body: JSON.stringify({ signatureName: "other manager" }),
    })).status).toBe(404);
    expect(docRow(id).counter_sign_status).toBe("pending");
  });

  it("the immutability trigger permits ONLY the counter-sign write on a completed document", async () => {
    const { id } = await issueAndSign();
    const expectAbort = (sql: string) =>
      expect(() => rawDb.prepare(sql).run(id)).toThrow(/immutable/);

    // Pre-counter-sign: every evidence rewrite aborts…
    expectAbort("UPDATE onboarding_signing_documents SET status = 'voided' WHERE id = ?");
    expectAbort("UPDATE onboarding_signing_documents SET completed_at = '2020-01-01' WHERE id = ?");
    expectAbort("UPDATE onboarding_signing_documents SET evidence_json = '{}' WHERE id = ?");
    expectAbort("UPDATE onboarding_signing_documents SET completed_pdf_sha256 = 'x' WHERE id = ?");
    // …including a direct write to the counter-sign columns that is NOT the
    // single permitted transition (company fields must move NULL → set with a
    // dual-stamped PDF, driven through counterSignDocument).
    expectAbort("UPDATE onboarding_signing_documents SET company_signature_name = 'forged' WHERE id = ?");
    expectAbort("UPDATE onboarding_signing_documents SET counter_sign_status = 'completed' WHERE id = ?");
    // Post-completion bookkeeping outside the protected columns still passes.
    rawDb.prepare("UPDATE onboarding_signing_documents SET completion_email_id = 're_bookkeeping' WHERE id = ?").run(id);

    // The one legal write: the counter-sign itself.
    expect((await call(`/api/onboarding/documents/${id}/counter-sign`, manager.session, {
      method: "POST", body: JSON.stringify({ signatureName: "counter manager" }),
    })).status).toBe(200);

    // The transition is consumed — company columns are now frozen too.
    expectAbort("UPDATE onboarding_signing_documents SET company_signature_name = 'replaced' WHERE id = ?");
    expectAbort("UPDATE onboarding_signing_documents SET company_signed_at = '2020-01-01' WHERE id = ?");
    expectAbort("UPDATE onboarding_signing_documents SET completed_pdf = x'00' WHERE id = ?");
    expect(docRow(id)).toMatchObject({ counter_sign_status: "completed", company_signature_name: "counter manager" });
  });

  it("grandfathered documents (counter_sign_status 'none') are untouched by the graft", async () => {
    // A pre-deploy completed row: fully executed under the single-party
    // ceremony. The INSERT path is how such rows exist (the trigger forbids
    // rewriting a completed row INTO this state — only history does).
    const signed = await issueAndSign();
    const source = docRow(signed.id);
    rawDb.prepare(
      `INSERT INTO onboarding_signing_documents
        (record_id, tenant_id, rep_id, document_type, document_version, document_title,
         document_snapshot_json, content_sha256, status, signer_name, signer_email,
         completed_at, signature_name, signature_sha256, completed_pdf, completed_pdf_sha256,
         counter_sign_status, created_at, updated_at)
       VALUES (?, ?, ?, 'commission_agreement', ?, ?, ?, ?, 'completed', ?, ?,
               '2026-01-01T00:00:00.000Z', ?, ?, ?, ?, 'none',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(
      crypto.randomUUID(), source.tenant_id, source.rep_id, source.document_version,
      `${source.document_title} (legacy)`, source.document_snapshot_json,
      "f".repeat(64), source.signer_name, source.signer_email,
      source.signature_name, source.signature_sha256, source.completed_pdf, "e".repeat(64),
    );
    const legacy = rawDb.prepare(
      "SELECT id FROM onboarding_signing_documents WHERE counter_sign_status = 'none' AND status = 'completed'",
    ).get() as any;

    // Never queued, never counter-signable — it was already fully executed.
    const queue = (await (await call("/api/onboarding/documents/counter-sign-queue", manager.session)).json()) as any;
    expect(queue.queue.map((d: any) => d.id)).not.toContain(legacy.id);
    const refused = await call(`/api/onboarding/documents/${legacy.id}/counter-sign`, manager.session, {
      method: "POST", body: JSON.stringify({ signatureName: "counter manager" }),
    });
    expect(refused.status).toBe(409);
    expect((await refused.json() as any).error).toMatch(/predates company counter-signing/);
    // Its original PDF still downloads, digest intact.
    const download = await call(`/api/onboarding/documents/${legacy.id}/download`, rep.session);
    expect(download.status).toBe(200);
    expect(download.headers.get("x-document-sha256")).toBe("e".repeat(64));
    // And the immutability trigger protects it exactly as before.
    expect(() => rawDb.prepare("UPDATE onboarding_signing_documents SET status = 'voided' WHERE id = ?").run(legacy.id)).toThrow(/immutable/);
    expect(docRow(legacy.id)).toMatchObject({ status: "completed", counter_sign_status: "none" });
  });
});
