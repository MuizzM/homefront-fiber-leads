import crypto from "node:crypto";
import {
  consentEvidenceErrors,
  evaluateCallingCompliance,
  isInsideCallingWindow,
  type CallAuthorizationClaims,
  type ConsentEvidenceInput,
} from "@shared/calling";
import { rawDb } from "../db";
import { can, type Role } from "@shared/capabilities";
import { tracedComplianceOverlay } from "./tracedPhones";
import {
  callingEnvironment,
  sha256,
  signCallAuthorization,
  verifyCallAuthorization,
} from "./crypto";
import {
  activeRegistration,
  activeRuleVersion,
  activeSellerAuthorization,
  activeScript,
  appendCallingAudit,
  assertRepresentativeCallingNotHeld,
  attemptCounts,
  createInternalOptOut,
  currentConsent,
  currentDncDataset,
  dncHit,
  ensureCallingProfile,
  getCallingCandidate,
  getDecision,
  internalDncHit,
  getActiveRepresentativeCallingHold,
  platformDncHit,
  persistComplianceDecision,
  previousDispositionAllowed,
  revealPhone,
  type CallingCandidate,
} from "./store";

const DISPOSITIONS = new Set([
  "NO_ANSWER", "BUSY", "DISCONNECTED", "VOICEMAIL_REACHED", "LEFT_NO_MESSAGE",
  "CALLBACK_REQUESTED", "INTERESTED", "NOT_INTERESTED", "WRONG_NUMBER", "WRONG_PARTY",
  "PROPERTY_OWNER_NOT_RESIDENT", "ALREADY_HAS_SERVICE", "NOT_SERVICEABLE", "APPOINTMENT_SCHEDULED",
  "SALE_STARTED", "SALE_COMPLETED", "DO_NOT_CALL", "CONSENT_GRANTED", "CONSENT_REVOKED",
  "LANGUAGE_BARRIER", "REVIEW_REQUIRED",
]);

function inImmediateTransaction<T>(work: () => T): T {
  return (rawDb as any).inTransaction ? work() : rawDb.transaction(work).immediate();
}

function timeZoneFor(candidate: CallingCandidate, fallback: string): { zone: string | null; confidence: "high" | "medium" | "low" | "unknown" } {
  // NC, SC and GA are each wholly Eastern for this product's authorized launch
  // market. Split-time-zone states require a geospatial timezone resolver before
  // they can become callable; a tenant default alone is intentionally
  // insufficient. GA qualifies under the same wholly-Eastern rule as NC/SC.
  if (["NC", "SC", "GA"].includes(candidate.state.toUpperCase())) return { zone: "America/New_York", confidence: "high" };
  return fallback ? { zone: fallback, confidence: "low" } : { zone: null, confidence: "unknown" };
}

