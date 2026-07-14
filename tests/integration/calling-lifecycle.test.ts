import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "hf-calling-lifecycle-"));
const NOW = new Date("2026-07-14T16:00:00.000Z"); // noon in North Carolina
let rawDb: import("better-sqlite3").Database;
let service: typeof import("../../server/calling/service");
let store: typeof import("../../server/calling/store");
let tenantId = 0;
let otherTenantId = 0;
let actorUserId = 0;
let managerUserId = 0;
let leadId = 0;
let phoneId = 0;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.DATA_DIR = dataDir;
  process.env.CALLING_MODULE_ENABLED = "true";
  process.env.CONTACT_ENRICHMENT_ENABLED = "true";
  process.env.NATIONAL_DNC_ENABLED = "true";
  process.env.STATE_RULES_ENABLED = "true";
  process.env.MANUAL_CLICK_TO_CALL_ENABLED = "true";
  process.env.CALLING_EMERGENCY_DISABLED = "false";
  process.env.CALLING_PILOT_ORG_IDS = "1";
  process.env.CALLING_DATA_ENCRYPTION_KEY = "11".repeat(32);
  process.env.PHONE_HASH_KEY = "22".repeat(32);
  process.env.CALL_AUTHORIZATION_SIGNING_KEY = "33".repeat(32);

  const storageModule = await import("../../server/storage");
  ({ rawDb } = await import("../../server/db"));
  storageModule.runMigrations();
  tenantId = storageModule.getDefaultTenantId()!;
  otherTenantId = Number(rawDb.prepare(`INSERT INTO tenants
    (slug,company_name,owner_name,owner_email,brand_name,plan,status,created_at,updated_at)
    VALUES ('other-calling','Other Calling','Other Owner','other-calling@example.test','Other','trial','active',?,?)`)
    .run(NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  (await import("../../server/calling/migrations")).runCallingMigrations();

  actorUserId = Number(rawDb.prepare(`INSERT INTO users
    (name,email,role,active,tenant_id,created_at) VALUES ('Calling Rep','calling-rep@example.test','calling_rep',1,?,?)`)
    .run(tenantId, NOW.toISOString()).lastInsertRowid);
  managerUserId = Number(rawDb.prepare(`INSERT INTO users
    (name,email,role,active,tenant_id,created_at) VALUES ('Calling Manager','calling-manager@example.test','calling_manager',1,?,?)`)
    .run(tenantId, NOW.toISOString()).lastInsertRowid);
  leadId = Number(rawDb.prepare(`INSERT INTO leads
    (address,city,state,zip,fiber_status,lead_status,tenant_id,created_at,updated_at)
    VALUES ('100 Manual Call St','Lexington','NC','27292','available','prospect',?,?,?)`)
    .run(tenantId, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  rawDb.prepare(`UPDATE leads SET source_scan_target_id=999,fresh_confirmed_at=?,fresh_confidence='cross_verified',
    fresh_sources='["provider_primary","public_record"]' WHERE id=? AND tenant_id=?`)
    .run(NOW.toISOString(), leadId, tenantId);

  rawDb.prepare(`INSERT INTO contact_enrichment_providers
    (id,tenant_id,provider_name,adapter_type,enabled,contract_status,permitted_use_approved,
     permitted_uses_json,contract_reference,contract_evidence_sha256,query_cost_micros,retention_days)
    VALUES ('provider-test',?,'First-party test','manual_import',1,'approved',1,
      '["telemarketing_contact_enrichment","phone_validation"]','contract://approved/test',?,0,30)`)
    .run(tenantId, "a".repeat(64));
  rawDb.prepare(`INSERT INTO calling_queue_entries
    (id,tenant_id,lead_id,stage,priority,assigned_user_id,created_at,updated_at)
    VALUES ('queue-test',?,?,'FRESH_FIBER_DETECTED',100,?,?,?)`)
    .run(tenantId, leadId, actorUserId, NOW.toISOString(), NOW.toISOString());

  store = await import("../../server/calling/store");
  store.updateCallingProfile(tenantId, actorUserId, {
    callingEnabled: true,
    emergencyDisabled: false,
    counselApproved: true,
    sellerAuthorized: true,
    sellerName: "Home Front Solutions",
    sellerAuthorizationRef: "seller-auth://test",
    stateRulesApproved: true,
    defaultTimeZone: "America/New_York",
    allowedStartLocal: "08:00",
    allowedEndLocal: "21:00",
    minimumIdentityConfidence: 0.85,
    maxAttempts7Days: 2,
    maxAttempts30Days: 3,
    dncMaxAgeDays: 31,
    callerIdAuthorized: true,
    callerIdReference: "caller-id://test",
  });
  rawDb.prepare(`INSERT INTO seller_authorizations
    (id,tenant_id,seller_name,authorization_ref,effective_at,expires_at,status,evidence_sha256,created_by,created_at)
    VALUES ('seller-authorization-test',?,'Home Front Solutions','seller-auth://test','2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z','active',?, ?,?)`)
    .run(tenantId, "d".repeat(64), actorUserId, NOW.toISOString());
  rawDb.prepare(`INSERT INTO state_registrations
    (id,tenant_id,state,legal_entity,registration_type,registration_number,evidence_ref,counsel_approved,
     effective_at,expires_at,last_reviewed_at,status,created_at,updated_at)
    VALUES ('registration-test',?,'NC','Home Front Solutions','registration','NC-TEST','registration://test',1,
      '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',?,'active',?,?)`)
    .run(tenantId, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  rawDb.prepare(`INSERT INTO approved_calling_scripts
    (id,tenant_id,version,title,body,disclosure_sha256,seller_name,company_name,purpose,active,counsel_approved,
     counsel_approval_reference,approved_by,approved_at)
    VALUES ('script-test',?,'script-v1','Fresh fiber','Hello, this is the approved manual script',?,
      'Home Front Solutions','Home Front Solutions','fiber availability',1,1,'counsel://script-test',?,?)`)
    .run(tenantId, "b".repeat(64), actorUserId, NOW.toISOString());
  rawDb.prepare(`INSERT INTO calling_rule_versions
    (id,tenant_id,version,rules_sha256,config_json,active,counsel_approval_reference,approved_by,approved_at)
    VALUES ('rules-test',?,'rules-v1',?,'{}',1,'counsel://rules-test',?,?)`)
    .run(tenantId, "c".repeat(64), actorUserId, NOW.toISOString());

  const candidate = store.storeManualContact({
    tenantId,
    leadId,
    phone: "(336) 555-1212",
    name: "Test Resident",
    relationship: "resident",
    identityConfidence: 0.97,
    providerConfigId: "provider-test",
    providerRecordId: "first-party-1",
    humanVerified: true,
  });
  phoneId = candidate.phoneId!;
  store.validatePhoneManually({
    tenantId,
    leadId,
    phoneId,
    providerConfigId: "provider-test",
    lineType: "wireless",
    reachable: true,
    reassignedRisk: false,
    evidenceRef: "validation://test",
    validDays: 30,
  });
  store.importDncDataset({
    tenantId,
    sourceType: "national",
    versionLabel: "national-test-v1",
    authorizedAccountRef: "registry-account://test",
    coveredAreaCodes: ["ALL"],
    phones: ["2125550100"],
    maxAgeDays: 30,
    actorUserId,
  });
  store.importDncDataset({
    tenantId,
    sourceType: "state",
    state: "NC",
    versionLabel: "nc-test-v1",
    authorizedAccountRef: "nc-registry://test",
    coveredAreaCodes: ["ALL"],
    phones: ["7045550100"],
    maxAgeDays: 30,
    actorUserId,
  });
  service = await import("../../server/calling/service");
});

function seedCallableLead(address: string, phone: string, providerRecordId: string): { leadId: number; phoneId: number } {
  const newLeadId = Number(rawDb.prepare(`INSERT INTO leads
    (address,city,state,zip,fiber_status,lead_status,tenant_id,created_at,updated_at)
    VALUES (?,'Lexington','NC','27292','available','prospect',?,?,?)`)
    .run(address, tenantId, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  rawDb.prepare(`UPDATE leads SET source_scan_target_id=?,fresh_confirmed_at=?,fresh_confidence='cross_verified',
    fresh_sources='["provider_primary","public_record"]' WHERE id=? AND tenant_id=?`)
    .run(10_000 + newLeadId, NOW.toISOString(), newLeadId, tenantId);
  rawDb.prepare(`INSERT INTO calling_queue_entries
    (id,tenant_id,lead_id,stage,priority,assigned_user_id,created_at,updated_at)
    VALUES (?,?,?,'FRESH_FIBER_DETECTED',100,?,?,?)`)
    .run(`queue-${newLeadId}`, tenantId, newLeadId, actorUserId, NOW.toISOString(), NOW.toISOString());
  const candidate = store.storeManualContact({ tenantId, leadId: newLeadId, phone, name: "Test Resident",
    relationship: "resident", identityConfidence: 0.97, providerConfigId: "provider-test",
    providerRecordId, humanVerified: true });
  store.validatePhoneManually({ tenantId, leadId: newLeadId, phoneId: candidate.phoneId!, providerConfigId: "provider-test",
    lineType: "wireless", reachable: true, reassignedRisk: false,
    evidenceRef: `validation://${providerRecordId}`, validDays: 30 });
  return { leadId: newLeadId, phoneId: candidate.phoneId! };
}

afterAll(() => {
  vi.useRealTimers();
  for (const name of [
    "CALLING_MODULE_ENABLED", "CONTACT_ENRICHMENT_ENABLED", "NATIONAL_DNC_ENABLED",
    "STATE_RULES_ENABLED", "MANUAL_CLICK_TO_CALL_ENABLED", "CALLING_EMERGENCY_DISABLED",
    "CALLING_PILOT_ORG_IDS", "CALLING_DATA_ENCRYPTION_KEY", "PHONE_HASH_KEY",
    "CALL_AUTHORIZATION_SIGNING_KEY",
  ]) delete process.env[name];
  try { rawDb.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Calling authorization lifecycle", () => {
  it("keeps background evaluation blocked until the rep explicitly requests a manual action", () => {
    const result = service.evaluateLeadCompliance({
      tenantId,
      actorUserId,
      actorRole: "calling_rep",
      leadId,
      canManage: false,
      correlationId: "background-evaluation",
    });
    expect(result.evaluation).toMatchObject({
      eligible: false,
      decision: "BLOCKED_AUTOMATED_DIAL_ATTEMPT",
    });
    expect(result.evaluation.reasonCodes).toContain("WIRELESS_REQUIRES_MANUAL_ACTION");

    process.env.MANUAL_CLICK_TO_CALL_ENABLED = "false";
    try {
      expect(() => service.issueCallAuthorization({
        tenantId,
        actorUserId,
        actorRole: "calling_rep",
        leadId,
        canManage: false,
        action: "reveal_and_hand_dial",
        correlationId: "manual-flag-disabled",
      })).toThrow(/BLOCKED_TENANT_POLICY/);
    } finally {
      process.env.MANUAL_CLICK_TO_CALL_ENABLED = "true";
    }
  });

  it("reveals one number once, records no auto-next action, and rejects replay/cross-tenant use", () => {
    const managerAuthorization = service.issueCallAuthorization({
      tenantId,
      actorUserId: managerUserId,
      actorRole: "calling_manager",
      leadId,
      canManage: true,
      action: "reveal_and_hand_dial",
      correlationId: "manager-authorization",
    });
    expect(() => service.startManualAttempt({ tenantId, actorUserId: managerUserId, actorRole: "calling_manager",
      token: managerAuthorization.token, correlationId: "manager-owner-bypass" })).toThrow(/Queue assignment changed/);

    const invalidatedAuthorization = service.issueCallAuthorization({
      tenantId,
      actorUserId,
      actorRole: "calling_rep",
      leadId,
      canManage: false,
      action: "reveal_and_hand_dial",
      correlationId: "authorization-before-reassignment",
    });
    const reassigned = store.updateCallingAssignment({ tenantId, leadId, assignedUserId: managerUserId,
      actorUserId: managerUserId, correlationId: "reassign-away" });
    expect(reassigned).toMatchObject({ changed: true });
    expect(reassigned.invalidatedAuthorizations).toBeGreaterThanOrEqual(2);
    expect(() => service.startManualAttempt({ tenantId, actorUserId, actorRole: "calling_rep",
      token: invalidatedAuthorization.token, correlationId: "invalidated-by-reassignment" }))
      .toThrow(/stale or already used/);
    expect(store.updateCallingAssignment({ tenantId, leadId, assignedUserId: actorUserId,
      actorUserId: managerUserId, correlationId: "reassign-back" })).toMatchObject({ changed: true });

    const authorization = service.issueCallAuthorization({
      tenantId,
      actorUserId,
      actorRole: "calling_rep",
      leadId,
      canManage: false,
      action: "reveal_and_hand_dial",
      correlationId: "manual-authorization",
    });
    expect(authorization.maskedPhone).toBe("(•••) •••-1212");
    expect(authorization.token).not.toContain("3365551212");

    expect(() => service.startManualAttempt({
      tenantId: otherTenantId,
      actorUserId,
      actorRole: "calling_rep",
      token: authorization.token,
      correlationId: "cross-tenant-attempt",
    })).toThrow(/not bound/);

    const started = service.startManualAttempt({
      tenantId,
      actorUserId,
      actorRole: "calling_rep",
      token: authorization.token,
      correlationId: "manual-attempt",
    });
    expect(started).toMatchObject({
      phoneNumber: "+13365551212",
      noAutomaticNextCall: true,
    });
    expect(started.script).toMatchObject({ version: "script-v1" });
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM call_attempts WHERE tenant_id=? AND lead_id=?")
      .get(tenantId, leadId)).toEqual({ n: 1 });
    expect(() => service.startManualAttempt({
      tenantId,
      actorUserId,
      actorRole: "calling_rep",
      token: authorization.token,
      correlationId: "replayed-attempt",
    })).toThrow(/stale or already used/);

    // This tenant's reviewed business policy requires its opt-outs to be
    // propagated to the immutable platform-wide suppression layer.
    rawDb.prepare(`UPDATE organization_compliance_profiles
      SET propagate_opt_out_platform_wide=1 WHERE tenant_id=?`).run(tenantId);

    const first = service.recordCallDisposition({
      tenantId,
      actorUserId,
      attemptId: started.attemptId,
      code: "DO_NOT_CALL",
      notes: "Consumer asked us to stop",
      idempotencyKey: "disposition-dnc-1",
      correlationId: "dnc-disposition",
    });
    expect(first).toMatchObject({ stage: "SUPPRESSED", replayed: false });
    expect(service.recordCallDisposition({
      tenantId,
      actorUserId,
      attemptId: started.attemptId,
      code: "DO_NOT_CALL",
      notes: "ignored replay body",
      idempotencyKey: "disposition-dnc-1",
      correlationId: "dnc-disposition-replay",
    })).toEqual({ ...first, replayed: true });
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM internal_dnc_entries WHERE tenant_id=? AND active=1")
      .get(tenantId)).toEqual({ n: 1 });
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM platform_dnc_entries").get()).toEqual({ n: 1 });
    expect(rawDb.prepare("SELECT stage FROM calling_queue_entries WHERE tenant_id=? AND lead_id=?")
      .get(tenantId, leadId)).toEqual({ stage: "SUPPRESSED" });
    expect(() => service.issueCallAuthorization({
      tenantId,
      actorUserId,
      actorRole: "calling_rep",
      leadId,
      canManage: false,
      action: "reveal_and_hand_dial",
      correlationId: "blocked-after-opt-out",
    })).toThrow(/BLOCKED_INTERNAL_DNC/);
  });

  it("never returns another tenant's queue candidate", () => {
    expect(store.getCallingCandidate(otherTenantId, leadId)).toBeNull();
    expect(store.getCallingCandidate(tenantId, leadId)).toMatchObject({ tenantId, leadId, phoneId });
    const encrypted = rawDb.prepare("SELECT encrypted_e164 AS encryptedE164 FROM phone_numbers WHERE tenant_id=? AND id=?")
      .get(tenantId, phoneId) as { encryptedE164: string };
    const otherPhoneId = Number(rawDb.prepare(`INSERT INTO phone_numbers
      (tenant_id,phone_hash,encrypted_e164,masked_display) VALUES (?,?,?,?)`)
      .run(otherTenantId, "9".repeat(64), encrypted.encryptedE164, "(•••) •••-1212").lastInsertRowid);
    expect(store.internalDncHit(otherTenantId, "9".repeat(64))).toBe(false);
    expect(store.platformDncHit(otherTenantId, otherPhoneId)).toBe(true);
  });

  it("leases a phone across duplicate leads and a cross-session STOP terminates the open attempt", () => {
    const primary = seedCallableLead("200 Phone Lease St", "3365553434", "phone-lease-primary");
    const duplicate = seedCallableLead("200 Phone Lease Street", "3365553434", "phone-lease-duplicate");
    expect(duplicate.phoneId).toBe(primary.phoneId);

    const authorization = service.issueCallAuthorization({ tenantId, actorUserId, actorRole: "calling_rep",
      leadId: primary.leadId, canManage: false, action: "reveal_and_hand_dial",
      correlationId: "phone-lease-authorization" });
    const attempt = service.startManualAttempt({ tenantId, actorUserId, actorRole: "calling_rep",
      token: authorization.token, correlationId: "phone-lease-start" });

    expect(() => service.issueCallAuthorization({ tenantId, actorUserId, actorRole: "calling_rep",
      leadId: duplicate.leadId, canManage: false, action: "reveal_and_hand_dial",
      correlationId: "duplicate-phone-authorization" })).toThrow(/BLOCKED_TENANT_POLICY/);
    const duplicateDecision = store.getDecision(tenantId, store.getCallingCandidate(tenantId, duplicate.leadId)!.lastDecisionId!);
    expect(duplicateDecision?.reasonCodes).toContain("PREVIOUS_DISPOSITION_BLOCKS_CALL");

    const stopped = store.createInternalOptOut({ tenantId, leadId: duplicate.leadId, phoneId: duplicate.phoneId,
      actorUserId, reason: "stop_request", channel: "other_device", sourceRef: "cross-device-stop",
      correlationId: "cross-device-stop" });
    expect(stopped).toMatchObject({ alreadySuppressed: false, terminatedAttemptCount: 1 });
    expect(rawDb.prepare(`SELECT disposition_code AS dispositionCode,ended_at AS endedAt
      FROM call_attempts WHERE tenant_id=? AND id=?`).get(tenantId, attempt.attemptId))
      .toMatchObject({ dispositionCode: "DO_NOT_CALL", endedAt: NOW.toISOString() });
    const systemDisposition = rawDb.prepare(`SELECT code,effect_json AS effectJson FROM call_dispositions
      WHERE tenant_id=? AND attempt_id=?`).get(tenantId, attempt.attemptId) as { code: string; effectJson: string };
    expect(systemDisposition.code).toBe("DO_NOT_CALL");
    expect(JSON.parse(systemDisposition.effectJson)).toMatchObject({ stage: "SUPPRESSED", systemTerminated: true });
  });

  it("places a tenant-scoped representative hold, invalidates auth, ends open attempts, and audits release", () => {
    const activeLead = seedCallableLead("300 Representative Hold St", "3365555656", "rep-hold-active");
    const pendingLead = seedCallableLead("302 Representative Hold St", "3365555757", "rep-hold-pending");
    const activeAuthorization = service.issueCallAuthorization({ tenantId, actorUserId, actorRole: "calling_rep",
      leadId: activeLead.leadId, canManage: false, action: "reveal_and_hand_dial",
      correlationId: "rep-hold-active-auth" });
    const activeAttempt = service.startManualAttempt({ tenantId, actorUserId, actorRole: "calling_rep",
      token: activeAuthorization.token, correlationId: "rep-hold-active-start" });
    const pendingAuthorization = service.issueCallAuthorization({ tenantId, actorUserId, actorRole: "calling_rep",
      leadId: pendingLead.leadId, canManage: false, action: "reveal_and_hand_dial",
      correlationId: "rep-hold-pending-auth" });

    const placed = store.placeRepresentativeCallingHold({ tenantId, representativeUserId: actorUserId,
      actorUserId: managerUserId, reason: "Compliance investigation pending supervisor review",
      correlationId: "rep-hold-place" });
    expect(placed).toMatchObject({ changed: true, terminatedAttemptCount: 1 });
    expect(placed.invalidatedAuthorizations).toBeGreaterThanOrEqual(1);
    expect(store.getActiveRepresentativeCallingHold(tenantId, actorUserId)?.reason)
      .toBe("Compliance investigation pending supervisor review");
    expect(store.getActiveRepresentativeCallingHold(otherTenantId, actorUserId)).toBeNull();
    expect(rawDb.prepare(`SELECT ended_at AS endedAt,disposition_code AS dispositionCode
      FROM call_attempts WHERE tenant_id=? AND id=?`).get(tenantId, activeAttempt.attemptId))
      .toEqual({ endedAt: NOW.toISOString(), dispositionCode: "REPRESENTATIVE_HOLD" });
    expect(rawDb.prepare(`SELECT stage,last_decision_id AS lastDecisionId FROM calling_queue_entries
      WHERE tenant_id=? AND lead_id=?`).get(tenantId, activeLead.leadId))
      .toEqual({ stage: "COMPLIANCE_REVIEW", lastDecisionId: null });
    expect(() => service.startManualAttempt({ tenantId, actorUserId, actorRole: "calling_rep",
      token: pendingAuthorization.token, correlationId: "rep-hold-stale-auth" }))
      .toThrow(/Representative calling hold is active/);
    const heldEvaluation = service.evaluateLeadCompliance({ tenantId, actorUserId, actorRole: "calling_rep",
      leadId: pendingLead.leadId, canManage: false, correlationId: "rep-hold-evaluate" });
    expect(heldEvaluation.evaluation).toMatchObject({ eligible: false, decision: "BLOCKED_REPRESENTATIVE_HOLD" });
    expect(heldEvaluation.evaluation.reasonCodes).toContain("REPRESENTATIVE_CALLING_HOLD_ACTIVE");
    expect(() => service.issueCallAuthorization({ tenantId, actorUserId, actorRole: "calling_rep",
      leadId: pendingLead.leadId, canManage: false, action: "reveal_and_hand_dial",
      correlationId: "rep-hold-new-auth" })).toThrow(/BLOCKED_REPRESENTATIVE_HOLD/);

    const otherRepId = Number(rawDb.prepare(`INSERT INTO users
      (name,email,role,active,tenant_id,created_at) VALUES ('Other Calling Rep','other-rep@example.test','calling_rep',1,?,?)`)
      .run(otherTenantId, NOW.toISOString()).lastInsertRowid);
    expect(() => store.placeRepresentativeCallingHold({ tenantId, representativeUserId: otherRepId,
      actorUserId: managerUserId, reason: "Cross tenant hold must be rejected", correlationId: "cross-tenant-hold" }))
      .toThrow(/not found in this organization/);

    const released = store.releaseRepresentativeCallingHold({ tenantId, representativeUserId: actorUserId,
      actorUserId: managerUserId, reason: "Investigation completed and supervisor approved release",
      correlationId: "rep-hold-release" });
    expect(released).toMatchObject({ releasedBy: managerUserId,
      releaseReason: "Investigation completed and supervisor approved release", releasedAt: NOW.toISOString() });
    expect(store.getActiveRepresentativeCallingHold(tenantId, actorUserId)).toBeNull();
    expect(rawDb.prepare(`SELECT event_type AS eventType FROM calling_audit_events
      WHERE tenant_id=? AND entity_type='representative' AND entity_id=? ORDER BY rowid`)
      .all(tenantId, String(actorUserId))).toEqual([
        { eventType: "calling.representative_hold_placed" },
        { eventType: "calling.representative_hold_released" },
      ]);
    expect(() => rawDb.prepare("DELETE FROM calling_representative_holds WHERE id=?").run(released.id))
      .toThrow(/calling_representative_holds_are_immutable/);

    const releasedAuthorization = service.issueCallAuthorization({ tenantId, actorUserId, actorRole: "calling_rep",
      leadId: pendingLead.leadId, canManage: false, action: "reveal_and_hand_dial",
      correlationId: "rep-hold-released-auth" });
    expect(releasedAuthorization.decisionId).toBeTruthy();
  });
});
