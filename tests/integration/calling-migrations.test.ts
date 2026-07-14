import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "hf-calling-migration-"));
let rawDb: import("better-sqlite3").Database;
let runCallingMigrations: () => void;
let callingSchemaVersion: () => string;
let tenantId: number;

const callingTables = [
  "organization_compliance_profiles", "calling_representative_holds", "seller_authorizations", "state_registrations",
  "approved_calling_scripts", "contact_enrichment_providers", "contacts", "phone_numbers",
  "phone_address_associations", "contact_enrichments", "phone_validations", "dnc_dataset_versions",
  "dnc_suppressions", "internal_dnc_entries", "platform_dnc_entries", "suppression_events", "consent_records",
  "consent_revocations", "calling_rule_versions", "compliance_decisions", "calling_queue_entries",
  "call_authorizations", "call_attempts", "call_dispositions", "callback_tasks",
  "calling_opportunities", "provider_usage_events", "calling_audit_events", "calling_audit_heads",
] as const;

beforeAll(async () => {
  process.env.DATA_DIR = dataDir;
  const storage = await import("../../server/storage");
  ({ rawDb } = await import("../../server/db"));
  storage.runMigrations();
  tenantId = storage.getDefaultTenantId()!;
  ({ runCallingMigrations, callingSchemaVersion } = await import("../../server/calling/migrations"));
});

