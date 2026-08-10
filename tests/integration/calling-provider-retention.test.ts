// Payload retention outlived the generic provider framework it was written
// for: contact_enrichments still holds encrypted payloads fetched before the
// switch to Tracerfy, and the contracts they came under oblige us to delete
// them on schedule. The adapter is gone; the deletion obligation is not.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "hf-calling-provider-retention-"));
const NOW = new Date("2026-07-14T16:00:00.000Z");
let rawDb: import("better-sqlite3").Database;
let tenantId = 0;
let otherTenantId = 0;
let leadId = 0;
let otherLeadId = 0;
let providers: typeof import("../../server/calling/providerRetention");

function insertProvider(input: {
  id: string;
  tenantId: number;
  name: string;
  retentionDays: number;
  permittedUseApproved?: boolean;
}): void {
  rawDb.prepare(`INSERT INTO contact_enrichment_providers
    (id,tenant_id,provider_name,adapter_type,enabled,contract_status,permitted_use_approved,
     permitted_uses_json,contract_reference,query_cost_micros,retention_days)
    VALUES (?,?,?,'generic_http_v1',1,'approved',?,'["phone_validation"]','contract://approved',10,?)`)
    .run(input.id, input.tenantId, input.name, input.permittedUseApproved === false ? 0 : 1, input.retentionDays);
}

function insertEnrichment(input: {
  id: string;
  tenantId: number;
  leadId: number;
  providerId: string;
  completedAt: string;
  expiresAt: string | null;
}): void {
  rawDb.prepare(`INSERT INTO contact_enrichments
    (id,tenant_id,lead_id,provider_config_id,idempotency_key,status,cost_micros,
     raw_response_encrypted,requested_at,completed_at,expires_at)
    VALUES (?,?,?,?,?,'enrichment_completed',10,?,?,?,?)`).run(
      input.id, input.tenantId, input.leadId, input.providerId, `idem-${input.id}`,
      `encrypted-${input.id}`, input.completedAt, input.completedAt, input.expiresAt,
    );
}

beforeAll(async () => {
  process.env.DATA_DIR = dataDir;
  const storage = await import("../../server/storage");
  ({ rawDb } = await import("../../server/db"));
  storage.runMigrations();
  tenantId = storage.getDefaultTenantId()!;
  otherTenantId = Number(rawDb.prepare(`INSERT INTO tenants
    (slug,company_name,owner_name,owner_email,brand_name,plan,status,created_at,updated_at)
    VALUES ('provider-retention-other','Other Org','Owner','provider-retention-other@example.test',
      'Other Org','trial','active',?,?)`).run(NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  (await import("../../server/calling/migrations")).runCallingMigrations();
  leadId = Number(rawDb.prepare(`INSERT INTO leads
    (address,city,state,zip,fiber_status,lead_status,tenant_id,created_at,updated_at)
    VALUES ('1 Retention St','Lexington','NC','27292','available','prospect',?,?,?)`)
    .run(tenantId, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  otherLeadId = Number(rawDb.prepare(`INSERT INTO leads
    (address,city,state,zip,fiber_status,lead_status,tenant_id,created_at,updated_at)
    VALUES ('2 Retention St','Lexington','NC','27292','available','prospect',?,?,?)`)
    .run(otherTenantId, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  providers = await import("../../server/calling/providerRetention");
});

afterAll(() => {
  delete process.env.DATA_DIR;
  try { rawDb.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("calling provider payload retention", () => {
  it("purges only expired encrypted payloads in bounded tenant batches", () => {
    insertProvider({ id: "provider-retain-30", tenantId, name: "Retain 30", retentionDays: 30 });
    insertProvider({ id: "provider-retain-zero", tenantId, name: "Retain zero", retentionDays: 0 });
    insertProvider({ id: "provider-other", tenantId: otherTenantId, name: "Other", retentionDays: 30 });
    insertEnrichment({
      id: "expired-by-cache", tenantId, leadId, providerId: "provider-retain-30",
      completedAt: "2026-07-01T00:00:00.000Z", expiresAt: "2026-07-10T00:00:00.000Z",
    });
    insertEnrichment({
      id: "expired-by-retention", tenantId, leadId, providerId: "provider-retain-30",
      completedAt: "2026-05-01T00:00:00.000Z", expiresAt: null,
    });
    insertEnrichment({
      id: "zero-retention", tenantId, leadId, providerId: "provider-retain-zero",
      completedAt: "2026-07-14T15:00:00.000Z", expiresAt: null,
    });
    insertEnrichment({
      id: "still-active", tenantId, leadId, providerId: "provider-retain-30",
      completedAt: "2026-07-14T15:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    });
    insertEnrichment({
      id: "other-tenant-expired", tenantId: otherTenantId, leadId: otherLeadId, providerId: "provider-other",
      completedAt: "2026-05-01T00:00:00.000Z", expiresAt: "2026-06-01T00:00:00.000Z",
    });

    expect(providers.purgeExpiredProviderPayloads({ tenantId, batchSize: 2, now: NOW }))
      .toEqual({ purged: 2, hasMore: true });
    expect(providers.purgeExpiredProviderPayloads({ tenantId, batchSize: 2, now: NOW }))
      .toEqual({ purged: 1, hasMore: false });

    const tenantRows = rawDb.prepare(`SELECT id,raw_response_encrypted AS raw,cost_micros AS cost,status
      FROM contact_enrichments WHERE tenant_id=? ORDER BY id`).all(tenantId) as any[];
    expect(tenantRows).toHaveLength(4);
    expect(tenantRows.filter((row) => row.id !== "still-active").every((row) => row.raw === null)).toBe(true);
    expect(tenantRows.find((row) => row.id === "still-active")).toMatchObject({
      raw: "encrypted-still-active", cost: 10, status: "enrichment_completed",
    });
    expect(rawDb.prepare("SELECT raw_response_encrypted AS raw FROM contact_enrichments WHERE id='other-tenant-expired'").get())
      .toEqual({ raw: "encrypted-other-tenant-expired" });

    expect(providers.purgeExpiredProviderPayloads({ batchSize: 10, now: NOW }))
      .toEqual({ purged: 1, hasMore: false });
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM contact_enrichments").get()).toEqual({ n: 5 });
  });
});