function minuteOfDay(value: unknown): number | null {
  const match = typeof value === "string" ? /^(\d{2}):(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const hour = Number(match[1]); const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

function effectiveRulePolicy(ruleVersion: any, candidate: CallingCandidate, profile: any): {
  allowedState: boolean;
  blockedLineType: boolean;
  minimumIdentityConfidence: number;
  maxAttempts7Days: number;
  maxAttempts30Days: number;
  callingWindow: { startLocal: string; endLocal: string };
} {
  const config = ruleVersion?.config && typeof ruleVersion.config === "object" ? ruleVersion.config : {};
  const states = Array.isArray(config.allowedStates)
    ? config.allowedStates.filter((value: unknown): value is string => typeof value === "string" && /^[A-Z]{2}$/.test(value))
    : ["NC", "SC", "GA"];
  const blockedLineTypes = Array.isArray(config.blockedLineTypes)
    ? config.blockedLineTypes.filter((value: unknown): value is string => typeof value === "string") : [];
  const configuredWindow = config.stateCallingWindows?.[candidate.state.toUpperCase()];
  let startLocal = typeof configuredWindow?.startLocal === "string" ? configuredWindow.startLocal : profile.allowedStartLocal;
  let endLocal = typeof configuredWindow?.endLocal === "string" ? configuredWindow.endLocal : profile.allowedEndLocal;
  const start = minuteOfDay(startLocal); const end = minuteOfDay(endLocal);
  // Counsel configuration may narrow, never widen, the 08:00–21:00 safety envelope.
  if (start == null || end == null || start < 8 * 60 || end > 21 * 60 || start >= end) {
    startLocal = "00:00"; endLocal = "00:00";
  }
  const configuredIdentity = Number(config.minimumIdentityConfidence);
  const configured7 = Number(config.maxAttempts7Days);
  const configured30 = Number(config.maxAttempts30Days);
  return {
    allowedState: states.includes(candidate.state.toUpperCase()),
    blockedLineType: Boolean(candidate.lineType && blockedLineTypes.includes(candidate.lineType)),
    minimumIdentityConfidence: Number.isFinite(configuredIdentity)
      ? Math.max(profile.minimumIdentityConfidence, Math.min(1, configuredIdentity)) : profile.minimumIdentityConfidence,
    maxAttempts7Days: Number.isInteger(configured7) && configured7 >= 0
      ? Math.min(profile.maxAttempts7Days, configured7) : profile.maxAttempts7Days,
    maxAttempts30Days: Number.isInteger(configured30) && configured30 >= 0
      ? Math.min(profile.maxAttempts30Days, configured30) : profile.maxAttempts30Days,
    callingWindow: { startLocal, endLocal },
  };
}

function buildEvaluation(
  tenantId: number,
  actorUserId: number,
  actorRole: Role | string,
  leadId: number,
  canManage: boolean,
  manualActionConfirmed = false,
) {
  const candidate = getCallingCandidate(tenantId, leadId);
  if (!candidate) throw new Error("Calling record not found");
  const profile = ensureCallingProfile(tenantId);
  const environment = callingEnvironment(tenantId);
  const now = new Date().toISOString();
  const registration = activeRegistration(tenantId, candidate.state.toUpperCase(), now);
  const script = activeScript(tenantId);
  const ruleVersion = activeRuleVersion(tenantId);
  const sellerAuthorization = activeSellerAuthorization(tenantId, profile.sellerName, profile.sellerAuthorizationRef, now);
  const nationalDataset = currentDncDataset(tenantId, "national", null, now);
  const stateDataset = currentDncDataset(tenantId, "state", candidate.state.toUpperCase(), now);
  const consent = currentConsent(tenantId, candidate.phoneId, leadId, profile.sellerName, now);
  const attempts = attemptCounts(tenantId, candidate.phoneId);
  const timeZone = timeZoneFor(candidate, profile.defaultTimeZone);
  const rulePolicy = effectiveRulePolicy(ruleVersion, candidate, profile);
  const queueOwned = canManage || candidate.assignedUserId == null || candidate.assignedUserId === actorUserId;
  const representativeAuthorized = can(actorRole, "calling.attempt.manual");
  const representativeHold = getActiveRepresentativeCallingHold(tenantId, actorUserId);
  const providerUseApproved = candidate.providerEnabled && candidate.providerPermittedUseApproved
    && candidate.providerUseExplicit && candidate.providerContractStatus === "approved" && Boolean(candidate.providerContractRef)
    && candidate.validationProviderEnabled && candidate.validationProviderPermittedUseApproved
    && candidate.validationProviderUseExplicit && candidate.validationProviderContractStatus === "approved"
    && Boolean(candidate.validationProviderContractRef);
  const phoneValidationFresh = candidate.phoneValidationStatus === "VALID"
    && Boolean(candidate.phoneVerificationExpiresAt) && Date.parse(candidate.phoneVerificationExpiresAt!) > Date.parse(now);
  // A skip-traced lead carries its own DNC evidence: Tracerfy scrubbed the
  // number against the federal and state registries when it returned it. That
  // scrub is folded into the SAME rules an imported dataset feeds, never into
  // a parallel set — see calling/tracedPhones.ts. Null for leads that arrived
  // through the fiber pipeline, which leaves the evaluation untouched.
  const traced = tracedComplianceOverlay(tenantId, leadId, Date.parse(now));
  const policyInput = {
    evaluatedAt: now,
    featureEnabled: environment.moduleEnabled && environment.manualClickToCallEnabled
      && environment.secretsReady && profile.callingEnabled,
    emergencyDisabled: environment.emergencyDisabled || profile.emergencyDisabled,
    tenantAuthorized: environment.pilotAllowed,
    // Two ways to be callable, and a lead needs exactly one of them.
    //
    // Historically the only one was the fiber pipeline: cross-verified fresh
    // fiber off a scan target. A skip-traced lead can never satisfy that — it
    // was never scanned — so enqueuing traced doors without widening this rule
    // would fill the queue with rows that evaluate BLOCKED_TENANT_POLICY the
    // moment a rep opens them.
    //
    // The traced arm is NOT weaker, it rests on different evidence: a number a
    // contracted provider associated with this address and scrubbed against
    // both registries. The scrub's own freshness still gates the dial through
    // dnc_screened below, so an area traced once and left for a month stops
    // being callable on its own without anything writing to the database.
    leadStillQualified: (
      (candidate.freshConfidence === "cross_verified" && Boolean(candidate.freshConfirmedAt)
        && Boolean(candidate.sourceScanTargetId))
      || Boolean(traced)
    ) && !candidate.queueClosedAt
      && !["sold", "not_interested"].includes(candidate.leadStatus),
    representativeAuthorized,
    representativeOnHold: Boolean(representativeHold),
    sellerAuthorized: profile.sellerAuthorized && Boolean(sellerAuthorization),
    registrationValid: Boolean(registration) && registration.legalEntity === profile.sellerName,
    legalConfigurationApproved: profile.counselApproved && profile.stateRulesApproved && rulePolicy.allowedState
      && script?.sellerName === profile.sellerName,
    providerUseApproved,
    providerContractRef: [candidate.providerContractRef, candidate.validationProviderContractRef].filter(Boolean).join("|") || null,
    // Simple mode: a phone number existing is enough.
    phoneValid: process.env.CALLING_SIMPLE_MODE !== "off"
      ? Boolean(candidate.phoneId)
      : Boolean(candidate.phoneId) && candidate.phoneValidationStatus !== "INVALID" && !rulePolicy.blockedLineType
        && !["unknown", "toll_free", "other"].includes(candidate.lineType?.toLowerCase() ?? "unknown"),
    lineType: candidate.lineType,
    manualActionConfirmed,
    phoneValidationFresh,
    residentAssociationAllowed: ["POSSIBLE_RESIDENT", "VERIFIED_RESIDENT"].includes(candidate.residentStatus ?? "")
      && Boolean(candidate.associationExpiresAt) && Date.parse(candidate.associationExpiresAt!) > Date.parse(now),
    identityConfidence: candidate.identityConfidence,
    minimumIdentityConfidence: rulePolicy.minimumIdentityConfidence,
    wrongParty: candidate.wrongParty,
    // Platform-wide suppression is only written when the originating
    // organization explicitly enables that counsel-approved business policy.
    // Organization suppression is always checked independently.
    internalDnc: platformDncHit(tenantId, candidate.phoneId),
    // A known TCPA serial litigator is suppressed at the organization level —
    // the hardest block the engine has, and the one that short-circuits ahead
    // of every configuration reason so it can never be masked by an unrelated
    // gap in setup.
    tenantDnc: internalDncHit(tenantId, candidate.phoneHash) || Boolean(traced?.tenantDnc),
    // Every DNC signal ORs: a hit from either source is a hit. The traced flags
    // can only ever ADD a block, never clear one an imported dataset found.
    nationalDnc: dncHit(tenantId, nationalDataset?.id ?? null, candidate.phoneHash) || Boolean(traced?.nationalDnc),
    stateDnc: dncHit(tenantId, stateDataset?.id ?? null, candidate.phoneHash) || Boolean(traced?.stateDnc),
    // Screening COVERAGE, not hits. A current provider scrub is the evidence
    // this rule asks for, so a traced lead is screened even in an organization
    // holding no imported registry files. verdictForPhone fails closed on both
    // "never scrubbed" and "scrub expired", so neither can satisfy it and the
    // engine falls through to BLOCKED_STALE_DNC_DATA on its own.
    nationalDncFresh: (environment.nationalDncEnabled && Boolean(nationalDataset?.fresh)
      && Date.parse(now) - Date.parse(nationalDataset?.sourceAsOf ?? "") <= profile.dncMaxAgeDays * 86_400_000)
      || Boolean(traced?.screened),
    stateDncFresh: (environment.stateDncEnabled && Boolean(stateDataset?.fresh)
      && Date.parse(now) - Date.parse(stateDataset?.sourceAsOf ?? "") <= profile.dncMaxAgeDays * 86_400_000)
      || Boolean(traced?.screened),
    dncDatasetRef: [nationalDataset?.id, stateDataset?.id].filter(Boolean).join(",") || null,
    verifiedConsent: consent.verified,
    consentRevoked: consent.revoked,
    allowNationalDncConsentOverride: profile.allowNationalDncConsentOverride,
    allowStateDncConsentOverride: profile.allowStateDncConsentOverride,
    reassignedRisk: candidate.reassignedRisk,
    timeZone: timeZone.zone,
    timeZoneConfidence: timeZone.confidence,
    callingWindow: rulePolicy.callingWindow,
    frequencyAllowed: attempts.sevenDays < rulePolicy.maxAttempts7Days && attempts.thirtyDays < rulePolicy.maxAttempts30Days,
    previousDispositionAllowed: previousDispositionAllowed(tenantId, leadId, candidate.phoneId),
    queueOwned,
    callerIdAuthorized: profile.callerIdAuthorized && Boolean(profile.callerIdReference),
    scriptApproved: Boolean(script),
    scriptVersion: script?.version ?? null,
    ruleVersion: ruleVersion?.version ?? `profile-${profile.policyVersion}`,
    ruleVersionAvailable: Boolean(ruleVersion),
  };
  const evaluation = evaluateCallingCompliance(policyInput);
  const evidence = {
    tenantId, leadId, contactId: candidate.contactId, phoneId: candidate.phoneId,
    environment: {
      moduleEnabled: environment.moduleEnabled, nationalDncEnabled: environment.nationalDncEnabled,
      stateDncEnabled: environment.stateDncEnabled, pilotAllowed: environment.pilotAllowed,
      emergencyDisabled: environment.emergencyDisabled, secretsReady: environment.secretsReady,
    },
    profileVersion: profile.policyVersion,
    registrationId: registration?.id ?? null, scriptId: script?.id ?? null,
    sellerAuthorizationId: sellerAuthorization?.id ?? null,
    ruleVersionId: ruleVersion?.id ?? null,
    nationalDatasetId: nationalDataset?.id ?? null, stateDatasetId: stateDataset?.id ?? null,
    // The scrub behind a traced block, so an audit export can show WHICH
    // registry condemned the number rather than only that something did.
    tracedScrub: traced ? {
      dncFlags: traced.verdict.dncFlags, reasons: traced.verdict.reasons,
      dnc: traced.verdict.dnc, screened: traced.screened,
    } : null,
    consentId: consent.id,
    representativeHoldId: representativeHold?.id ?? null,
    associationExpiresAt: candidate.associationExpiresAt,
    associationProviderConfigId: candidate.providerConfigId,
    validationProviderConfigId: candidate.validationProviderConfigId,
    policyInput,
  };
  return { candidate, profile, environment, registration, script, ruleVersion, nationalDataset, stateDataset, consent, evaluation, evidence };
}

export function evaluateLeadCompliance(input: {
  tenantId: number;
  actorUserId: number;
  actorRole: Role | string;
  leadId: number;
  canManage: boolean;
  manualActionConfirmed?: boolean;
  correlationId: string;
}): { decisionId: string; evaluation: ReturnType<typeof evaluateCallingCompliance> } {
  return inImmediateTransaction(() => {
    const state = buildEvaluation(
      input.tenantId,
      input.actorUserId,
      input.actorRole,
      input.leadId,
      input.canManage,
      input.manualActionConfirmed === true,
    );
    const decisionId = persistComplianceDecision({
      tenantId: input.tenantId,
      candidate: state.candidate,
      evaluation: state.evaluation,
      actorUserId: input.actorUserId,
      evidence: state.evidence,
      dncDatasetRefs: [state.nationalDataset?.id, state.stateDataset?.id].filter((id): id is string => Boolean(id)),
      registrationRef: state.registration?.evidenceRef ?? null,
      scriptVersion: state.script?.version ?? null,
    });
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId, eventType: "compliance.evaluated",
      entityType: "lead", entityId: String(input.leadId), actorUserId: input.actorUserId,
      metadata: { leadId: input.leadId, decisionId, finalStatus: state.evaluation.decision,
        eligible: state.evaluation.eligible, reasonCodes: state.evaluation.reasonCodes } });
    return { decisionId, evaluation: state.evaluation };
  });
}