afterAll(() => {
  try { rawDb.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Calling SQLite migration", () => {
  it("applies atomically and is safe to rerun", () => {
    expect(() => runCallingMigrations()).not.toThrow();
    expect(() => runCallingMigrations()).not.toThrow();

    const existing = new Set((rawDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of callingTables) expect(existing.has(table), table).toBe(true);

    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM calling_schema_versions WHERE version=?")
      .get(callingSchemaVersion())).toEqual({ n: 1 });
    expect((rawDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    const violations = rawDb.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>;
    expect(violations.filter((row) => (callingTables as readonly string[]).includes(row.table))).toEqual([]);
  });

  it("creates a fail-closed organization profile", async () => {
    const { ensureCallingProfile } = await import("../../server/calling/store");
    expect(ensureCallingProfile(tenantId)).toMatchObject({
      tenantId,
      callingEnabled: false,
      emergencyDisabled: true,
      counselApproved: false,
      sellerAuthorized: false,
      stateRulesApproved: false,
      callerIdAuthorized: false,
      dncMaxAgeDays: 31,
      propagateOptOutPlatformWide: false,
    });
  });

  it("upgrades the open-attempt lease from lead scope to tenant-phone scope", () => {
    // Simulate the index shape shipped by the earlier pilot and verify a
    // normal idempotent migration run repairs it in place.
    rawDb.exec(`DROP INDEX uq_call_attempt_one_open;
      CREATE UNIQUE INDEX uq_call_attempt_one_open
      ON call_attempts(tenant_id,lead_id,phone_id) WHERE ended_at IS NULL;`);
    expect(() => runCallingMigrations()).not.toThrow();
    const index = rawDb.prepare(`SELECT sql FROM sqlite_master
      WHERE type='index' AND name='uq_call_attempt_one_open'`).get() as { sql: string };
    expect(index.sql.replace(/\s+/g, "").toLowerCase())
      .toContain("oncall_attempts(tenant_id,phone_id)whereended_atisnull");
    expect(index.sql).not.toMatch(/lead_id/i);
  });

  it("purges plaintext resident phones from the generic lead table", () => {
    const leadId = Number(rawDb.prepare(`INSERT INTO leads
      (tenant_id,address,city,state,zip,lead_status,contact_phone,owner_phone,created_at,updated_at)
      VALUES (?,'10 Legacy Phone Rd','Lexington','NC','27292','prospect','3365550100','3365550101',?,?)`)
      .run(tenantId, "2026-07-14T16:00:00.000Z", "2026-07-14T16:00:00.000Z").lastInsertRowid);
    expect(() => runCallingMigrations()).not.toThrow();
    expect(rawDb.prepare("SELECT contact_phone AS contactPhone,owner_phone AS ownerPhone FROM leads WHERE id=?")
      .get(leadId)).toEqual({ contactPhone: null, ownerPhone: null });
  });

  it("enforces append-only internal DNC, consent, and audit evidence", () => {
    const now = "2026-07-14T16:00:00.000Z";
    rawDb.prepare(`INSERT INTO internal_dnc_entries
      (id,tenant_id,phone_hash,encrypted_e164,reason,channel,active,created_at)
      VALUES ('dnc-test',?,'${"a".repeat(64)}','encrypted','consumer_request','manual',1,?)`)
      .run(tenantId, now);
    expect(() => rawDb.prepare("DELETE FROM internal_dnc_entries WHERE id='dnc-test'").run())
      .toThrow(/internal_dnc_entries_are_immutable/);

    rawDb.prepare(`INSERT INTO platform_dnc_entries
      (id,phone_hash,reason,channel,source_tenant_id,created_at)
      VALUES ('platform-dnc-test',?,'consumer_request','manual',?,?)`)
      .run("f".repeat(64), tenantId, now);
    expect(() => rawDb.prepare("DELETE FROM platform_dnc_entries WHERE id='platform-dnc-test'").run())
      .toThrow(/platform_dnc_entries_are_immutable/);

    rawDb.prepare(`INSERT INTO calling_audit_events
      (id,tenant_id,correlation_id,event_type,entity_type,entity_id,metadata_json,event_sha256,created_at)
      VALUES ('audit-test',?,'correlation-test','migration.test','schema','v1','{}',?,?)`)
      .run(tenantId, "b".repeat(64), now);
    expect(() => rawDb.prepare("UPDATE calling_audit_events SET event_type='tampered' WHERE id='audit-test'").run())
      .toThrow(/calling_audit_events_are_append_only/);
    expect(() => rawDb.prepare("DELETE FROM calling_audit_events WHERE id='audit-test'").run())
      .toThrow(/calling_audit_events_are_append_only/);

    const phoneId = Number(rawDb.prepare(`INSERT INTO phone_numbers
      (tenant_id,phone_hash,encrypted_e164,masked_display) VALUES (?,?,?,?)`)
      .run(tenantId, "c".repeat(64), "encrypted-phone", "(•••) •••-1212").lastInsertRowid);
    rawDb.prepare(`INSERT INTO consent_records
      (id,tenant_id,phone_id,seller,service_address,consumer_identity,consent_type,channels_json,scope,
       disclosure_version,disclosure_text_sha256,method,source_ref,affirmative_action,evidence_artifact_ref,
       signature_ref,captured_at,time_zone,evidence_sha256)
      VALUES ('consent-test',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        tenantId, phoneId, "Home Front Solutions", "100 Main St, Lexington, NC",
        "Test Consumer", "express_written", '["manual_voice"]', "fiber sales",
        "disclosure-v1", "d".repeat(64), "signed_form", "first-party://test",
        "signed disclosure", "artifact://test", "signature://test", now,
        "America/New_York", "e".repeat(64),
      );
    expect(() => rawDb.prepare("UPDATE consent_records SET scope='tampered' WHERE id='consent-test'").run())
      .toThrow(/consent_records_are_immutable/);
    expect(() => rawDb.prepare("DELETE FROM consent_records WHERE id='consent-test'").run())
      .toThrow(/consent_records_are_immutable/);
  });

  it("serializes the tenant audit hash chain through a transactional head", async () => {
    const { appendCallingAudit, verifyCallingAuditIntegrity } = await import("../../server/calling/store");
    const first = appendCallingAudit({ tenantId, correlationId: "chain-1", eventType: "chain.first",
      entityType: "schema", entityId: "one", metadata: { ordinal: 1 } });
    const second = appendCallingAudit({ tenantId, correlationId: "chain-2", eventType: "chain.second",
      entityType: "schema", entityId: "two", metadata: { ordinal: 2 } });
    const firstHash = (rawDb.prepare("SELECT event_sha256 AS hash FROM calling_audit_events WHERE id=?")
      .get(first) as { hash: string }).hash;
    expect(rawDb.prepare(`SELECT previous_event_sha256 AS previousHash FROM calling_audit_events WHERE id=?`)
      .get(second)).toEqual({ previousHash: firstHash });
    expect(rawDb.prepare("SELECT event_id AS eventId,event_sha256 AS eventHash FROM calling_audit_heads WHERE tenant_id=?")
      .get(tenantId)).toEqual({ eventId: second, eventHash: (rawDb.prepare("SELECT event_sha256 AS hash FROM calling_audit_events WHERE id=?")
        .get(second) as { hash: string }).hash });
    expect(verifyCallingAuditIntegrity()).toMatchObject({ tenantsChecked: 1, invalidTenants: [] });
  });
});
