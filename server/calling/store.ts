import crypto from "node:crypto";
import { rawDb } from "../db";
import { can } from "@shared/capabilities";
import {
  decryptSensitive,
  encryptSensitive,
  hashPhone,
  hashPlatformPhone,
  sha256,
  verifyDncImportManifest,
  type DncImportManifest,
} from "./crypto";
import { maskPhone, normalizeUsPhone, type ComplianceEvaluation } from "@shared/calling";

export type CallingProfile = {
  tenantId: number;
  callingEnabled: boolean;
  emergencyDisabled: boolean;
  counselApproved: boolean;
  sellerAuthorized: boolean;
  sellerName: string | null;
  sellerAuthorizationRef: string | null;
  stateRulesApproved: boolean;
  defaultTimeZone: string;
  allowedStartLocal: string;
  allowedEndLocal: string;
  minimumIdentityConfidence: number;
  maxAttempts7Days: number;
  maxAttempts30Days: number;
  dncMaxAgeDays: number;
  allowNationalDncConsentOverride: boolean;
  allowStateDncConsentOverride: boolean;
  propagateOptOutPlatformWide: boolean;
  callerIdAuthorized: boolean;
  callerIdReference: string | null;
  policyVersion: number;
};

export type CallingCandidate = {
  queueId: string;
  tenantId: number;
  leadId: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  freshConfirmedAt: string | null;
  freshConfidence: string | null;
  sourceScanTargetId: number | null;
  /** This lead has skip-traced numbers. It may have reached the queue through
   *  the trace rather than the fiber pipeline — see calling/tracedPhones.ts. */
  traced: boolean;
  leadStatus: string;
  queueStage: string;
  queueClosedAt: string | null;
  priority: number;
  assignedUserId: number | null;
  contactId: number | null;
  contactStatus: string | null;
  contactName: string | null;
  residentStatus: string | null;
  associationExpiresAt: string | null;
  phoneId: number | null;
  phoneHash: string | null;
  maskedPhone: string | null;
  phoneValidationStatus: string | null;
  phoneLastVerifiedAt: string | null;
  phoneVerificationExpiresAt: string | null;
  lineType: string | null;
  reassignedRisk: boolean;
  identityConfidence: number;
  wrongParty: boolean;
  providerConfigId: string | null;
  providerName: string | null;
  providerEnabled: boolean;
  providerPermittedUseApproved: boolean;
  providerUseExplicit: boolean;
  providerContractStatus: string | null;
  providerContractRef: string | null;
  validationProviderConfigId: string | null;
  validationProviderEnabled: boolean;
  validationProviderPermittedUseApproved: boolean;
  validationProviderUseExplicit: boolean;
  validationProviderContractStatus: string | null;
  validationProviderContractRef: string | null;
  lastDecisionId: string | null;
  lastDecisionStatus: string | null;
  lastDecisionExpiresAt: string | null;
};

export type RepresentativeCallingHold = {
  id: string;
  tenantId: number;
  representativeUserId: number;
  representativeName: string;
  representativeEmail: string;
  representativeRole: string;
  representativeActive: boolean;
  reason: string;
  placedBy: number;
  placedAt: string;
  releasedBy: number | null;
  releaseReason: string | null;
  releasedAt: string | null;
};

function bool(value: unknown): boolean { return Number(value) === 1; }

export function ensureCallingProfile(tenantId: number): CallingProfile {
  rawDb.prepare("INSERT OR IGNORE INTO organization_compliance_profiles(tenant_id) VALUES (?)").run(tenantId);
  const row = rawDb.prepare(`SELECT tenant_id AS tenantId,calling_enabled AS callingEnabled,
    emergency_disabled AS emergencyDisabled,counsel_approved AS counselApproved,
    seller_authorized AS sellerAuthorized,seller_name AS sellerName,
    seller_authorization_ref AS sellerAuthorizationRef,state_rules_approved AS stateRulesApproved,
    default_time_zone AS defaultTimeZone,allowed_start_local AS allowedStartLocal,
    allowed_end_local AS allowedEndLocal,minimum_identity_confidence AS minimumIdentityConfidence,
    max_attempts_7_days AS maxAttempts7Days,max_attempts_30_days AS maxAttempts30Days,
    dnc_max_age_days AS dncMaxAgeDays,
    allow_national_dnc_consent_override AS allowNationalDncConsentOverride,
    allow_state_dnc_consent_override AS allowStateDncConsentOverride,
    propagate_opt_out_platform_wide AS propagateOptOutPlatformWide,
    caller_id_authorized AS callerIdAuthorized,caller_id_reference AS callerIdReference,
    policy_version AS policyVersion FROM organization_compliance_profiles WHERE tenant_id=?`).get(tenantId) as any;
  if (!row) throw new Error("Calling profile could not be initialized");
  return {
    ...row,
    callingEnabled: bool(row.callingEnabled), emergencyDisabled: bool(row.emergencyDisabled),
    counselApproved: bool(row.counselApproved), sellerAuthorized: bool(row.sellerAuthorized),
    stateRulesApproved: bool(row.stateRulesApproved),
    allowNationalDncConsentOverride: bool(row.allowNationalDncConsentOverride),
    allowStateDncConsentOverride: bool(row.allowStateDncConsentOverride),
    propagateOptOutPlatformWide: bool(row.propagateOptOutPlatformWide),
    callerIdAuthorized: bool(row.callerIdAuthorized),
  };
}

export function updateCallingProfile(tenantId: number, actorUserId: number, input: {
  callingEnabled: boolean;
  emergencyDisabled: boolean;
  counselApproved: boolean;
  sellerAuthorized: boolean;
  sellerName: string;
  sellerAuthorizationRef: string;
  stateRulesApproved: boolean;
  defaultTimeZone: string;
  allowedStartLocal: string;
  allowedEndLocal: string;
  minimumIdentityConfidence: number;
  maxAttempts7Days: number;
  maxAttempts30Days: number;
  dncMaxAgeDays: number;
  propagateOptOutPlatformWide?: boolean;
  callerIdAuthorized: boolean;
  callerIdReference: string;
}): CallingProfile {
  ensureCallingProfile(tenantId);
  rawDb.prepare(`UPDATE organization_compliance_profiles SET calling_enabled=?,emergency_disabled=?,
    counsel_approved=?,seller_authorized=?,seller_name=?,seller_authorization_ref=?,state_rules_approved=?,
    default_time_zone=?,allowed_start_local=?,allowed_end_local=?,minimum_identity_confidence=?,
    max_attempts_7_days=?,max_attempts_30_days=?,dnc_max_age_days=?,propagate_opt_out_platform_wide=?,caller_id_authorized=?,caller_id_reference=?,
    policy_version=policy_version+1,updated_by=?,updated_at=datetime('now') WHERE tenant_id=?`).run(
      input.callingEnabled ? 1 : 0, input.emergencyDisabled ? 1 : 0, input.counselApproved ? 1 : 0,
      input.sellerAuthorized ? 1 : 0, input.sellerName, input.sellerAuthorizationRef,
      input.stateRulesApproved ? 1 : 0, input.defaultTimeZone, input.allowedStartLocal, input.allowedEndLocal,
      input.minimumIdentityConfidence, input.maxAttempts7Days, input.maxAttempts30Days, input.dncMaxAgeDays,
      input.propagateOptOutPlatformWide === true ? 1 : 0, input.callerIdAuthorized ? 1 : 0, input.callerIdReference, actorUserId, tenantId,
    );
  return ensureCallingProfile(tenantId);
}

function representativeHold(row: any): RepresentativeCallingHold {
  return {
    ...row,
    tenantId: Number(row.tenantId),
    representativeUserId: Number(row.representativeUserId),
    representativeActive: bool(row.representativeActive),
    placedBy: Number(row.placedBy),
    releasedBy: row.releasedBy == null ? null : Number(row.releasedBy),
  };
}

export function getActiveRepresentativeCallingHold(
  tenantId: number,
  representativeUserId: number,
): RepresentativeCallingHold | null {
  const row = rawDb.prepare(`SELECT h.id,h.tenant_id AS tenantId,
    h.representative_user_id AS representativeUserId,u.name AS representativeName,
    u.email AS representativeEmail,u.role AS representativeRole,u.active AS representativeActive,
    h.reason,h.placed_by AS placedBy,h.placed_at AS placedAt,h.released_by AS releasedBy,
    h.release_reason AS releaseReason,h.released_at AS releasedAt
    FROM calling_representative_holds h
    JOIN users u ON u.tenant_id=h.tenant_id AND u.id=h.representative_user_id
    WHERE h.tenant_id=? AND h.representative_user_id=? AND h.released_at IS NULL
    ORDER BY h.placed_at DESC LIMIT 1`).get(tenantId, representativeUserId) as any;
  return row ? representativeHold(row) : null;
}

export function assertRepresentativeCallingNotHeld(tenantId: number, representativeUserId: number): void {
  if (getActiveRepresentativeCallingHold(tenantId, representativeUserId)) {
    throw Object.assign(new Error("Representative calling hold is active"), {
      status: 409,
      code: "REPRESENTATIVE_CALLING_HOLD_ACTIVE",
    });
  }
}

export function listRepresentativeCallingHolds(tenantId: number): RepresentativeCallingHold[] {
  const rows = rawDb.prepare(`SELECT h.id,h.tenant_id AS tenantId,
    h.representative_user_id AS representativeUserId,u.name AS representativeName,
    u.email AS representativeEmail,u.role AS representativeRole,u.active AS representativeActive,
    h.reason,h.placed_by AS placedBy,h.placed_at AS placedAt,h.released_by AS releasedBy,
    h.release_reason AS releaseReason,h.released_at AS releasedAt
    FROM calling_representative_holds h
    JOIN users u ON u.tenant_id=h.tenant_id AND u.id=h.representative_user_id
    WHERE h.tenant_id=? ORDER BY (h.released_at IS NULL) DESC,h.placed_at DESC`).all(tenantId) as any[];
  return rows.map(representativeHold);
}

