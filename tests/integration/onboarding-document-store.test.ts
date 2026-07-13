import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: typeof import("../../server/onboardingDocumentStore");
let rawDb: import("better-sqlite3").Database;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-onboarding-docs-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  store = await import("../../server/onboardingDocumentStore");
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM docusign_webhook_events").run();
  rawDb.prepare("DELETE FROM onboarding_document_envelopes").run();
  rawDb.prepare("DELETE FROM team_members WHERE id IN (10, 20)").run();
  rawDb.prepare("INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'second-tenant', 'Second Tenant', 'Owner', 'owner2@example.com', 'Second Tenant')").run();
  rawDb.prepare("INSERT INTO team_members (id, name, email, role, active, tenant_id) VALUES (10, 'Jordan Rep', 'jordan@example.com', 'rep', 1, 1)").run();
  rawDb.prepare("INSERT INTO team_members (id, name, email, role, active, tenant_id) VALUES (20, 'Taylor Rep', 'taylor@example.com', 'rep', 1, 2)").run();
});

const reservation = (over: Record<string, unknown> = {}) => ({
  tenantId: 1,
  repId: 10,
  documentType: "independent_contractor" as const,
  templateId: "tpl-1",
  signerName: "Jordan Rep",
  signerEmail: "jordan@example.com",
  clientUserId: "homefront-1-10",
  sentBy: null,
  ...over,
});

describe("onboarding document envelope store", () => {
  it("reserves one active envelope per rep and document type", () => {
    const first = store.reserveEnvelope(reservation());
    const second = store.reserveEnvelope(reservation());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(rawDb.prepare("SELECT COUNT(*) count FROM onboarding_document_envelopes").get()).toMatchObject({ count: 1 });
  });

  it("allows a clean retry only after the prior attempt fails", () => {
    const first = store.reserveEnvelope(reservation());
    store.markEnvelopeFailed(first.row.id, "provider unavailable");
    const second = store.reserveEnvelope(reservation());
    expect(second.created).toBe(true);
    expect(second.row.id).not.toBe(first.row.id);
    expect(store.listRepEnvelopes(1, 10).map(row => row.status)).toEqual(["creating", "failed"]);
  });

  it("applies signed status once, ignores duplicate and stale Connect events", () => {
    const row = store.reserveEnvelope(reservation()).row;
    store.markEnvelopeSent(row.id, "env-1", "2026-07-13T10:00:00Z");
    const delivered = store.processConnectEvent({
      eventId: "evt-1",
      payloadSha256: "hash-1",
      intent: { envelopeId: "env-1", status: "delivered", eventType: "envelope-delivered", occurredAt: "2026-07-13T11:00:00Z" },
    });
    expect(delivered.applied).toBe(true);
    expect(store.getEnvelope(row.id)?.status).toBe("delivered");

    const duplicate = store.processConnectEvent({
      eventId: "evt-1",
      payloadSha256: "hash-1",
      intent: { envelopeId: "env-1", status: "completed", eventType: "envelope-completed", occurredAt: "2026-07-13T12:00:00Z" },
    });
    expect(duplicate.duplicate).toBe(true);
    expect(store.getEnvelope(row.id)?.status).toBe("delivered");

    const completed = store.processConnectEvent({
      eventId: "evt-2",
      payloadSha256: "hash-2",
      intent: { envelopeId: "env-1", status: "completed", eventType: "envelope-completed", occurredAt: "2026-07-13T12:00:00Z" },
    });
    expect(completed.applied).toBe(true);
    expect(store.getEnvelope(row.id)?.completedAt).toBe("2026-07-13T12:00:00Z");

    const stale = store.processConnectEvent({
      eventId: "evt-3",
      payloadSha256: "hash-3",
      intent: { envelopeId: "env-1", status: "delivered", eventType: "envelope-delivered", occurredAt: "2026-07-13T11:30:00Z" },
    });
    expect(stale.applied).toBe(false);
    expect(store.getEnvelope(row.id)?.status).toBe("completed");
  });

  it("keeps rep document lists tenant scoped", () => {
    store.reserveEnvelope(reservation());
    store.reserveEnvelope(reservation({ tenantId: 2, repId: 20, clientUserId: "homefront-2-20" }));
    expect(store.listRepEnvelopes(1, 10)).toHaveLength(1);
    expect(store.listRepEnvelopes(2, 20)).toHaveLength(1);
    expect(store.listRepEnvelopes(1, 20)).toHaveLength(0);
  });
});