export function issueCallAuthorization(input: {
  tenantId: number;
  actorUserId: number;
  actorRole: Role | string;
  leadId: number;
  canManage: boolean;
  action: CallAuthorizationClaims["action"];
  correlationId: string;
}): { token: string; expiresAt: string; decisionId: string; maskedPhone: string; script: any } {
  // Only this explicit, user-bound authorization action confirms the manual
  // step. Background/generic evaluations remain fail-closed.
  const result = evaluateLeadCompliance({ ...input, manualActionConfirmed: true });
  if (!result.evaluation.eligible) {
    const error = new Error(`Call blocked: ${result.evaluation.decision}`);
    (error as any).status = 409;
    (error as any).decision = result;
    throw error;
  }
  const candidate = getCallingCandidate(input.tenantId, input.leadId);
  if (!candidate?.contactId || !candidate.phoneId || !candidate.maskedPhone) throw new Error("Callable contact is incomplete");
  const nowMs = Date.now();
  const ttl = Math.max(30, Math.min(300, Number(process.env.CALL_AUTHORIZATION_TTL_SECONDS) || 120));
  const claims: CallAuthorizationClaims = {
    version: 1, tenantId: input.tenantId, userId: input.actorUserId, leadId: input.leadId,
    contactId: candidate.contactId, phoneId: candidate.phoneId, decisionId: result.decisionId,
    action: input.action, issuedAt: nowMs, expiresAt: nowMs + ttl * 1_000,
    nonce: crypto.randomBytes(24).toString("base64url"), ruleVersion: result.evaluation.ruleVersion,
  };
  const token = signCallAuthorization(claims);
  inImmediateTransaction(() => {
    rawDb.prepare(`INSERT INTO call_authorizations
      (id,tenant_id,user_id,lead_id,contact_id,phone_id,compliance_decision_id,action,nonce_sha256,token_sha256,issued_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), input.tenantId, input.actorUserId, input.leadId,
        candidate.contactId, candidate.phoneId, result.decisionId, input.action, sha256(claims.nonce), sha256(token),
        new Date(nowMs).toISOString(), new Date(claims.expiresAt).toISOString());
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId, eventType: "call.authorization_issued",
      entityType: "lead", entityId: String(input.leadId), actorUserId: input.actorUserId,
      metadata: { leadId: input.leadId, phoneId: candidate.phoneId, decisionId: result.decisionId,
        action: input.action, expiresAt: new Date(claims.expiresAt).toISOString() } });
  });
  return { token, expiresAt: new Date(claims.expiresAt).toISOString(), decisionId: result.decisionId,
    maskedPhone: candidate.maskedPhone, script: activeScript(input.tenantId) };
}

export function startManualAttempt(input: {
  tenantId: number;
  actorUserId: number;
  actorRole: Role | string;
  token: string;
  correlationId: string;
}): { attemptId: string; phoneNumber: string; script: any; noAutomaticNextCall: true } {
  const claims = verifyCallAuthorization(input.token);
  if (claims.tenantId !== input.tenantId || claims.userId !== input.actorUserId || !can(input.actorRole, "calling.attempt.manual")) {
    throw Object.assign(new Error("Call authorization is not bound to this user"), { status: 403 });
  }
  if (claims.expiresAt <= Date.now()) throw Object.assign(new Error("Call authorization expired"), { status: 409 });
  assertRepresentativeCallingNotHeld(input.tenantId, input.actorUserId);
  const environment = callingEnvironment(input.tenantId);
  if (!environment.moduleEnabled || !environment.manualClickToCallEnabled || environment.emergencyDisabled
      || !environment.pilotAllowed || !environment.secretsReady) {
    throw Object.assign(new Error("Calling is currently disabled"), { status: 409 });
  }
  let attemptId = "";
  rawDb.transaction(() => {
    const auth = rawDb.prepare(`SELECT id,used_at AS usedAt,invalidated_at AS invalidatedAt,expires_at AS expiresAt,
      compliance_decision_id AS decisionId FROM call_authorizations
      WHERE tenant_id=? AND user_id=? AND lead_id=? AND contact_id=? AND phone_id=? AND token_sha256=? AND nonce_sha256=?`)
      .get(input.tenantId, input.actorUserId, claims.leadId, claims.contactId, claims.phoneId, sha256(input.token), sha256(claims.nonce)) as any;
    if (!auth || auth.usedAt || auth.invalidatedAt || Date.parse(auth.expiresAt) <= Date.now()) throw new Error("Call authorization is stale or already used");
    const decision = getDecision(input.tenantId, auth.decisionId);
    if (!decision?.eligible || decision.expiresAt <= new Date().toISOString() || decision.ruleVersion !== claims.ruleVersion) {
      throw new Error("Compliance decision is stale");
    }
    // Recompute every rule while BEGIN IMMEDIATE holds the write lock. The
    // earlier signed decision authorizes this user action, but never replaces
    // a current DNC/consent/hours/provider/registration/assignment recheck.
    const refreshed = buildEvaluation(
      input.tenantId,
      input.actorUserId,
      input.actorRole,
      claims.leadId,
      can(input.actorRole, "calling.manage"),
      true,
    );
    const candidate = refreshed.candidate;
    const profile = refreshed.profile;
    const consent = refreshed.consent;
    if (!candidate || candidate.phoneId !== claims.phoneId || candidate.contactId !== claims.contactId) throw new Error("Queue assignment changed");
    if (candidate.lastDecisionId !== claims.decisionId || candidate.queueStage !== "ELIGIBLE_MANUAL_CALL") {
      throw new Error("Queue compliance state changed after authorization");
    }
    if (!refreshed.evaluation.eligible || refreshed.evaluation.ruleVersion !== claims.ruleVersion) {
      throw new Error(`Compliance changed after authorization: ${refreshed.evaluation.decision}`);
    }
    if (candidate.assignedUserId != null && candidate.assignedUserId !== input.actorUserId) throw new Error("Queue assignment changed");
    if (rawDb.prepare(`SELECT 1 FROM call_attempts WHERE tenant_id=? AND phone_id=? AND ended_at IS NULL LIMIT 1`)
      .get(input.tenantId, claims.phoneId)) {
      throw new Error("This phone already has an open manual attempt that must be dispositioned first");
    }
    if (internalDncHit(input.tenantId, candidate.phoneHash) || consent.revoked) throw new Error("Number was suppressed after authorization");
    if (candidate.phoneValidationStatus !== "VALID" || candidate.reassignedRisk || candidate.wrongParty) throw new Error("Phone status changed after authorization");
    if (profile.emergencyDisabled || !profile.callingEnabled || !profile.callerIdAuthorized || !profile.callerIdReference) throw new Error("Calling policy changed after authorization");
    const zone = timeZoneFor(candidate, profile.defaultTimeZone);
    if (!zone.zone || zone.confidence === "low" || !isInsideCallingWindow(new Date(), zone.zone,
      { startLocal: profile.allowedStartLocal, endLocal: profile.allowedEndLocal })) throw new Error("Calling hours changed after authorization");
    const activeRules = activeRuleVersion(input.tenantId);
    if (!activeRules || activeRules.version !== claims.ruleVersion) throw new Error("Rule version changed after authorization");
    const script = activeScript(input.tenantId);
    if (!script) throw new Error("Approved script is unavailable");
    attemptId = crypto.randomUUID();
    rawDb.prepare(`UPDATE call_authorizations SET used_at=datetime('now') WHERE id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(auth.id);
    rawDb.prepare(`INSERT INTO call_attempts
      (id,tenant_id,authorization_id,lead_id,contact_id,phone_id,representative_user_id,caller_id_reference,script_version,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(attemptId, input.tenantId, auth.id, claims.leadId, claims.contactId,
        claims.phoneId, input.actorUserId, profile.callerIdReference, script.version, new Date().toISOString());
    rawDb.prepare(`UPDATE calling_queue_entries SET stage='ATTEMPTED',assigned_user_id=?,version=version+1,updated_at=datetime('now')
      WHERE tenant_id=? AND lead_id=?`).run(input.actorUserId, input.tenantId, claims.leadId);
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId, eventType: "call.manual_attempt_started",
      entityType: "lead", entityId: String(claims.leadId), actorUserId: input.actorUserId,
      metadata: { leadId: claims.leadId, phoneId: claims.phoneId, attemptId, action: claims.action,
        noAutomaticNextCall: true } });
  }).immediate();
  return { attemptId, phoneNumber: revealPhone(input.tenantId, claims.phoneId), script: activeScript(input.tenantId), noAutomaticNextCall: true };
}

export function recordCallDisposition(input: {
  tenantId: number;
  actorUserId: number;
  attemptId: string;
  code: string;
  notes?: string | null;
  callbackAt?: string | null;
  callbackTimeZone?: string | null;
  callbackConsentEvidenceRef?: string | null;
  idempotencyKey: string;
  correlationId: string;
}): { dispositionId: string; stage: string; replayed: boolean } {
  if (!DISPOSITIONS.has(input.code)) throw new Error("Unsupported call disposition");
  const existing = rawDb.prepare(`SELECT id,attempt_id AS attemptId,code,created_by AS createdBy,effect_json AS effectJson
    FROM call_dispositions WHERE tenant_id=? AND idempotency_key=?`)
    .get(input.tenantId, input.idempotencyKey) as any;
  if (existing) {
    if (existing.attemptId !== input.attemptId || existing.code !== input.code || existing.createdBy !== input.actorUserId) {
      throw Object.assign(new Error("Idempotency key was already used for a different disposition"), { status: 409 });
    }
    return { dispositionId: existing.id, stage: JSON.parse(existing.effectJson).stage, replayed: true };
  }
  const attempt = rawDb.prepare(`SELECT a.*,q.id AS queue_id FROM call_attempts a JOIN calling_queue_entries q
    ON q.tenant_id=a.tenant_id AND q.lead_id=a.lead_id WHERE a.tenant_id=? AND a.id=?`).get(input.tenantId, input.attemptId) as any;
  if (!attempt) throw new Error("Call attempt not found");
  if (attempt.representative_user_id !== input.actorUserId) throw Object.assign(new Error("Call attempt belongs to another representative"), { status: 403 });
  if (attempt.ended_at || attempt.disposition_code) {
    throw Object.assign(new Error("Call attempt already has a terminal disposition"), { status: 409 });
  }
  if (input.code === "CALLBACK_REQUESTED") {
    if (!input.callbackAt || !Number.isFinite(Date.parse(input.callbackAt))
        || Date.parse(input.callbackAt) <= Date.now() || !input.callbackTimeZone
        || !input.callbackConsentEvidenceRef) {
      throw new Error("A future callback date, time zone, and consent evidence are required");
    }
    const artifact = rawDb.prepare(`SELECT id FROM consent_evidence_artifacts
      WHERE tenant_id=? AND id=? AND lead_id=? AND phone_id=? AND call_attempt_id=?
        AND verification_method='signed_storage_attestation_v1'
        AND unixepoch(captured_at)>=unixepoch(?) AND unixepoch(retention_until)>=unixepoch('now','+5 years')`).get(input.tenantId,
      input.callbackConsentEvidenceRef, attempt.lead_id, attempt.phone_id, input.attemptId, attempt.started_at);
    if (!artifact) throw new Error("Callback scheduling requires a verified evidence artifact bound to this call attempt");
  }
  if (input.code === "CONSENT_GRANTED") {
    const profile = ensureCallingProfile(input.tenantId);
    const consent = currentConsent(input.tenantId, attempt.phone_id, attempt.lead_id, profile.sellerName, new Date().toISOString());
    if (!consent.verified || consent.revoked) {
      throw new Error("Consent granted disposition requires a current verified consent evidence record");
    }
  }
  const suppressReason = input.code === "WRONG_PARTY" ? "wrong_party"
    : input.code === "WRONG_NUMBER" ? "wrong_number"
    : input.code === "CONSENT_REVOKED" ? "consent_revoked"
    : input.code === "DO_NOT_CALL" ? "do_not_call" : null;
  const stage = suppressReason ? "SUPPRESSED"
    : input.code === "CALLBACK_REQUESTED" ? "CALLBACK_SCHEDULED"
    : ["INTERESTED", "APPOINTMENT_SCHEDULED", "SALE_STARTED"].includes(input.code) ? "INTERESTED"
    : input.code === "SALE_COMPLETED" ? "CONVERTED"
    : ["NOT_INTERESTED", "ALREADY_HAS_SERVICE", "NOT_SERVICEABLE"].includes(input.code) ? "CLOSED"
    : input.code === "DISCONNECTED" ? "COMPLIANCE_BLOCKED"
    : input.code === "PROPERTY_OWNER_NOT_RESIDENT" ? "COMPLIANCE_REVIEW"
    : "ATTEMPTED";
  const dispositionId = crypto.randomUUID();
  rawDb.transaction(() => {
    if (suppressReason) createInternalOptOut({ tenantId: input.tenantId, leadId: attempt.lead_id,
      phoneId: attempt.phone_id, actorUserId: input.actorUserId, reason: suppressReason, channel: "call_disposition",
      sourceRef: input.attemptId, leaveAttemptIdOpen: input.attemptId, correlationId: input.correlationId });
    if (input.code === "CONSENT_REVOKED") {
      const consents = rawDb.prepare(`SELECT id FROM consent_records WHERE tenant_id=? AND lead_id=? AND phone_id=?`)
        .all(input.tenantId, attempt.lead_id, attempt.phone_id) as Array<{ id: string }>;
      for (const consent of consents) {
        if (rawDb.prepare(`SELECT 1 FROM consent_revocations WHERE tenant_id=? AND consent_id=? LIMIT 1`)
          .get(input.tenantId, consent.id)) continue;
        rawDb.prepare(`INSERT INTO consent_revocations
          (id,tenant_id,consent_id,phone_id,scope,method,evidence_ref,revoked_at,created_by)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), input.tenantId, consent.id, attempt.phone_id,
            "all_manual_voice_call_consent", "live_call", input.attemptId, new Date().toISOString(), input.actorUserId);
      }
    }
    const effect = { stage, suppressed: Boolean(suppressReason), callbackCreated: input.code === "CALLBACK_REQUESTED",
      opportunityCreated: ["INTERESTED", "APPOINTMENT_SCHEDULED", "SALE_STARTED", "SALE_COMPLETED"].includes(input.code),
      automaticNextCall: false };
    rawDb.prepare(`INSERT INTO call_dispositions
      (id,tenant_id,attempt_id,code,notes,effect_json,idempotency_key,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(dispositionId, input.tenantId, input.attemptId, input.code, input.notes ?? null,
        JSON.stringify(effect), input.idempotencyKey, input.actorUserId, new Date().toISOString());
    rawDb.prepare(`UPDATE call_attempts SET ended_at=?,disposition_code=?,notes=? WHERE tenant_id=? AND id=?`)
      .run(new Date().toISOString(), input.code, input.notes ?? null, input.tenantId, input.attemptId);
    if (!suppressReason) rawDb.prepare(`UPDATE calling_queue_entries SET stage=?,closed_at=?,version=version+1,updated_at=datetime('now')
      WHERE tenant_id=? AND lead_id=?`).run(stage, ["CONVERTED", "CLOSED"].includes(stage) ? new Date().toISOString() : null,
        input.tenantId, attempt.lead_id);
    if (input.code === "DISCONNECTED") {
      rawDb.prepare(`UPDATE phone_numbers SET validation_status='INVALID',verification_expires_at=datetime('now'),
        updated_at=datetime('now') WHERE tenant_id=? AND id=?`).run(input.tenantId, attempt.phone_id);
      rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='PHONE_DISCONNECTED'
        WHERE tenant_id=? AND phone_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(input.tenantId, attempt.phone_id);
    }
    if (input.code === "CALLBACK_REQUESTED") {
      rawDb.prepare(`INSERT INTO callback_tasks
        (id,tenant_id,queue_entry_id,lead_id,phone_id,assigned_user_id,due_at,time_zone,consent_evidence_ref,status)
        VALUES (?,?,?,?,?,?,?,?,?,'scheduled')`).run(crypto.randomUUID(), input.tenantId, attempt.queue_id,
          attempt.lead_id, attempt.phone_id, input.actorUserId, input.callbackAt, input.callbackTimeZone,
          input.callbackConsentEvidenceRef);
    }
    if (["INTERESTED", "APPOINTMENT_SCHEDULED", "SALE_STARTED", "SALE_COMPLETED"].includes(input.code)) {
      rawDb.prepare(`INSERT INTO calling_opportunities
        (id,tenant_id,lead_id,contact_id,source_attempt_id,status,assigned_user_id,next_step_at,converted_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,lead_id) DO UPDATE SET status=excluded.status,
          source_attempt_id=excluded.source_attempt_id,assigned_user_id=excluded.assigned_user_id,
          next_step_at=excluded.next_step_at,converted_at=excluded.converted_at,updated_at=datetime('now')`).run(
            crypto.randomUUID(), input.tenantId, attempt.lead_id, attempt.contact_id, input.attemptId,
            input.code === "SALE_COMPLETED" ? "converted" : "open", input.actorUserId,
            input.callbackAt ?? null, input.code === "SALE_COMPLETED" ? new Date().toISOString() : null,
          );
    }
    if (["CONVERTED", "CLOSED", "COMPLIANCE_BLOCKED"].includes(stage)) {
      rawDb.prepare(`UPDATE callback_tasks SET status='cancelled',cancelled_at=datetime('now')
        WHERE tenant_id=? AND lead_id=? AND status='scheduled'`).run(input.tenantId, attempt.lead_id);
      rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='TERMINAL_DISPOSITION'
        WHERE tenant_id=? AND lead_id=? AND used_at IS NULL AND invalidated_at IS NULL`)
        .run(input.tenantId, attempt.lead_id);
    }
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId, eventType: "call.disposition_recorded",
      entityType: "lead", entityId: String(attempt.lead_id), actorUserId: input.actorUserId,
      metadata: { leadId: attempt.lead_id, attemptId: input.attemptId, dispositionId, code: input.code, ...effect } });
  }).immediate();
  return { dispositionId, stage, replayed: false };
}