export function listCallingRepresentatives(tenantId: number): Array<{
  id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  hold: RepresentativeCallingHold | null;
}> {
  const rows = rawDb.prepare(`SELECT id,name,email,role,active FROM users
    WHERE tenant_id=? ORDER BY active DESC,lower(name),id`).all(tenantId) as any[];
  return rows.filter((row) => can(String(row.role), "calling.attempt.manual")).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    email: String(row.email),
    role: String(row.role),
    active: bool(row.active),
    hold: getActiveRepresentativeCallingHold(tenantId, Number(row.id)),
  }));
}

export function placeRepresentativeCallingHold(input: {
  tenantId: number;
  representativeUserId: number;
  actorUserId: number;
  reason: string;
  correlationId: string;
}): {
  hold: RepresentativeCallingHold;
  changed: boolean;
  invalidatedAuthorizations: number;
  terminatedAttemptCount: number;
  clearedQueueEntries: number;
} {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 1_000) {
    throw Object.assign(new Error("A representative hold reason between 3 and 1000 characters is required"), { status: 400 });
  }
  let changed = false;
  let invalidatedAuthorizations = 0;
  let terminatedAttemptCount = 0;
  let clearedQueueEntries = 0;
  let holdId = "";
  rawDb.transaction(() => {
    const representative = rawDb.prepare(`SELECT id,role,active FROM users
      WHERE tenant_id=? AND id=?`).get(input.tenantId, input.representativeUserId) as any;
    if (!representative || !bool(representative.active) || !can(String(representative.role), "calling.attempt.manual")) {
      throw Object.assign(new Error("Active calling representative not found in this organization"), { status: 404 });
    }
    const existing = getActiveRepresentativeCallingHold(input.tenantId, input.representativeUserId);
    if (existing) {
      holdId = existing.id;
      return;
    }
    changed = true;
    holdId = crypto.randomUUID();
    const placedAt = new Date().toISOString();
    rawDb.prepare(`INSERT INTO calling_representative_holds
      (id,tenant_id,representative_user_id,reason,placed_by,placed_at)
      VALUES (?,?,?,?,?,?)`).run(holdId, input.tenantId, input.representativeUserId, reason,
        input.actorUserId, placedAt);
    invalidatedAuthorizations = rawDb.prepare(`UPDATE call_authorizations
      SET invalidated_at=?,invalidation_reason='REPRESENTATIVE_HOLD'
      WHERE tenant_id=? AND user_id=? AND used_at IS NULL AND invalidated_at IS NULL`)
      .run(placedAt, input.tenantId, input.representativeUserId).changes;

    const openAttempts = rawDb.prepare(`SELECT id,lead_id AS leadId FROM call_attempts
      WHERE tenant_id=? AND representative_user_id=? AND ended_at IS NULL ORDER BY started_at,id`)
      .all(input.tenantId, input.representativeUserId) as Array<{ id: string; leadId: number }>;
    const insertDisposition = rawDb.prepare(`INSERT OR IGNORE INTO call_dispositions
      (id,tenant_id,attempt_id,code,notes,effect_json,idempotency_key,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const endAttempt = rawDb.prepare(`UPDATE call_attempts SET ended_at=?,disposition_code='REPRESENTATIVE_HOLD',
      notes='Terminated by representative compliance hold' WHERE tenant_id=? AND id=? AND ended_at IS NULL`);
    const holdEffect = JSON.stringify({ stage: "COMPLIANCE_REVIEW", suppressed: false,
      callbackCreated: false, opportunityCreated: false, automaticNextCall: false,
      systemTerminated: true, representativeHoldId: holdId });
    for (const attempt of openAttempts) {
      insertDisposition.run(crypto.randomUUID(), input.tenantId, attempt.id, "REPRESENTATIVE_HOLD",
        "Attempt terminated by an administrative representative hold", holdEffect,
        `representative-hold:${holdId}:${attempt.id}`, input.actorUserId, placedAt);
      terminatedAttemptCount += endAttempt.run(placedAt, input.tenantId, attempt.id).changes;
    }
    clearedQueueEntries = rawDb.prepare(`UPDATE calling_queue_entries
      SET stage='COMPLIANCE_REVIEW',last_decision_id=NULL,lease_owner_user_id=NULL,lease_expires_at=NULL,
        version=version+1,updated_at=?
      WHERE tenant_id=? AND (assigned_user_id=? OR lease_owner_user_id=?) AND closed_at IS NULL`)
      .run(placedAt, input.tenantId, input.representativeUserId, input.representativeUserId).changes;
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId,
      eventType: "calling.representative_hold_placed", entityType: "representative",
      entityId: String(input.representativeUserId), actorUserId: input.actorUserId,
      metadata: { representativeUserId: input.representativeUserId, holdId, reason,
        invalidatedAuthorizations, terminatedAttemptCount, clearedQueueEntries } });
  }).immediate();
  const hold = getActiveRepresentativeCallingHold(input.tenantId, input.representativeUserId);
  if (!hold || hold.id !== holdId) throw new Error("Representative calling hold could not be verified");
  return { hold, changed, invalidatedAuthorizations, terminatedAttemptCount, clearedQueueEntries };
}

export function releaseRepresentativeCallingHold(input: {
  tenantId: number;
  representativeUserId: number;
  actorUserId: number;
  reason: string;
  correlationId: string;
}): RepresentativeCallingHold {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 1_000) {
    throw Object.assign(new Error("A representative hold release reason between 3 and 1000 characters is required"), { status: 400 });
  }
  let releasedId = "";
  rawDb.transaction(() => {
    const hold = getActiveRepresentativeCallingHold(input.tenantId, input.representativeUserId);
    if (!hold) throw Object.assign(new Error("Active representative calling hold not found"), { status: 404 });
    releasedId = hold.id;
    const releasedAt = new Date().toISOString();
    const result = rawDb.prepare(`UPDATE calling_representative_holds
      SET released_by=?,release_reason=?,released_at=?
      WHERE tenant_id=? AND id=? AND representative_user_id=? AND released_at IS NULL`)
      .run(input.actorUserId, reason, releasedAt, input.tenantId, hold.id, input.representativeUserId);
    if (result.changes !== 1) throw new Error("Representative calling hold release conflicted");
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId,
      eventType: "calling.representative_hold_released", entityType: "representative",
      entityId: String(input.representativeUserId), actorUserId: input.actorUserId,
      metadata: { representativeUserId: input.representativeUserId, holdId: hold.id, reason,
        requiresFreshComplianceEvaluation: true } });
  }).immediate();
  const row = rawDb.prepare(`SELECT h.id,h.tenant_id AS tenantId,
    h.representative_user_id AS representativeUserId,u.name AS representativeName,
    u.email AS representativeEmail,u.role AS representativeRole,u.active AS representativeActive,
    h.reason,h.placed_by AS placedBy,h.placed_at AS placedAt,h.released_by AS releasedBy,
    h.release_reason AS releaseReason,h.released_at AS releasedAt
    FROM calling_representative_holds h JOIN users u ON u.tenant_id=h.tenant_id AND u.id=h.representative_user_id
    WHERE h.tenant_id=? AND h.id=?`).get(input.tenantId, releasedId) as any;
  if (!row?.releasedAt) throw new Error("Released representative calling hold could not be verified");
  return representativeHold(row);
}

// Per-tenant debounce: this INSERT-OR-IGNORE-SELECT walks every confirmed-fresh
// lead AND takes the SQLite write lock even when nothing changed, yet it used
// to run on EVERY queue read (listCallingQueue + getCallingCandidate — the
// enrichment flow calls the latter up to five times per lead). The projector
// already syncs with force=true the moment a lead publishes, so per-read
// syncing is redundant belt-and-suspenders; the 30s window only bounds how
// long a NON-projector eligibility change (e.g. a lead_status revert) can
// stay unenrolled. force=true is for the writers of record — the projector's
// post-publish call and the queue route's explicit refresh (which reports the
// count to the operator and must not silently say 0).
const lastFreshFiberSync = new Map<number, { at: number; changes: number }>();
const FRESH_FIBER_SYNC_DEBOUNCE_MS = 30_000;

export function syncFreshFiberQueue(tenantId: number, force = false): number {
  const now = Date.now();
  const last = lastFreshFiberSync.get(tenantId);
  if (!force && last && now - last.at >= 0 && now - last.at < FRESH_FIBER_SYNC_DEBOUNCE_MS) {
    // Debounced read: report the LAST real sync's count rather than a silent 0
    // — the queue route surfaces this number to the operator, and "0" would
    // read as "the sync brought in nothing" when it actually brought in
    // `last.changes` moments ago. This is what lets the queue page's several
    // parallel reads (list + chips + traced + callbacks) share ONE full
    // INSERT..SELECT scan per 30s window instead of forcing one each.
    return last.changes;
  }
  const result = rawDb.prepare(`INSERT OR IGNORE INTO calling_queue_entries
    (id,tenant_id,lead_id,stage,priority,created_at,updated_at)
    SELECT lower(hex(randomblob(16))),l.tenant_id,l.id,'FRESH_FIBER_DETECTED',
      min(100,coalesce(l.lead_score,0)+CASE WHEN l.fresh_confidence='cross_verified' THEN 20 ELSE 0 END),
      datetime('now'),datetime('now')
    FROM leads l
    WHERE l.tenant_id=? AND l.fresh_confidence IN ${process.env.CALLING_SIMPLE_MODE !== "off" ? "('cross_verified','provisional')" : "('cross_verified')"}
      AND l.source_scan_target_id IS NOT NULL AND l.fresh_confirmed_at IS NOT NULL
      AND lower(coalesce(l.lead_status,'prospect')) NOT IN ('sold','not_interested')`).run(tenantId);
  lastFreshFiberSync.set(tenantId, { at: now, changes: result.changes });
  return result.changes;
}

const CANDIDATE_SELECT = `SELECT q.id AS queueId,q.tenant_id AS tenantId,q.lead_id AS leadId,
  l.address,l.city,l.state,l.zip,l.fresh_confirmed_at AS freshConfirmedAt,l.fresh_confidence AS freshConfidence,
  l.source_scan_target_id AS sourceScanTargetId,lower(coalesce(l.lead_status,'prospect')) AS leadStatus,
  q.stage AS queueStage,q.closed_at AS queueClosedAt,q.priority,q.assigned_user_id AS assignedUserId,
  c.id AS contactId,c.status AS contactStatus,c.display_name AS contactName,a.resident_status AS residentStatus,
  p.id AS phoneId,p.phone_hash AS phoneHash,p.masked_display AS maskedPhone,
  p.validation_status AS phoneValidationStatus,p.last_verified_at AS phoneLastVerifiedAt,
  p.verification_expires_at AS phoneVerificationExpiresAt,p.line_type AS lineType,p.reassigned_risk AS reassignedRisk,
  coalesce(a.identity_confidence,0) AS identityConfidence,coalesce(a.wrong_party,0) AS wrongParty,
  a.expires_at AS associationExpiresAt,a.provider_config_id AS providerConfigId,pc.provider_name AS providerName,
  coalesce(EXISTS(SELECT 1 FROM lead_traced_phones t WHERE t.lead_id=q.lead_id
    AND (t.tenant_id IS NULL OR t.tenant_id=q.tenant_id)),0) AS traced,
  coalesce(pc.enabled,0) AS providerEnabled,
  coalesce(pc.permitted_use_approved,0) AS providerPermittedUseApproved,
  coalesce(EXISTS(SELECT 1 FROM json_each(pc.permitted_uses_json) WHERE value='telemarketing_contact_enrichment'),0) AS providerUseExplicit,
  pc.contract_status AS providerContractStatus,pc.contract_reference AS providerContractRef,
  v.provider_config_id AS validationProviderConfigId,coalesce(vp.enabled,0) AS validationProviderEnabled,
  coalesce(vp.permitted_use_approved,0) AS validationProviderPermittedUseApproved,
  coalesce(EXISTS(SELECT 1 FROM json_each(vp.permitted_uses_json) WHERE value='phone_validation'),0) AS validationProviderUseExplicit,
  vp.contract_status AS validationProviderContractStatus,vp.contract_reference AS validationProviderContractRef,
  d.id AS lastDecisionId,d.final_status AS lastDecisionStatus,d.expires_at AS lastDecisionExpiresAt
  FROM calling_queue_entries q JOIN leads l ON l.id=q.lead_id AND l.tenant_id=q.tenant_id
  LEFT JOIN contacts c ON c.id=q.contact_id AND c.tenant_id=q.tenant_id
  LEFT JOIN phone_numbers p ON p.id=q.phone_id AND p.tenant_id=q.tenant_id
  LEFT JOIN phone_address_associations a ON a.tenant_id=q.tenant_id AND a.lead_id=q.lead_id AND a.phone_id=q.phone_id
  LEFT JOIN contact_enrichment_providers pc ON pc.id=a.provider_config_id AND pc.tenant_id=q.tenant_id
  LEFT JOIN phone_validations v ON v.id=(SELECT pv.id FROM phone_validations pv
    WHERE pv.tenant_id=q.tenant_id AND pv.phone_id=q.phone_id ORDER BY pv.checked_at DESC,pv.created_at DESC LIMIT 1)
  LEFT JOIN contact_enrichment_providers vp ON vp.id=v.provider_config_id AND vp.tenant_id=q.tenant_id
  LEFT JOIN compliance_decisions d ON d.id=q.last_decision_id AND d.tenant_id=q.tenant_id`;

function candidate(row: any): CallingCandidate {
  return {
    ...row,
    traced: bool(row.traced),
    reassignedRisk: bool(row.reassignedRisk), wrongParty: bool(row.wrongParty),
    providerEnabled: bool(row.providerEnabled), providerPermittedUseApproved: bool(row.providerPermittedUseApproved),
    providerUseExplicit: bool(row.providerUseExplicit), validationProviderEnabled: bool(row.validationProviderEnabled),
    validationProviderPermittedUseApproved: bool(row.validationProviderPermittedUseApproved),
    validationProviderUseExplicit: bool(row.validationProviderUseExplicit),
    identityConfidence: Number(row.identityConfidence || 0), priority: Number(row.priority || 0),
  };
}

export function listCallingQueue(tenantId: number, userId: number, canManage: boolean, stage?: string, limit = 100,
  source?: "traced" | "fiber"): CallingCandidate[] {
  syncFreshFiberQueue(tenantId);
  const conditions = ["q.tenant_id=?", "q.closed_at IS NULL"];
  const args: unknown[] = [tenantId];
  if (!canManage) { conditions.push("(q.assigned_user_id IS NULL OR q.assigned_user_id=?)"); args.push(userId); }
  if (stage) { conditions.push("q.stage=?"); args.push(stage); }
  if (source) {
    conditions.push(`${source === "traced" ? "" : "NOT "}EXISTS(SELECT 1 FROM lead_traced_phones t
      WHERE t.lead_id=q.lead_id AND (t.tenant_id IS NULL OR t.tenant_id=q.tenant_id))`);
  }
  args.push(Math.max(1, Math.min(250, limit)));
  const rows = rawDb.prepare(`${CANDIDATE_SELECT} WHERE ${conditions.join(" AND ")}
    ORDER BY CASE WHEN q.stage='CALLBACK_SCHEDULED' THEN 0 WHEN q.stage='ELIGIBLE_MANUAL_CALL' THEN 1 ELSE 2 END,
      q.priority DESC,q.created_at LIMIT ?`).all(...args) as any[];
  return rows.map(candidate);
}

export function getCallingCandidate(tenantId: number, leadId: number): CallingCandidate | null {
  syncFreshFiberQueue(tenantId);
  const row = rawDb.prepare(`${CANDIDATE_SELECT} WHERE q.tenant_id=? AND q.lead_id=?`).get(tenantId, leadId) as any;
  return row ? candidate(row) : null;
}

export function updateCallingAssignment(input: {
  tenantId: number;
  leadId: number;
  assignedUserId: number | null;
  actorUserId: number;
  correlationId: string;
}): { candidate: CallingCandidate; invalidatedAuthorizations: number; changed: boolean } {
  let changed = false;
  let invalidatedAuthorizations = 0;
  rawDb.transaction(() => {
    const current = rawDb.prepare(`SELECT assigned_user_id AS assignedUserId FROM calling_queue_entries
      WHERE tenant_id=? AND lead_id=?`).get(input.tenantId, input.leadId) as { assignedUserId: number | null } | undefined;
    if (!current) throw Object.assign(new Error("Calling lead not found"), { status: 404 });
    if (input.assignedUserId != null && !rawDb.prepare(`SELECT 1 FROM users
      WHERE id=? AND tenant_id=? AND active=1`).get(input.assignedUserId, input.tenantId)) {
      throw Object.assign(new Error("Assigned user is not an active member of this organization"), { status: 400 });
    }
    changed = current.assignedUserId !== input.assignedUserId;
    if (changed) {
      rawDb.prepare(`UPDATE calling_queue_entries SET assigned_user_id=?,version=version+1,updated_at=datetime('now')
        WHERE tenant_id=? AND lead_id=?`).run(input.assignedUserId, input.tenantId, input.leadId);
      invalidatedAuthorizations = rawDb.prepare(`UPDATE call_authorizations
        SET invalidated_at=datetime('now'),invalidation_reason='QUEUE_REASSIGNED'
        WHERE tenant_id=? AND lead_id=? AND used_at IS NULL AND invalidated_at IS NULL`)
        .run(input.tenantId, input.leadId).changes;
    }
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId,
      eventType: "calling.assignment_changed", entityType: "lead", entityId: String(input.leadId),
      actorUserId: input.actorUserId, metadata: { leadId: input.leadId,
        previousAssignedUserId: current.assignedUserId, assignedUserId: input.assignedUserId,
        changed, invalidatedAuthorizations } });
  }).immediate();
  const updated = getCallingCandidate(input.tenantId, input.leadId);
  if (!updated) throw new Error("Calling lead disappeared after assignment update");
  return { candidate: updated, invalidatedAuthorizations, changed };
}

export function activeScript(tenantId: number): any | null {
  return rawDb.prepare(`SELECT id,version,title,body,disclosure_sha256 AS disclosureSha256,
    seller_name AS sellerName,company_name AS companyName,purpose,approved_at AS approvedAt,
    counsel_approval_reference AS counselApprovalReference
    FROM approved_calling_scripts WHERE tenant_id=? AND active=1 AND counsel_approved=1
      AND counsel_approval_reference IS NOT NULL AND length(trim(counsel_approval_reference))>=3 LIMIT 1`).get(tenantId) as any ?? null;
}

export function activeRuleVersion(tenantId: number): any | null {
  const row = rawDb.prepare(`SELECT id,version,rules_sha256 AS rulesSha256,config_json AS configJson,approved_at AS approvedAt,
    counsel_approval_reference AS counselApprovalReference
    FROM calling_rule_versions WHERE tenant_id=? AND active=1 AND approved_at IS NOT NULL
      AND counsel_approval_reference IS NOT NULL AND length(trim(counsel_approval_reference))>=3 LIMIT 1`).get(tenantId) as any ?? null;
  if (!row) return null;
  try { return { ...row, config: JSON.parse(row.configJson) }; } catch { return null; }
}

export function activeSellerAuthorization(tenantId: number, sellerName: string | null, authorizationRef: string | null, now: string): any | null {
  if (!sellerName || !authorizationRef) return null;
  return rawDb.prepare(`SELECT id,seller_name AS sellerName,authorization_ref AS authorizationRef,evidence_sha256 AS evidenceSha256,
    effective_at AS effectiveAt,expires_at AS expiresAt FROM seller_authorizations
    WHERE tenant_id=? AND seller_name=? AND authorization_ref=? AND status='active'
      AND unixepoch(effective_at)<=unixepoch(?) AND (expires_at IS NULL OR unixepoch(expires_at)>unixepoch(?))
      ORDER BY unixepoch(effective_at) DESC LIMIT 1`)
    .get(tenantId, sellerName, authorizationRef, now, now) as any ?? null;
}

export function activeRegistration(tenantId: number, state: string, now: string): any | null {
  return rawDb.prepare(`SELECT id,legal_entity AS legalEntity,registration_type AS registrationType,registration_number AS registrationNumber,
    evidence_ref AS evidenceRef,expires_at AS expiresAt FROM state_registrations
    WHERE tenant_id=? AND state=? AND status='active' AND counsel_approved=1
      AND unixepoch(effective_at)<=unixepoch(?) AND (expires_at IS NULL OR unixepoch(expires_at)>unixepoch(?))
      ORDER BY unixepoch(effective_at) DESC LIMIT 1`)
    .get(tenantId, state, now, now) as any ?? null;
}

export function currentDncDataset(tenantId: number, sourceType: "national" | "state", state: string | null, now: string): any | null {
  const row = sourceType === "national"
    ? rawDb.prepare(`SELECT id,version_label AS versionLabel,expires_at AS expiresAt,imported_at AS importedAt,
        source_as_of AS sourceAsOf,source_retrieved_at AS sourceRetrievedAt,
        covered_area_codes_json AS coveredAreaCodesJson
        FROM dnc_dataset_versions WHERE tenant_id=? AND source_type='national' AND status='active'
        ORDER BY unixepoch(effective_at) DESC LIMIT 1`).get(tenantId)
    : rawDb.prepare(`SELECT id,version_label AS versionLabel,expires_at AS expiresAt,imported_at AS importedAt,
        source_as_of AS sourceAsOf,source_retrieved_at AS sourceRetrievedAt,
        covered_area_codes_json AS coveredAreaCodesJson
        FROM dnc_dataset_versions WHERE tenant_id=? AND source_type='state' AND state=? AND status='active'
        ORDER BY unixepoch(effective_at) DESC LIMIT 1`).get(tenantId, state);
  if (!row) return null;
  let coveredAreaCodes: string[] = [];
  try { coveredAreaCodes = JSON.parse((row as any).coveredAreaCodesJson || "[]"); } catch { /* fail closed below */ }
  // The current model intentionally accepts only a dataset explicitly marked
  // as covering the full authorized calling population. Partial area-code
  // subscriptions cannot silently produce a clean DNC verdict.
  const coverageComplete = coveredAreaCodes.includes("ALL");
  return {
    ...(row as any),
    coveredAreaCodes,
    coverageComplete,
    fresh: Date.parse((row as any).expiresAt) > Date.parse(now) && coverageComplete,
  };
}

export function dncHit(tenantId: number, datasetId: string | null, phoneHashValue: string | null): boolean {
  if (!datasetId || !phoneHashValue) return false;
  return Boolean(rawDb.prepare(`SELECT 1 FROM dnc_suppressions WHERE tenant_id=? AND dataset_version_id=? AND phone_hash=?`)
    .get(tenantId, datasetId, phoneHashValue));
}

export function internalDncHit(tenantId: number, phoneHashValue: string | null): boolean {
  return Boolean(phoneHashValue && rawDb.prepare(`SELECT 1 FROM internal_dnc_entries WHERE tenant_id=? AND phone_hash=? AND active=1`)
    .get(tenantId, phoneHashValue));
}

export function platformDncHit(tenantId: number, phoneId: number | null): boolean {
  if (!phoneId) return false;
  const row = rawDb.prepare("SELECT encrypted_e164 AS encryptedE164 FROM phone_numbers WHERE tenant_id=? AND id=?")
    .get(tenantId, phoneId) as { encryptedE164: string } | undefined;
  if (!row) return false;
  const platformHash = hashPlatformPhone(decryptSensitive(row.encryptedE164));
  return Boolean(rawDb.prepare("SELECT 1 FROM platform_dnc_entries WHERE phone_hash=?").get(platformHash));
}

export function currentConsent(
  tenantId: number,
  phoneId: number | null,
  leadId: number,
  seller: string | null,
  now: string,
): { verified: boolean; revoked: boolean; id: string | null } {
  if (!phoneId) return { verified: false, revoked: false, id: null };
  const row = rawDb.prepare(`SELECT c.id,EXISTS(SELECT 1 FROM consent_revocations r WHERE r.tenant_id=c.tenant_id AND r.consent_id=c.id) AS revoked
    FROM consent_records c WHERE c.tenant_id=? AND c.phone_id=? AND c.lead_id=? AND c.seller=?
      AND lower(c.consent_type)='express_written_telemarketing'
      AND EXISTS(SELECT 1 FROM json_each(c.channels_json) WHERE value='manual_voice_call')
      AND (c.expires_at IS NULL OR unixepoch(c.expires_at)>unixepoch(?))
    ORDER BY unixepoch(c.captured_at) DESC LIMIT 1`).get(tenantId, phoneId, leadId, seller ?? "", now) as any;
  return row ? { verified: true, revoked: bool(row.revoked), id: row.id } : { verified: false, revoked: false, id: null };
}

export function attemptCounts(tenantId: number, phoneId: number | null): { sevenDays: number; thirtyDays: number } {
  if (!phoneId) return { sevenDays: 0, thirtyDays: 0 };
  const row = rawDb.prepare(`SELECT
    sum(CASE WHEN started_at>=datetime('now','-7 days') THEN 1 ELSE 0 END) AS sevenDays,
    sum(CASE WHEN started_at>=datetime('now','-30 days') THEN 1 ELSE 0 END) AS thirtyDays
    FROM call_attempts WHERE tenant_id=? AND phone_id=?`).get(tenantId, phoneId) as any;
  return { sevenDays: Number(row?.sevenDays || 0), thirtyDays: Number(row?.thirtyDays || 0) };
}

export function previousDispositionAllowed(tenantId: number, _leadId: number, phoneId: number | null): boolean {
  if (!phoneId) return false;
  const openAttempt = rawDb.prepare(`SELECT 1 FROM call_attempts
    WHERE tenant_id=? AND phone_id=? AND ended_at IS NULL LIMIT 1`).get(tenantId, phoneId);
  if (openAttempt) return false;
  const row = rawDb.prepare(`SELECT disposition_code AS code FROM call_attempts
    WHERE tenant_id=? AND phone_id=? AND disposition_code IS NOT NULL ORDER BY started_at DESC LIMIT 1`)
    .get(tenantId, phoneId) as any;
  return !row || ![
    "DO_NOT_CALL", "WRONG_NUMBER", "WRONG_PARTY", "SALE_COMPLETED", "CONSENT_REVOKED",
    "NOT_INTERESTED", "ALREADY_HAS_SERVICE", "NOT_SERVICEABLE", "DISCONNECTED",
    "PROPERTY_OWNER_NOT_RESIDENT",
  ].includes(row.code);
}

export function persistComplianceDecision(input: {
  tenantId: number;
  candidate: CallingCandidate;
  evaluation: ComplianceEvaluation;
  actorUserId: number;
  evidence: Record<string, unknown>;
  dncDatasetRefs: string[];
  registrationRef?: string | null;
  scriptVersion?: string | null;
}): string {
  if (!input.candidate.contactId || !input.candidate.phoneId) throw new Error("Candidate has no contact phone association");
  const id = crypto.randomUUID();
  const evidenceJson = JSON.stringify(input.evidence);
  rawDb.prepare(`INSERT INTO compliance_decisions
    (id,tenant_id,lead_id,contact_id,phone_id,rule_version,final_status,eligible,reason_codes_json,
     rule_results_json,input_evidence_sha256,input_evidence_json,dnc_dataset_refs_json,provider_contract_ref,registration_ref,
     script_version,representative_user_id,local_time,time_zone,evaluated_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.tenantId, input.candidate.leadId, input.candidate.contactId, input.candidate.phoneId,
      input.evaluation.ruleVersion, input.evaluation.decision, input.evaluation.eligible ? 1 : 0,
      JSON.stringify(input.evaluation.reasonCodes), JSON.stringify(input.evaluation.rules), sha256(evidenceJson),
      evidenceJson, JSON.stringify(input.dncDatasetRefs),
      [input.candidate.providerContractRef, input.candidate.validationProviderContractRef].filter(Boolean).join("|") || null,
      input.registrationRef ?? null,
      input.scriptVersion ?? null, input.actorUserId, input.evaluation.localTime, input.evaluation.timeZone,
      input.evaluation.evaluatedAt, input.evaluation.expiresAt,
    );
  const stage = input.evaluation.eligible ? "ELIGIBLE_MANUAL_CALL"
    : input.evaluation.decision.startsWith("REVIEW") || input.evaluation.decision === "UNKNOWN" ? "COMPLIANCE_REVIEW" : "COMPLIANCE_BLOCKED";
  rawDb.prepare(`UPDATE calling_queue_entries SET last_decision_id=?,stage=?,version=version+1,updated_at=datetime('now')
    WHERE tenant_id=? AND lead_id=?`).run(id, stage, input.tenantId, input.candidate.leadId);
  return id;
}

export function getDecision(tenantId: number, decisionId: string): any | null {
  const row = rawDb.prepare(`SELECT id,lead_id AS leadId,contact_id AS contactId,phone_id AS phoneId,
    rule_version AS ruleVersion,final_status AS finalStatus,eligible,reason_codes_json AS reasonCodesJson,
    rule_results_json AS ruleResultsJson,dnc_dataset_refs_json AS dncDatasetRefsJson,
    input_evidence_sha256 AS inputEvidenceSha256,input_evidence_json AS inputEvidenceJson,
    provider_contract_ref AS providerContractRef,registration_ref AS registrationRef,script_version AS scriptVersion,
    local_time AS localTime,time_zone AS timeZone,evaluated_at AS evaluatedAt,expires_at AS expiresAt
    FROM compliance_decisions WHERE tenant_id=? AND id=?`).get(tenantId, decisionId) as any;
  return row ? { ...row, eligible: bool(row.eligible), reasonCodes: JSON.parse(row.reasonCodesJson),
    rules: JSON.parse(row.ruleResultsJson), dncDatasetRefs: JSON.parse(row.dncDatasetRefsJson),
    inputEvidence: JSON.parse(row.inputEvidenceJson), inputEvidenceJson: undefined } : null;
}

export function storeManualContact(input: {
  tenantId: number;
  leadId: number;
  phone: string;
  name?: string | null;
  relationship?: "resident" | "owner" | "unknown";
  identityConfidence: number;
  providerConfigId: string;
  providerRecordId?: string | null;
  humanVerified: boolean;
  sourceMode?: "manual_import" | "provider_api";
  associationValidDays?: number;
}): CallingCandidate {
  const normalized = normalizeUsPhone(input.phone);
  if (!normalized) throw new Error("A valid US phone number is required");
  const lead = rawDb.prepare("SELECT id FROM leads WHERE id=? AND tenant_id=?").get(input.leadId, input.tenantId);
  if (!lead) throw new Error("Lead not found");
  const provider = rawDb.prepare(`SELECT id,enabled,adapter_type AS adapterType,contract_status AS contractStatus,permitted_use_approved AS permittedUseApproved,
    contract_reference AS contractReference,retention_days AS retentionDays FROM contact_enrichment_providers
    WHERE id=? AND tenant_id=? AND adapter_type ${input.sourceMode === "provider_api"
      ? "='generic_http_v1'" : "IN ('manual_import_v1','manual_import')"}
      AND EXISTS(SELECT 1 FROM json_each(permitted_uses_json)
        WHERE value='telemarketing_contact_enrichment')`)
    .get(input.providerConfigId, input.tenantId) as any;
  if (!provider || !bool(provider.enabled) || provider.contractStatus !== "approved" || !bool(provider.permittedUseApproved) || !provider.contractReference
      || Number(provider.retentionDays) < 1 || !input.providerRecordId?.trim()) {
    throw new Error("Contact provider permitted use has not been approved");
  }
  const phoneHashValue = hashPhone(input.tenantId, normalized);
  const transaction = rawDb.transaction(() => {
    const relationship = input.relationship ?? "unknown";
    const residentStatus = relationship === "resident"
      ? "POSSIBLE_RESIDENT"
      : relationship === "owner" ? "OWNER_NOT_CONFIRMED_RESIDENT" : "VACANT_OR_UNKNOWN";
    const displayName = relationship === "owner" ? null : (input.name ?? null);
    const ownerName = relationship === "owner" ? (input.name ?? null) : null;
    const associationValidDays = Math.max(1, Math.min(30, Number(provider.retentionDays), input.associationValidDays ?? 30));
    const associationExpiresAt = new Date(Date.now() + associationValidDays * 86_400_000).toISOString();
    rawDb.prepare(`INSERT INTO contacts
      (tenant_id,lead_id,status,display_name,resident_status,owner_name,owner_status,human_verified,updated_at)
      VALUES (?,?,'POSSIBLE_MATCH',?,?,?,?,?,datetime('now'))
      ON CONFLICT(tenant_id,lead_id) DO UPDATE SET display_name=coalesce(excluded.display_name,contacts.display_name),
        resident_status=CASE WHEN contacts.resident_status IN ('POSSIBLE_RESIDENT','VERIFIED_RESIDENT')
          THEN contacts.resident_status ELSE excluded.resident_status END,
        owner_name=coalesce(excluded.owner_name,contacts.owner_name),
        owner_status=coalesce(excluded.owner_status,contacts.owner_status),
        human_verified=max(contacts.human_verified,excluded.human_verified),updated_at=datetime('now')`)
      .run(input.tenantId, input.leadId, displayName, residentStatus, ownerName,
        relationship === "owner" ? "POSSIBLE_OWNER" : null, input.humanVerified ? 1 : 0);
    const contact = rawDb.prepare("SELECT id FROM contacts WHERE tenant_id=? AND lead_id=?").get(input.tenantId, input.leadId) as any;
    rawDb.prepare(`INSERT INTO phone_numbers(tenant_id,phone_hash,encrypted_e164,masked_display,original_encrypted,validation_status)
      VALUES (?,?,?,?,?,'UNVALIDATED') ON CONFLICT(tenant_id,phone_hash) DO NOTHING`)
      .run(input.tenantId, phoneHashValue, encryptSensitive(normalized), maskPhone(normalized), encryptSensitive(input.phone));
    const phone = rawDb.prepare("SELECT id FROM phone_numbers WHERE tenant_id=? AND phone_hash=?").get(input.tenantId, phoneHashValue) as any;
    const suppressed = internalDncHit(input.tenantId, phoneHashValue);
    rawDb.prepare(`INSERT INTO phone_address_associations
      (tenant_id,contact_id,phone_id,lead_id,provider_config_id,provider_record_id,address_confidence,name_confidence,
       phone_confidence,identity_confidence,human_verified,resident_status,wrong_party,source_age_days,permitted_use_ref,expires_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(tenant_id,lead_id,phone_id) DO UPDATE SET contact_id=excluded.contact_id,
       provider_config_id=excluded.provider_config_id,provider_record_id=excluded.provider_record_id,
       address_confidence=excluded.address_confidence,name_confidence=excluded.name_confidence,
       phone_confidence=excluded.phone_confidence,identity_confidence=excluded.identity_confidence,
       human_verified=excluded.human_verified,resident_status=excluded.resident_status,
       wrong_party=max(phone_address_associations.wrong_party,excluded.wrong_party),source_age_days=0,
       permitted_use_ref=excluded.permitted_use_ref,expires_at=excluded.expires_at,updated_at=datetime('now')`).run(
        input.tenantId, contact.id, phone.id, input.leadId, input.providerConfigId, input.providerRecordId ?? null,
        input.identityConfidence, input.identityConfidence, input.identityConfidence, input.identityConfidence,
        input.humanVerified ? 1 : 0, residentStatus, 0, 0, provider.contractReference, associationExpiresAt,
      );
    rawDb.prepare(`UPDATE contacts SET status=? WHERE id=? AND tenant_id=?`)
      .run(suppressed ? "SUPPRESSED"
        : relationship !== "resident" ? "REVIEW_REQUIRED"
          : input.identityConfidence >= 0.85 ? "VERIFIED_MATCH" : "POSSIBLE_MATCH",
      contact.id, input.tenantId);
    rawDb.prepare(`UPDATE calling_queue_entries SET contact_id=?,phone_id=?,stage=?,version=version+1,updated_at=datetime('now')
      WHERE tenant_id=? AND lead_id=?`).run(contact.id, phone.id, suppressed ? "SUPPRESSED" : "AWAITING_PHONE_VALIDATION", input.tenantId, input.leadId);
  });
  transaction.immediate();
  const result = getCallingCandidate(input.tenantId, input.leadId);
  if (!result) throw new Error("Calling candidate could not be created");
  return result;
}

export function validatePhoneManually(input: {
  tenantId: number;
  leadId: number;
  phoneId: number;
  providerConfigId: string;
  lineType: string;
  reachable: boolean;
  reassignedRisk: boolean;
  evidenceRef: string;
  validDays: number;
}): void {
  const allowedLineTypes = new Set(["wireless", "landline", "voip", "fixed_voip", "non_fixed_voip", "toll_free", "unknown"]);
  if (!allowedLineTypes.has(input.lineType.toLowerCase())) throw new Error("Unsupported line type");
  if (!input.evidenceRef.trim()) throw new Error("Phone-validation evidence is required");
  if (!Number.isInteger(input.validDays) || input.validDays < 1 || input.validDays > 30) {
    throw new Error("Phone validation may be valid for 1 to 30 days");
  }
  const association = rawDb.prepare(`SELECT 1 FROM phone_address_associations WHERE tenant_id=? AND lead_id=? AND phone_id=?`)
    .get(input.tenantId, input.leadId, input.phoneId);
  if (!association) throw new Error("Phone association not found");
  const provider = rawDb.prepare(`SELECT 1 FROM contact_enrichment_providers p
    WHERE p.tenant_id=? AND p.id=? AND p.enabled=1 AND p.contract_status='approved'
      AND p.permitted_use_approved=1 AND p.contract_reference IS NOT NULL
      AND EXISTS(SELECT 1 FROM json_each(p.permitted_uses_json)
        WHERE value='phone_validation')`)
    .get(input.tenantId, input.providerConfigId);
  if (!provider) throw new Error("Phone-validation provider use is not approved");
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + input.validDays * 86_400_000).toISOString();
  rawDb.transaction(() => {
    rawDb.prepare(`INSERT INTO phone_validations
      (id,tenant_id,phone_id,provider_config_id,status,line_type,reachable,reassigned_risk,evidence_ref,checked_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), input.tenantId, input.phoneId, input.providerConfigId,
        input.reachable ? "VALID" : "INVALID", input.lineType, input.reachable ? 1 : 0, input.reassignedRisk ? 1 : 0,
        input.evidenceRef, checkedAt, expiresAt);
    rawDb.prepare(`UPDATE phone_numbers SET validation_status=?,line_type=?,reassigned_risk=?,last_verified_at=?,
      verification_expires_at=?,updated_at=datetime('now') WHERE tenant_id=? AND id=?`).run(
        input.reachable ? "VALID" : "INVALID", input.lineType, input.reassignedRisk ? 1 : 0, checkedAt, expiresAt,
        input.tenantId, input.phoneId,
      );
    rawDb.prepare(`UPDATE calling_queue_entries SET stage=?,updated_at=datetime('now'),version=version+1
      WHERE tenant_id=? AND lead_id=?`).run(input.reachable ? "AWAITING_DNC_CHECK" : "COMPLIANCE_BLOCKED", input.tenantId, input.leadId);
  })();
}

export function revealPhone(tenantId: number, phoneId: number): string {
  const row = rawDb.prepare("SELECT encrypted_e164 FROM phone_numbers WHERE tenant_id=? AND id=?").get(tenantId, phoneId) as any;
  if (!row) throw new Error("Phone not found");
  return decryptSensitive(row.encrypted_e164);
}

export function appendCallingAudit(input: {
  tenantId: number;
  correlationId: string;
  eventType: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: number | null;
  metadata?: Record<string, unknown>;
}): string {
  let id = "";
  const append = () => {
    rawDb.prepare("INSERT OR IGNORE INTO calling_audit_heads(tenant_id) VALUES (?)").run(input.tenantId);
    const head = rawDb.prepare("SELECT event_sha256 AS hash FROM calling_audit_heads WHERE tenant_id=?")
      .get(input.tenantId) as { hash: string | null } | undefined;
    // Upgrade safety: initialize a newly-added head from the existing chain.
    const previous = head?.hash ?? (rawDb.prepare(`SELECT event_sha256 AS hash FROM calling_audit_events
      WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(input.tenantId) as any)?.hash ?? null;
    id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const metadataJson = JSON.stringify(input.metadata ?? {});
    const eventHash = sha256(JSON.stringify({ id, ...input, metadata: input.metadata ?? {}, previous, createdAt }));
    rawDb.prepare(`INSERT INTO calling_audit_events
      (id,tenant_id,correlation_id,event_type,entity_type,entity_id,actor_user_id,metadata_json,previous_event_sha256,event_sha256,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.tenantId, input.correlationId, input.eventType, input.entityType,
        input.entityId ?? null, input.actorUserId ?? null, metadataJson, previous, eventHash, createdAt);
    rawDb.prepare(`UPDATE calling_audit_heads SET event_id=?,event_sha256=?,updated_at=?
      WHERE tenant_id=?`).run(id, eventHash, createdAt, input.tenantId);
  };
  if ((rawDb as any).inTransaction) append();
  else rawDb.transaction(append).immediate();
  return id;
}

export function auditTimeline(tenantId: number, leadId: number): any[] {
  return rawDb.prepare(`SELECT id,event_type AS eventType,entity_type AS entityType,entity_id AS entityId,
    actor_user_id AS actorUserId,metadata_json AS metadataJson,event_sha256 AS eventSha256,created_at AS createdAt
    FROM calling_audit_events WHERE tenant_id=? AND (
      (entity_type='lead' AND entity_id=?) OR json_extract(metadata_json,'$.leadId')=?
    ) ORDER BY created_at DESC LIMIT 200`).all(tenantId, String(leadId), leadId).map((row: any) => ({
      ...row, metadata: JSON.parse(row.metadataJson), metadataJson: undefined,
    }));
}

export function verifyCallingAuditIntegrity(): {
  tenantsChecked: number;
  eventsChecked: number;
  invalidTenants: Array<{ tenantId: number; roots: number; orphans: number; branches: number; tips: number; headMatches: boolean }>;
} {
  const tenants = rawDb.prepare("SELECT DISTINCT tenant_id AS tenantId FROM calling_audit_events ORDER BY tenant_id")
    .all() as Array<{ tenantId: number }>;
  let eventsChecked = 0;
  const invalidTenants: Array<{ tenantId: number; roots: number; orphans: number; branches: number; tips: number; headMatches: boolean }> = [];
  for (const { tenantId } of tenants) {
    const counts = rawDb.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN previous_event_sha256 IS NULL THEN 1 ELSE 0 END) AS roots
      FROM calling_audit_events WHERE tenant_id=?`).get(tenantId) as any;
    const orphans = Number((rawDb.prepare(`SELECT count(*) AS count FROM calling_audit_events e
      LEFT JOIN calling_audit_events p ON p.tenant_id=e.tenant_id AND p.event_sha256=e.previous_event_sha256
      WHERE e.tenant_id=? AND e.previous_event_sha256 IS NOT NULL AND p.id IS NULL`).get(tenantId) as any)?.count ?? 0);
    const branches = Number((rawDb.prepare(`SELECT count(*) AS count FROM (
      SELECT previous_event_sha256 FROM calling_audit_events WHERE tenant_id=? AND previous_event_sha256 IS NOT NULL
      GROUP BY previous_event_sha256 HAVING count(*)>1)`).get(tenantId) as any)?.count ?? 0);
    const tips = rawDb.prepare(`SELECT e.id,e.event_sha256 AS eventHash FROM calling_audit_events e
      WHERE e.tenant_id=? AND NOT EXISTS(SELECT 1 FROM calling_audit_events child
        WHERE child.tenant_id=e.tenant_id AND child.previous_event_sha256=e.event_sha256)`).all(tenantId) as Array<{ id: string; eventHash: string }>;
    const head = rawDb.prepare("SELECT event_id AS eventId,event_sha256 AS eventHash FROM calling_audit_heads WHERE tenant_id=?")
      .get(tenantId) as { eventId: string | null; eventHash: string | null } | undefined;
    const total = Number(counts?.total ?? 0);
    const roots = Number(counts?.roots ?? 0);
    eventsChecked += total;
    const headMatches = tips.length === 1 && head?.eventId === tips[0].id && head?.eventHash === tips[0].eventHash;
    if (roots !== 1 || orphans !== 0 || branches !== 0 || tips.length !== 1 || !headMatches) {
      invalidTenants.push({ tenantId, roots, orphans, branches, tips: tips.length, headMatches });
    }
  }
  return { tenantsChecked: tenants.length, eventsChecked, invalidTenants };
}

export function beginDncImport(input: DncImportManifest & {
  manifestSignature: string;
  actorUserId: number;
}): { importId: string; status: "pending" | "finalized"; replayed: boolean; finalized?: {
  datasetId: string; recordCount: number; checksum: string; expiresAt: string;
} } {
  if (!verifyDncImportManifest(input, input.manifestSignature)) {
    throw new Error("DNC import manifest signature is invalid or the signing key is unavailable");
  }
  if (input.sourceType === "state" && !input.state) throw new Error("State DNC imports require a state");
  if (input.sourceType === "national" && input.state) throw new Error("National DNC imports must not specify a state");
  if (!input.coveredAreaCodes.includes("ALL")) {
    throw new Error("Signed DNC imports must attest complete authorized coverage with ALL");
  }
  const now = Date.now();
  const sourceAsOf = Date.parse(input.sourceAsOf);
  const retrievedAt = Date.parse(input.sourceRetrievedAt);
  const maximumAgeMs = Math.min(31, Math.max(1, input.maxAgeDays)) * 86_400_000;
  if (!Number.isFinite(sourceAsOf) || !Number.isFinite(retrievedAt)
      || sourceAsOf > now + 5 * 60_000 || retrievedAt > now + 5 * 60_000
      || retrievedAt < sourceAsOf || now - sourceAsOf > maximumAgeMs) {
    throw new Error("DNC source dates are invalid, future-dated, or already stale");
  }
  const signatureHash = sha256(input.manifestSignature.toLowerCase());
  const start = () => {
    const existing = rawDb.prepare(`SELECT id,status,dataset_version_id AS datasetId FROM dnc_import_jobs
      WHERE tenant_id=? AND manifest_signature_sha256=? AND status IN ('pending','finalized') LIMIT 1`)
      .get(input.tenantId, signatureHash) as { id: string; status: "pending" | "finalized"; datasetId: string | null } | undefined;
    if (existing) {
      const finalized = existing.status === "finalized" && existing.datasetId
        ? rawDb.prepare(`SELECT id AS datasetId,record_count AS recordCount,checksum_sha256 AS checksum,
            expires_at AS expiresAt FROM dnc_dataset_versions WHERE tenant_id=? AND id=?`)
          .get(input.tenantId, existing.datasetId) as any
        : undefined;
      return { importId: existing.id, status: existing.status, replayed: true,
        ...(finalized ? { finalized: { ...finalized, recordCount: Number(finalized.recordCount) } } : {}) };
    }
    const importId = crypto.randomUUID();
    rawDb.prepare(`INSERT INTO dnc_import_jobs
      (id,tenant_id,source_type,state,version_label,authorized_account_ref,covered_area_codes_json,
       expected_record_count,expected_chunk_count,source_manifest_sha256,manifest_signature_sha256,
       chunk_size,source_as_of,source_retrieved_at,max_age_days,status,imported_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(importId, input.tenantId, input.sourceType,
        input.state, input.versionLabel, input.authorizedAccountRef, JSON.stringify([...new Set(input.coveredAreaCodes)].sort()),
        input.expectedRecordCount, input.expectedChunkCount, input.sourceManifestSha256.toLowerCase(),
        signatureHash, input.chunkSize, input.sourceAsOf, input.sourceRetrievedAt,
        input.maxAgeDays, input.actorUserId);
    return { importId, status: "pending" as const, replayed: false };
  };
  return ((rawDb as any).inTransaction ? start() : rawDb.transaction(start).immediate()) as ReturnType<typeof start>;
}

export function appendDncImportChunk(input: {
  tenantId: number;
  importId: string;
  chunkIndex: number;
  phones: string[];
}): { replayed: boolean; accepted: number; rejected: number; stagedUnique: number; sourceChunkSha256: string } {
  const job = rawDb.prepare(`SELECT status,expected_chunk_count AS expectedChunkCount,chunk_size AS chunkSize FROM dnc_import_jobs
    WHERE tenant_id=? AND id=?`).get(input.tenantId, input.importId) as any;
  if (!job) throw new Error("DNC import job not found");
  if (job.status !== "pending") throw new Error("DNC import job is not accepting chunks");
  if (input.chunkIndex < 0 || input.chunkIndex >= Number(job.expectedChunkCount)) throw new Error("DNC chunk index is out of range");
  if (input.phones.length > Number(job.chunkSize)) throw new Error("DNC chunk exceeds the signed chunk size");
  const normalized = [...new Set(input.phones.map(normalizeUsPhone).filter((phone): phone is string => Boolean(phone)))].sort();
  if (!normalized.length) throw new Error("DNC chunk contained no valid US phone numbers");
  const rejected = input.phones.length - normalized.length;
  const sourceChunkSha256 = sha256(normalized.join("\n"));
  let replayed = false;
  rawDb.transaction(() => {
    const existing = rawDb.prepare(`SELECT source_chunk_sha256 AS sourceChunkSha256,input_count AS inputCount,
      accepted_count AS acceptedCount,rejected_count AS rejectedCount FROM dnc_import_chunks
      WHERE tenant_id=? AND import_id=? AND chunk_index=?`).get(input.tenantId, input.importId, input.chunkIndex) as any;
    if (existing) {
      if (existing.sourceChunkSha256 !== sourceChunkSha256 || Number(existing.inputCount) !== input.phones.length) {
        throw new Error("DNC chunk index was already used with different data");
      }
      replayed = true;
      return;
    }
    const insert = rawDb.prepare(`INSERT OR IGNORE INTO dnc_import_staging(tenant_id,import_id,phone_hash) VALUES (?,?,?)`);
    for (const phone of normalized) insert.run(input.tenantId, input.importId, hashPhone(input.tenantId, phone));
    rawDb.prepare(`INSERT INTO dnc_import_chunks
      (tenant_id,import_id,chunk_index,source_chunk_sha256,input_count,accepted_count,rejected_count)
      VALUES (?,?,?,?,?,?,?)`).run(input.tenantId, input.importId, input.chunkIndex, sourceChunkSha256,
        input.phones.length, normalized.length, rejected);
    rawDb.prepare("UPDATE dnc_import_jobs SET updated_at=datetime('now') WHERE tenant_id=? AND id=?")
      .run(input.tenantId, input.importId);
  }).immediate();
  const stagedUnique = Number((rawDb.prepare(`SELECT count(*) AS count FROM dnc_import_staging
    WHERE tenant_id=? AND import_id=?`).get(input.tenantId, input.importId) as any)?.count ?? 0);
  return { replayed, accepted: normalized.length, rejected, stagedUnique, sourceChunkSha256 };
}

export function finalizeDncImport(input: {
  tenantId: number;
  importId: string;
  actorUserId: number;
}): { datasetId: string; recordCount: number; checksum: string; expiresAt: string } {
  let output!: { datasetId: string; recordCount: number; checksum: string; expiresAt: string };
  const applyDncFinalization = () => {
    const job = rawDb.prepare(`SELECT * FROM dnc_import_jobs WHERE tenant_id=? AND id=?`).get(input.tenantId, input.importId) as any;
    if (!job) throw new Error("DNC import job not found");
    if (job.status === "finalized" && job.dataset_version_id) {
      const dataset = rawDb.prepare(`SELECT id,record_count AS recordCount,checksum_sha256 AS checksum,
        expires_at AS expiresAt FROM dnc_dataset_versions WHERE tenant_id=? AND id=?`)
        .get(input.tenantId, job.dataset_version_id) as any;
      if (!dataset) throw new Error("Finalized DNC dataset is missing");
      output = { datasetId: dataset.id, recordCount: Number(dataset.recordCount), checksum: dataset.checksum,
        expiresAt: dataset.expiresAt };
      return;
    }
    if (job.status !== "pending") throw new Error("DNC import job cannot be finalized");
    const sourceAsOfMs = Date.parse(job.source_as_of);
    const retrievedAtMs = Date.parse(job.source_retrieved_at);
    const nowMs = Date.now();
    const maxAgeMs = Math.min(31, Math.max(1, Number(job.max_age_days))) * 86_400_000;
    if (!Number.isFinite(sourceAsOfMs) || !Number.isFinite(retrievedAtMs)
        || retrievedAtMs < sourceAsOfMs || sourceAsOfMs > nowMs + 5 * 60_000
        || retrievedAtMs > nowMs + 5 * 60_000 || nowMs - sourceAsOfMs > maxAgeMs) {
      throw new Error("DNC source became stale or has invalid provenance dates before finalization");
    }
    const chunks = rawDb.prepare(`SELECT chunk_index AS chunkIndex,source_chunk_sha256 AS sourceChunkSha256,
      input_count AS inputCount,accepted_count AS acceptedCount FROM dnc_import_chunks
      WHERE tenant_id=? AND import_id=? ORDER BY chunk_index`).all(input.tenantId, input.importId) as any[];
    if (chunks.length !== Number(job.expected_chunk_count)
        || chunks.some((chunk, index) => Number(chunk.chunkIndex) !== index)) {
      throw new Error("DNC import is missing one or more signed chunks");
    }
    const sourceManifestSha256 = sha256(chunks.map((chunk) =>
      `${chunk.chunkIndex}:${chunk.sourceChunkSha256}:${chunk.inputCount}:${chunk.acceptedCount}`).join("\n"));
    if (sourceManifestSha256 !== job.source_manifest_sha256) throw new Error("DNC source manifest checksum does not match");
    const recordCount = Number((rawDb.prepare(`SELECT count(*) AS count FROM dnc_import_staging
      WHERE tenant_id=? AND import_id=?`).get(input.tenantId, input.importId) as any)?.count ?? 0);
    if (recordCount !== Number(job.expected_record_count)) throw new Error("DNC unique record count does not match the signed manifest");
    const digest = crypto.createHash("sha256");
    for (const row of rawDb.prepare(`SELECT phone_hash AS phoneHash FROM dnc_import_staging
      WHERE tenant_id=? AND import_id=? ORDER BY phone_hash`).iterate(input.tenantId, input.importId) as Iterable<any>) {
      digest.update(row.phoneHash).update("\n");
    }
    const checksum = digest.digest("hex");
    const datasetId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(sourceAsOfMs + maxAgeMs).toISOString();
    rawDb.prepare(`UPDATE dnc_dataset_versions SET status='superseded'
      WHERE tenant_id=? AND source_type=? AND coalesce(state,'')=coalesce(?, '') AND status='active'`)
      .run(input.tenantId, job.source_type, job.state);
    rawDb.prepare(`INSERT INTO dnc_dataset_versions
      (id,tenant_id,source_type,state,version_label,checksum_sha256,record_count,imported_at,source_as_of,
       source_retrieved_at,effective_at,expires_at,status,authorized_account_ref,covered_area_codes_json,imported_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active',?,?,?)`).run(datasetId, input.tenantId, job.source_type, job.state,
        job.version_label, checksum, recordCount, now.toISOString(), job.source_as_of, job.source_retrieved_at,
        job.source_as_of, expiresAt,
        job.authorized_account_ref, job.covered_area_codes_json, input.actorUserId);
    rawDb.prepare(`INSERT INTO dnc_suppressions(tenant_id,dataset_version_id,phone_hash)
      SELECT tenant_id,?,phone_hash FROM dnc_import_staging WHERE tenant_id=? AND import_id=?`)
      .run(datasetId, input.tenantId, input.importId);
    rawDb.prepare(`UPDATE dnc_import_jobs SET status='finalized',dataset_version_id=?,finalized_at=?,updated_at=?
      WHERE tenant_id=? AND id=?`).run(datasetId, now.toISOString(), now.toISOString(), input.tenantId, input.importId);
    rawDb.prepare("DELETE FROM dnc_import_staging WHERE tenant_id=? AND import_id=?")
      .run(input.tenantId, input.importId);
    output = { datasetId, recordCount, checksum, expiresAt };
  };
  if ((rawDb as any).inTransaction) applyDncFinalization();
  else rawDb.transaction(applyDncFinalization).immediate();
  return output;
}

export function listDncImports(tenantId: number, limit = 100): any[] {
  return rawDb.prepare(`SELECT id,source_type AS sourceType,state,version_label AS versionLabel,
    expected_record_count AS expectedRecordCount,expected_chunk_count AS expectedChunkCount,status,
    chunk_size AS chunkSize,source_as_of AS sourceAsOf,source_retrieved_at AS sourceRetrievedAt,
    dataset_version_id AS datasetVersionId,error_code AS errorCode,created_at AS createdAt,
    updated_at AS updatedAt,finalized_at AS finalizedAt,
    (SELECT count(*) FROM dnc_import_chunks c WHERE c.tenant_id=j.tenant_id AND c.import_id=j.id) AS receivedChunks,
    (SELECT count(*) FROM dnc_import_staging s WHERE s.tenant_id=j.tenant_id AND s.import_id=j.id) AS stagedUnique
    FROM dnc_import_jobs j WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?`)
    .all(tenantId, Math.min(500, Math.max(1, limit)));
}

export function importDncDataset(input: {
  tenantId: number;
  sourceType: "national" | "state";
  state?: string | null;
  versionLabel: string;
  authorizedAccountRef: string;
  coveredAreaCodes: string[];
  phones: string[];
  maxAgeDays: number;
  actorUserId: number;
}): { id: string; imported: number; rejected: number; checksum: string } {
  const normalized = [...new Set(input.phones.map(normalizeUsPhone).filter((phone): phone is string => Boolean(phone)))];
  const rejected = input.phones.length - normalized.length;
  if (!normalized.length) throw new Error("DNC import contained no valid US phone numbers");
  const hashes = normalized.map((phone) => hashPhone(input.tenantId, phone)).sort();
  const checksum = sha256(hashes.join("\n"));
  const id = crypto.randomUUID();
  const importedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Math.max(1, Math.min(31, input.maxAgeDays)) * 86_400_000).toISOString();
  rawDb.transaction(() => {
    rawDb.prepare(`UPDATE dnc_dataset_versions SET status='superseded'
      WHERE tenant_id=? AND source_type=? AND coalesce(state,'')=coalesce(?, '') AND status='active'`)
      .run(input.tenantId, input.sourceType, input.state ?? null);
    rawDb.prepare(`INSERT INTO dnc_dataset_versions
      (id,tenant_id,source_type,state,version_label,checksum_sha256,record_count,imported_at,source_as_of,
       source_retrieved_at,effective_at,expires_at,status,authorized_account_ref,covered_area_codes_json,imported_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`).run(id, input.tenantId, input.sourceType, input.state ?? null,
        input.versionLabel, checksum, hashes.length, importedAt, importedAt, importedAt, importedAt, expiresAt, input.authorizedAccountRef,
        JSON.stringify(input.coveredAreaCodes), input.actorUserId);
    const insert = rawDb.prepare(`INSERT INTO dnc_suppressions(tenant_id,dataset_version_id,phone_hash) VALUES (?,?,?)`);
    for (const phoneHashValue of hashes) insert.run(input.tenantId, id, phoneHashValue);
  }).immediate();
  return { id, imported: hashes.length, rejected, checksum };
}

export function createInternalOptOut(input: {
  tenantId: number;
  leadId: number;
  phoneId: number;
  actorUserId: number;
  reason: string;
  channel: string;
  sourceRef?: string | null;
  leaveAttemptIdOpen?: string | null;
  correlationId: string;
}): { dncId: string; alreadySuppressed: boolean; terminatedAttemptCount: number } {
  const phone = rawDb.prepare(`SELECT phone_hash AS phoneHash,encrypted_e164 AS encryptedE164 FROM phone_numbers
    WHERE tenant_id=? AND id=?`).get(input.tenantId, input.phoneId) as any;
  if (!phone) throw new Error("Phone not found");
  let dncId = crypto.randomUUID();
  let alreadySuppressed = false;
  let terminatedAttemptCount = 0;
  const applyOptOut = () => {
    const existing = rawDb.prepare(`SELECT id FROM internal_dnc_entries WHERE tenant_id=? AND phone_hash=? AND active=1`)
      .get(input.tenantId, phone.phoneHash) as any;
    if (existing) { dncId = existing.id; alreadySuppressed = true; }
    else {
      rawDb.prepare(`INSERT INTO internal_dnc_entries
        (id,tenant_id,phone_hash,encrypted_e164,reason,channel,source_ref,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(dncId, input.tenantId, phone.phoneHash, phone.encryptedE164,
          input.reason, input.channel, input.sourceRef ?? null, input.actorUserId, new Date().toISOString());
    }
    const profile = ensureCallingProfile(input.tenantId);
    if (profile.propagateOptOutPlatformWide) {
      const platformHash = hashPlatformPhone(decryptSensitive(phone.encryptedE164));
      rawDb.prepare(`INSERT OR IGNORE INTO platform_dnc_entries
        (id,phone_hash,reason,channel,source_tenant_id,source_ref,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), platformHash, input.reason, input.channel,
          input.tenantId, input.sourceRef ?? null, input.actorUserId, new Date().toISOString());
    }
    const previous = rawDb.prepare(`SELECT event_sha256 AS hash FROM suppression_events
      WHERE tenant_id=? AND internal_dnc_id=? ORDER BY created_at DESC LIMIT 1`).get(input.tenantId, dncId) as any;
    const eventId = crypto.randomUUID();
    const at = new Date().toISOString();
    const eventHash = sha256(JSON.stringify({ eventId, dncId, type: "OPT_OUT", reason: input.reason, channel: input.channel,
      actor: input.actorUserId, at, previous: previous?.hash ?? null }));
    rawDb.prepare(`INSERT INTO suppression_events
      (id,tenant_id,internal_dnc_id,event_type,actor_user_id,channel,reason,metadata_json,previous_event_sha256,event_sha256,created_at)
      VALUES (?,?,?,'OPT_OUT',?,?,?,?,?,?,?)`).run(eventId, input.tenantId, dncId, input.actorUserId,
        input.channel, input.reason, JSON.stringify({ leadId: input.leadId }), previous?.hash ?? null, eventHash, at);
    rawDb.prepare(`UPDATE phone_numbers SET validation_status='INTERNAL_DNC',updated_at=datetime('now') WHERE tenant_id=? AND id=?`)
      .run(input.tenantId, input.phoneId);
    rawDb.prepare(`UPDATE phone_address_associations SET wrong_party=CASE WHEN ? IN ('wrong_party','wrong_number') THEN 1 ELSE wrong_party END,
      updated_at=datetime('now') WHERE tenant_id=? AND phone_id=?`).run(input.reason, input.tenantId, input.phoneId);
    rawDb.prepare(`UPDATE contacts SET status='SUPPRESSED',updated_at=datetime('now') WHERE tenant_id=? AND id IN
      (SELECT contact_id FROM phone_address_associations WHERE tenant_id=? AND phone_id=?)`).run(input.tenantId, input.tenantId, input.phoneId);
    rawDb.prepare(`UPDATE calling_queue_entries SET stage='SUPPRESSED',closed_at=datetime('now'),version=version+1,updated_at=datetime('now')
      WHERE tenant_id=? AND phone_id=?`).run(input.tenantId, input.phoneId);
    rawDb.prepare(`UPDATE callback_tasks SET status='cancelled',cancelled_at=datetime('now')
      WHERE tenant_id=? AND phone_id=? AND status='scheduled'`).run(input.tenantId, input.phoneId);
    rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='INTERNAL_DNC'
      WHERE tenant_id=? AND phone_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(input.tenantId, input.phoneId);

    // STOP is a phone-level command, not a browser-session event. Terminate
    // every other open attempt for this tenant and phone in this same write
    // transaction so another tab/device cannot continue exposing or copying
    // the number. The disposition flow may preserve its own attempt briefly;
    // it records the consumer-selected disposition immediately afterward in
    // the enclosing transaction.
    const openAttempts = rawDb.prepare(`SELECT id,lead_id AS leadId FROM call_attempts
      WHERE tenant_id=? AND phone_id=? AND ended_at IS NULL
        AND (? IS NULL OR id<>?) ORDER BY started_at,id`)
      .all(input.tenantId, input.phoneId, input.leaveAttemptIdOpen ?? null, input.leaveAttemptIdOpen ?? null) as Array<{
        id: string;
        leadId: number;
      }>;
    const terminalCode = input.reason === "wrong_number" ? "WRONG_NUMBER"
      : input.reason === "wrong_party" ? "WRONG_PARTY"
      : input.reason === "consent_revoked" ? "CONSENT_REVOKED"
      : "DO_NOT_CALL";
    const insertDisposition = rawDb.prepare(`INSERT OR IGNORE INTO call_dispositions
      (id,tenant_id,attempt_id,code,notes,effect_json,idempotency_key,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const terminateAttempt = rawDb.prepare(`UPDATE call_attempts
      SET ended_at=?,disposition_code=?,notes=? WHERE tenant_id=? AND id=? AND ended_at IS NULL`);
    for (const attempt of openAttempts) {
      const idempotencyKey = `internal-opt-out:${dncId}:${attempt.id}`;
      insertDisposition.run(crypto.randomUUID(), input.tenantId, attempt.id, terminalCode,
        "Attempt terminated by a phone-level internal opt-out recorded in another session",
        JSON.stringify({ stage: "SUPPRESSED", suppressed: true, callbackCreated: false,
          opportunityCreated: false, automaticNextCall: false, systemTerminated: true, dncId }),
        idempotencyKey, input.actorUserId, at);
      const result = terminateAttempt.run(at, terminalCode,
        "Terminated by phone-level internal opt-out", input.tenantId, attempt.id);
      terminatedAttemptCount += result.changes;
    }
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId, eventType: "calling.opt_out",
      entityType: "lead", entityId: String(input.leadId), actorUserId: input.actorUserId,
      metadata: { leadId: input.leadId, phoneId: input.phoneId, reason: input.reason, channel: input.channel, dncId,
        terminatedAttemptCount } });
  };
  if ((rawDb as any).inTransaction) applyOptOut();
  else rawDb.transaction(applyOptOut).immediate();
  return { dncId, alreadySuppressed, terminatedAttemptCount };
}

export function dncStatus(tenantId: number): any {
  const now = new Date().toISOString();
  const national = currentDncDataset(tenantId, "national", null, now);
  const stateCodes = rawDb.prepare(`SELECT DISTINCT state FROM dnc_dataset_versions
    WHERE tenant_id=? AND source_type='state' AND status='active' AND state IS NOT NULL ORDER BY state`)
    .all(tenantId) as Array<{ state: string }>;
  // Use the exact same freshness + complete-coverage calculation used by the
  // authoritative engine. The status UI must never report a partial dataset
  // as fresh while authorization correctly blocks it.
  const states = stateCodes
    .map(({ state }) => ({ state, ...currentDncDataset(tenantId, "state", state, now) }))
    .filter((row) => Boolean(row.id));
  const internalCount = (rawDb.prepare(`SELECT count(*) AS count FROM internal_dnc_entries WHERE tenant_id=? AND active=1`)
    .get(tenantId) as any)?.count ?? 0;
  const platformCount = (rawDb.prepare("SELECT count(*) AS count FROM platform_dnc_entries").get() as any)?.count ?? 0;
  return { national, states, internalCount, platformCount };
}