export function createConsentRecord(input: ConsentEvidenceInput & {
  tenantId: number;
  leadId: number;
  contactId?: number | null;
  actorUserId: number;
  correlationId: string;
}): string {
  const errors = consentEvidenceErrors(input);
  if (errors.length) throw new Error(`Consent evidence incomplete: ${errors.join(", ")}`);
  if (input.tenantId !== input.organizationId) throw new Error("Consent organization does not match tenant");
  if (input.consentType.toLowerCase() !== "express_written_telemarketing"
      || input.channels.length !== 1 || input.channels[0] !== "manual_voice_call") {
    throw new Error("Consent type and channel are not approved for telemarketing eligibility");
  }
  const proofRef = input.method === "recorded_call" ? input.voiceRecordingRef : input.signatureRef;
  if (!proofRef || proofRef !== input.evidenceArtifactRef) {
    throw new Error("Consent proof must reference one verified evidence artifact");
  }
  const artifact = rawDb.prepare(`SELECT artifact_type AS artifactType,call_attempt_id AS callAttemptId,
    captured_at AS capturedAt,retention_until AS retentionUntil FROM consent_evidence_artifacts
    WHERE tenant_id=? AND id=? AND lead_id=? AND phone_id=?
      AND verification_method='signed_storage_attestation_v1'`).get(input.tenantId, input.evidenceArtifactRef,
    input.leadId, input.phoneId) as any;
  if (!artifact) throw new Error("Consent evidence artifact is not registered and verified");
  const expectedArtifactType = input.method === "recorded_call" ? "voice_recording"
    : input.method === "signed_form" ? "signed_form" : "written_record";
  if (artifact.artifactType !== expectedArtifactType) throw new Error("Consent method does not match the verified artifact type");
  if (Math.abs(Date.parse(artifact.capturedAt) - Date.parse(input.capturedAt)) > 5 * 60_000
      || Date.parse(artifact.retentionUntil) < Date.parse(input.capturedAt) + 5 * 365 * 86_400_000) {
    throw new Error("Consent artifact timestamp or retention evidence is invalid");
  }
  const approvedDisclosure = rawDb.prepare(`SELECT id,version,disclosure_sha256 AS disclosureSha256,seller_name AS sellerName
    FROM approved_calling_scripts WHERE tenant_id=? AND version=? AND disclosure_sha256=?
      AND counsel_approved=1`).get(input.tenantId, input.disclosureVersion, input.disclosureTextSha256) as any;
  if (!approvedDisclosure || approvedDisclosure.sellerName !== input.seller) {
    throw new Error("Consent disclosure does not match a counsel-approved seller disclosure");
  }
  if (input.method === "recorded_call") {
    const attempt = rawDb.prepare(`SELECT id FROM call_attempts WHERE tenant_id=? AND id=? AND lead_id=? AND phone_id=?
      AND representative_user_id=? AND script_version=?`).get(input.tenantId, input.sourceRef, input.leadId,
      input.phoneId, input.actorUserId, input.disclosureVersion);
    if (!attempt) throw new Error("Recorded-call consent is not bound to this representative's call attempt");
    if (artifact.callAttemptId !== input.sourceRef) throw new Error("Voice evidence artifact is bound to a different call attempt");
  }
  const evidence = JSON.stringify({ seller: input.seller, organizationId: input.organizationId, phoneId: input.phoneId,
    serviceAddress: input.serviceAddress, consumerIdentity: input.consumerIdentity,
    consentType: input.consentType, channels: input.channels, scope: input.scope,
    disclosureVersion: input.disclosureVersion, disclosureTextSha256: input.disclosureTextSha256,
    capturedAt: input.capturedAt, timeZone: input.timeZone, method: input.method, sourceRef: input.sourceRef,
    affirmativeAction: input.affirmativeAction, ipAddress: input.ipAddress ?? null,
    deviceMetadata: input.deviceMetadata ?? null, expiresAt: input.expiresAt ?? null,
    evidenceArtifactRef: input.evidenceArtifactRef, voiceRecordingRef: input.voiceRecordingRef ?? null,
    signatureRef: input.signatureRef ?? null });
  const evidenceHash = sha256(evidence);
  const replay = rawDb.prepare(`SELECT id FROM consent_records WHERE tenant_id=? AND evidence_sha256=?`)
    .get(input.tenantId, evidenceHash) as { id: string } | undefined;
  if (replay) return replay.id;
  const id = crypto.randomUUID();
  inImmediateTransaction(() => {
    rawDb.prepare(`INSERT INTO consent_records
      (id,tenant_id,lead_id,contact_id,phone_id,seller,service_address,consumer_identity,consent_type,channels_json,scope,
       disclosure_version,disclosure_text_sha256,method,source_ref,affirmative_action,source_url,ip_address,device_metadata_json,
       evidence_artifact_ref,voice_recording_ref,signature_ref,captured_at,time_zone,expires_at,created_by,evidence_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.tenantId, input.leadId, input.contactId ?? null,
        input.phoneId, input.seller, input.serviceAddress, input.consumerIdentity, input.consentType, JSON.stringify(input.channels), input.scope,
        input.disclosureVersion, input.disclosureTextSha256, input.method, input.sourceRef, input.affirmativeAction,
        null, input.ipAddress ?? null, input.deviceMetadata ? JSON.stringify(input.deviceMetadata) : null,
        input.evidenceArtifactRef, input.voiceRecordingRef ?? null, input.signatureRef ?? null,
        input.capturedAt, input.timeZone, input.expiresAt ?? null, input.actorUserId, evidenceHash);
    appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId, eventType: "consent.recorded",
      entityType: "lead", entityId: String(input.leadId), actorUserId: input.actorUserId,
      metadata: { leadId: input.leadId, phoneId: input.phoneId, consentId: id, consentType: input.consentType,
        channels: input.channels, disclosureVersion: input.disclosureVersion,
        evidenceSha256: evidenceHash, durableProof: input.voiceRecordingRef ? "voice_recording" : "signature" } });
  });
  return id;
}

export function revokeConsent(input: {
  tenantId: number;
  leadId: number;
  consentId: string;
  phoneId: number;
  actorUserId: number;
  scope: string;
  method: string;
  evidenceRef: string;
  correlationId: string;
}): string {
  const consent = rawDb.prepare(`SELECT id FROM consent_records WHERE id=? AND tenant_id=? AND lead_id=? AND phone_id=?`)
    .get(input.consentId, input.tenantId, input.leadId, input.phoneId);
  if (!consent) throw new Error("Consent record not found");
  const existing = rawDb.prepare(`SELECT id FROM consent_revocations WHERE tenant_id=? AND consent_id=? ORDER BY revoked_at LIMIT 1`)
    .get(input.tenantId, input.consentId) as { id: string } | undefined;
  const id = existing?.id ?? crypto.randomUUID();
  rawDb.transaction(() => {
    createInternalOptOut({ tenantId: input.tenantId, leadId: input.leadId, phoneId: input.phoneId,
      actorUserId: input.actorUserId, reason: "consent_revoked", channel: input.method,
      sourceRef: id, correlationId: input.correlationId });
    if (!existing) {
      rawDb.prepare(`INSERT INTO consent_revocations
        (id,tenant_id,consent_id,phone_id,scope,method,evidence_ref,revoked_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, input.tenantId, input.consentId, input.phoneId, input.scope,
          input.method, input.evidenceRef, new Date().toISOString(), input.actorUserId);
      appendCallingAudit({ tenantId: input.tenantId, correlationId: input.correlationId,
        eventType: "consent.revoked", entityType: "lead", entityId: String(input.leadId), actorUserId: input.actorUserId,
        metadata: { leadId: input.leadId, phoneId: input.phoneId, consentId: input.consentId, revocationId: id,
          method: input.method, evidenceRefSha256: sha256(input.evidenceRef) } });
    }
  }).immediate();
  return id;
}

export function providerCostMetrics(tenantId: number): any[] {
  return rawDb.prepare(`SELECT p.id,p.provider_name AS providerName,p.query_cost_micros AS configuredQueryCostMicros,
    count(u.id) AS queries,coalesce(sum(u.cost_micros),0) AS totalCostMicros,
    coalesce(sum(u.successful_match),0) AS successfulMatches,
    coalesce(sum(u.compliant_usable_match),0) AS compliantUsableMatches,
    CASE WHEN sum(u.compliant_usable_match)>0 THEN CAST(sum(u.cost_micros) AS REAL)/sum(u.compliant_usable_match) END AS effectiveCostPerUsableMatchMicros
    FROM contact_enrichment_providers p LEFT JOIN provider_usage_events u ON u.provider_config_id=p.id AND u.tenant_id=p.tenant_id
    WHERE p.tenant_id=? GROUP BY p.id ORDER BY p.priority`).all(tenantId);
}
