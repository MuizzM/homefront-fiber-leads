import type { CallingDecision, ComplianceEvaluation, ComplianceRuleResult } from "@shared/calling";
import { apiRequest } from "@/lib/queryClient";

const ROOT = "/api/v1/calling";

export type CallingQueueStage =
  | "FRESH_FIBER_DETECTED"
  | "AWAITING_ENRICHMENT"
  | "AWAITING_PHONE_VALIDATION"
  | "AWAITING_DNC_CHECK"
  | "COMPLIANCE_REVIEW"
  | "COMPLIANCE_BLOCKED"
  | "ELIGIBLE_MANUAL_CALL"
  | "ATTEMPTED"
  | "CALLBACK_SCHEDULED"
  | "INTERESTED"
  | "CONVERTED"
  | "SUPPRESSED";

export interface CallingCandidate {
  queueId: string;
  leadId: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  freshConfirmedAt: string | null;
  freshConfidence: string | null;
  /** Reached the queue through a skip trace rather than the fiber pipeline. */
  traced: boolean;
  /** The scrub verdict for a traced lead's best number. ADVISORY — it says the
   *  registries do not forbid this number, not that the call is authorized.
   *  Null for leads that arrived through the fiber pipeline. */
  tracedBadge: { ready: boolean; label: string; reasons: string[] } | null;
  queueStage: CallingQueueStage | string;
  priority: number;
  assignedUserId: number | null;
  contactId: number | null;
  contactStatus: string | null;
  contactName: string | null;
  residentStatus: string | null;
  phoneId: number | null;
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
  lastDecisionId: string | null;
  lastDecisionStatus: CallingDecision | string | null;
  lastDecisionExpiresAt: string | null;
}

export interface CallingAuditEvent {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string | null;
  actorUserId: number | null;
  metadata: Record<string, unknown>;
  eventSha256: string;
  createdAt: string;
}

/** One number the trace returned for a door. `id` is the stored row, never the
 *  digits — selecting a number sends the id back and the server resolves it. */
export interface TracedPhoneOption {
  id: number;
  masked: string;
  lineType: string;
  confidence: number;
  ready: boolean;
  label: string;
  reasons: string[];
  active: boolean;
  selectable: boolean;
}

export interface CallingLeadDetail {
  candidate: CallingCandidate;
  /** Every traced number for this door. The queue carries one at a time; a rep
   *  moves the door onto another when the first is wrong-party or unreachable. */
  tracedPhones: TracedPhoneOption[];
  timeline: CallingAuditEvent[];
  decision: {
    id: string;
    finalStatus: CallingDecision | string;
    eligible: boolean;
    reasonCodes: string[];
    rules: ComplianceRuleResult[];
    evaluatedAt: string;
    expiresAt: string;
    localTime: string | null;
    timeZone: string | null;
    ruleVersion: string;
  } | null;
  decisionError: string | null;
  consent: {
    id: string | null;
    verified: boolean;
    revoked: boolean;
  };
  attempts: Array<{
    id: string; startedAt: string; endedAt: string | null; durationSeconds: number | null;
    dispositionCode: DispositionCode | null; notes: string | null; scriptVersion: string;
    representativeUserId: number;
  }>;
  callbacks: Array<{
    id: string; dueAt: string; timeZone: string; status: string; cancelledAt: string | null; completedAt: string | null;
  }>;
  openAttempt: {
    attemptId: string;
    startedAt: string;
    maskedPhone: string;
    script: NonNullable<CallingStatus["activeScript"]>;
  } | null;
}

export interface CallingProfile {
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
  propagateOptOutPlatformWide: boolean;
  callerIdAuthorized: boolean;
  callerIdReference: string | null;
  policyVersion: number;
}

export interface DncDatasetSummary {
  id: string;
  versionLabel: string;
  importedAt: string;
  sourceAsOf: string;
  sourceRetrievedAt: string;
  expiresAt: string;
  fresh: boolean;
  state?: string | null;
}

export interface SignedDncImportManifest {
  tenantId?: number;
  sourceType: "national" | "state";
  state?: string | null;
  versionLabel: string;
  authorizedAccountRef: string;
  coveredAreaCodes: string[];
  expectedRecordCount: number;
  expectedChunkCount: number;
  chunkSize: number;
  sourceManifestSha256: string;
  sourceAsOf: string;
  sourceRetrievedAt: string;
  maxAgeDays: number;
  manifestSignature: string;
}

export interface DncImportProgress {
  phase: "starting" | "uploading" | "finalizing" | "complete";
  uploadedChunks: number;
  totalChunks: number;
  stagedUnique: number;
}

export interface CallingStatus {
  enabled: boolean;
  callable: boolean;
  blockers: string[];
  environment: {
    moduleEnabled: boolean;
    enrichmentEnabled: boolean;
    nationalDncEnabled: boolean;
    stateDncEnabled: boolean;
    manualClickRequired: boolean;
    pilotAllowed: boolean;
    secretsReady: boolean;
    emergencyDisabled: boolean;
  };
  profile: CallingProfile;
  dnc: {
    national: DncDatasetSummary | null;
    states: DncDatasetSummary[];
    internalCount: number;
    platformCount: number;
  };
  activeScript: { id: string; version: string; title: string; body: string; disclosureSha256: string; sellerName: string; companyName: string; purpose: string } | null;
  activeRuleVersion: { id: string; version: string; approvedAt: string } | null;
}

export interface CallingRuntimeStatus {
  enabled: boolean;
  callable: boolean;
  blockers: string[];
  environment: {
    moduleEnabled: boolean;
    enrichmentEnabled: boolean;
    nationalDncEnabled: boolean;
    stateDncEnabled: boolean;
    manualClickRequired: boolean;
    pilotAllowed: boolean;
    secretsReady: boolean;
    emergencyDisabled: boolean;
  };
  organization: {
    callingEnabled: boolean;
    emergencyDisabled: boolean;
    policyVersion: number;
  };
  /** Whether skip-traced doors can enter the queue at all. `available` is false
   *  until an operator approves the trace provider's contract, and the queue
   *  says so rather than rendering an unexplained empty list. */
  tracedImport: { available: boolean; contractStatus: string };
  activeScript: { version: string; title: string } | null;
  activeRuleVersion: string | null;
  representativeHold: { id: string; reason: string; placedAt: string } | null;
}

export interface RepresentativeCallingHold {
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
}

export interface CallingRepresentative {
  id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  hold: RepresentativeCallingHold | null;
}

export interface ProviderCostMetric {
  id: string;
  providerName: string;
  configuredQueryCostMicros: number;
  queries: number;
  totalCostMicros: number;
  successfulMatches: number;
  compliantUsableMatches: number;
  effectiveCostPerUsableMatchMicros: number | null;
}

export type DispositionCode =
  | "NO_ANSWER" | "BUSY" | "DISCONNECTED" | "VOICEMAIL_REACHED" | "LEFT_NO_MESSAGE"
  | "CALLBACK_REQUESTED" | "INTERESTED" | "NOT_INTERESTED" | "WRONG_NUMBER" | "WRONG_PARTY"
  | "PROPERTY_OWNER_NOT_RESIDENT" | "ALREADY_HAS_SERVICE" | "NOT_SERVICEABLE"
  | "APPOINTMENT_SCHEDULED" | "SALE_STARTED" | "SALE_COMPLETED" | "DO_NOT_CALL"
  | "CONSENT_GRANTED" | "CONSENT_REVOKED" | "LANGUAGE_BARRIER" | "REVIEW_REQUIRED";

export interface ConsentEvidence {
  consumerIdentity: string;
  consentType: string;
  channels: ["manual_voice_call"];
  scope: string;
  disclosureVersion: string;
  disclosureTextSha256: string;
  capturedAt: string;
  timeZone: string;
  method: "signed_form" | "recorded_call" | "written" | "other";
  affirmativeAction: string;
  evidenceArtifactRef: string;
  voiceRecordingRef?: string;
  signatureRef?: string;
  sourceRef: string;
}

type PublicCallingCandidate = {
  queueId: string; leadId: number; address: string; city: string; state: string; zip: string;
  freshConfirmedAt: string | null; freshConfidence: string | null; traced?: boolean;
  tracedBadge?: { ready: boolean; label: string; reasons: string[] } | null;
  stage: string; priority: number;
  assignedUserId: number | null;
  contact: { id: number; status: string | null; name: string | null; residentStatus: string | null } | null;
  phone: { id: number; masked: string | null; validationStatus: string | null; verifiedAt: string | null;
    verificationExpiresAt: string | null; lineType: string | null; reassignedRisk: boolean } | null;
  identityConfidence: number; wrongParty: boolean;
  provider: { id?: string; name: string; permittedUseApproved: boolean } | null;
  lastDecision: { id: string; status: CallingDecision | string | null; expiresAt: string | null } | null;
};

function candidateFromApi(value: PublicCallingCandidate): CallingCandidate {
  return {
    queueId: value.queueId, leadId: value.leadId, address: value.address, city: value.city, state: value.state, zip: value.zip,
    freshConfirmedAt: value.freshConfirmedAt, freshConfidence: value.freshConfidence,
    traced: Boolean(value.traced), tracedBadge: value.tracedBadge ?? null, queueStage: value.stage,
    priority: Number(value.priority || 0), assignedUserId: value.assignedUserId,
    contactId: value.contact?.id ?? null, contactStatus: value.contact?.status ?? null,
    contactName: value.contact?.name ?? null, residentStatus: value.contact?.residentStatus ?? null,
    phoneId: value.phone?.id ?? null, maskedPhone: value.phone?.masked ?? null,
    phoneValidationStatus: value.phone?.validationStatus ?? null, phoneLastVerifiedAt: value.phone?.verifiedAt ?? null,
    phoneVerificationExpiresAt: value.phone?.verificationExpiresAt ?? null, lineType: value.phone?.lineType ?? null,
    reassignedRisk: Boolean(value.phone?.reassignedRisk), identityConfidence: Number(value.identityConfidence || 0),
    wrongParty: Boolean(value.wrongParty), providerConfigId: value.provider?.id ?? null,
    providerName: value.provider?.name ?? null, lastDecisionId: value.lastDecision?.id ?? null,
    lastDecisionStatus: value.lastDecision?.status ?? null, lastDecisionExpiresAt: value.lastDecision?.expiresAt ?? null,
  };
}

async function json<T>(request: Promise<Response>): Promise<T> {
  return (await request).json() as Promise<T>;
}

export async function getCallingStatus(): Promise<CallingRuntimeStatus> {
  const status = await json<any>(apiRequest("GET", `${ROOT}/status`));
  return {
    enabled: Boolean(status.enabled), callable: Boolean(status.enabled), blockers: status.blockers ?? [],
    environment: {
      moduleEnabled: Boolean(status.environment?.moduleEnabled), enrichmentEnabled: Boolean(status.environment?.enrichmentEnabled),
      nationalDncEnabled: Boolean(status.environment?.nationalDncEnabled), stateDncEnabled: Boolean(status.environment?.stateDncEnabled),
      manualClickRequired: Boolean(status.environment?.manualClickToCallEnabled), pilotAllowed: Boolean(status.environment?.pilotAllowed),
      secretsReady: Boolean(status.environment?.secretsReady), emergencyDisabled: Boolean(status.environment?.emergencyDisabled),
    },
    organization: status.organization,
    tracedImport: {
      available: Boolean(status.tracedImport?.available),
      contractStatus: String(status.tracedImport?.contractStatus ?? "unapproved"),
    },
    activeScript: status.activeScript,
    activeRuleVersion: status.activeRuleVersion,
    representativeHold: status.representativeHold ?? null,
  };
}

export async function getCallingComplianceStatus(): Promise<CallingStatus> {
  const summary = await json<any>(apiRequest("GET", `${ROOT}/compliance/summary`));
  const environment = summary.environment;
  const profile = summary.profile as CallingProfile;
  const blockers = [
    !environment.moduleEnabled && "module_flag_off",
    environment.emergencyDisabled && "global_emergency_stop_on",
    !environment.pilotAllowed && "organization_not_in_pilot",
    !environment.secretsReady && "calling_secrets_missing",
    !environment.nationalDncEnabled && "national_dnc_flag_off",
    !environment.stateDncEnabled && "state_dnc_flag_off",
    !environment.manualClickToCallEnabled && "manual_call_flag_off",
    !profile.callingEnabled && "organization_calling_off",
    profile.emergencyDisabled && "organization_emergency_stop_on",
    !profile.counselApproved && "counsel_approval_missing",
    !profile.sellerAuthorized && "seller_authorization_missing",
    !profile.callerIdAuthorized && "caller_id_authorization_missing",
    !summary.activeScript && "approved_script_missing",
    !summary.activeRuleVersion && "approved_rules_missing",
    !summary.dnc?.national?.fresh && "national_dnc_missing_or_stale",
  ].filter((value): value is string => Boolean(value));
  return {
    enabled: blockers.length === 0, callable: blockers.length === 0, blockers,
    environment: {
      moduleEnabled: Boolean(environment.moduleEnabled), enrichmentEnabled: Boolean(environment.enrichmentEnabled),
      nationalDncEnabled: Boolean(environment.nationalDncEnabled), stateDncEnabled: Boolean(environment.stateDncEnabled),
      manualClickRequired: Boolean(environment.manualClickToCallEnabled), pilotAllowed: Boolean(environment.pilotAllowed),
      secretsReady: Boolean(environment.secretsReady), emergencyDisabled: Boolean(environment.emergencyDisabled),
    },
    profile,
    dnc: summary.dnc,
    activeScript: summary.activeScript,
    activeRuleVersion: summary.activeRuleVersion,
  };
}

export async function getCallingQueue(
  options: { stage?: string; limit?: number; source?: "traced" | "fiber" } = {},
): Promise<CallingCandidate[]> {
  const params = new URLSearchParams();
  if (options.stage) params.set("stage", options.stage);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.source) params.set("source", options.source);
  const payload = await json<{ queue: PublicCallingCandidate[] }>(
    apiRequest("GET", `${ROOT}/queue${params.size ? `?${params}` : ""}`),
  );
  return payload.queue.map(candidateFromApi);
}

export interface CallingCallback {
  id: string; leadId: number; dueAt: string; timeZone: string; status: string;
  assignedUserId: number | null;
  address: string; city: string; state: string; zip: string; maskedPhone: string | null;
}

// AUDIT FIX: the callbacks endpoint existed server-side with ZERO client
// consumers — scheduled callbacks were effectively invisible to reps.
export async function getCallingCallbacks(limit = 100): Promise<CallingCallback[]> {
  const payload = await json<{ callbacks: CallingCallback[] }>(apiRequest("GET", `${ROOT}/callbacks?limit=${limit}`));
  return payload.callbacks ?? [];
}

export async function getCallingLead(leadId: number): Promise<CallingLeadDetail> {
  const payload = await json<{ lead: PublicCallingCandidate; timeline: CallingAuditEvent[];
    attempts?: CallingLeadDetail["attempts"]; callbacks?: CallingLeadDetail["callbacks"];
    openAttempt?: CallingLeadDetail["openAttempt"]; consent?: CallingLeadDetail["consent"];
    tracedPhones?: TracedPhoneOption[] }>(
    apiRequest("GET", `${ROOT}/leads/${leadId}`),
  );
  const candidate = candidateFromApi(payload.lead);
  let decision: CallingLeadDetail["decision"] = null;
  let decisionError: string | null = null;
  if (candidate.lastDecisionId) {
    try {
      const result = await json<{ decision: CallingLeadDetail["decision"] }>(apiRequest("GET", `${ROOT}/decisions/${encodeURIComponent(candidate.lastDecisionId)}`));
      decision = result.decision;
    } catch (e: any) { decision = null; decisionError = String(e?.message ?? "fetch failed"); }
  }
  return { candidate, tracedPhones: payload.tracedPhones ?? [], timeline: payload.timeline ?? [], decision, decisionError,
    consent: payload.consent ?? { id: null, verified: false, revoked: false },
    attempts: payload.attempts ?? [], callbacks: payload.callbacks ?? [], openAttempt: payload.openAttempt ?? null };
}

/**
 * Per-lead speaking script (GET /api/v1/calling/leads/:leadId/script).
 *
 * WIRE shape (server/calling/scriptEngine.ts GeneratedScript): objection
 * handlers are an OBJECT keyed by slug ({price, currentProvider, renter,
 * worksFine} → string) and provenance is `model: "rules" | "llm"` — there is
 * NO engine field. The client renders verbatim and NEVER invents content
 * when the endpoint fails.
 */
export interface LeadScriptWire {
  version?: string;
  model?: "rules" | "llm" | string;
  generatedAt?: string;
  cached?: boolean;
  sections?: {
    opener?: string;
    neighborhoodHook?: string;
    valueProposition?: string | string[];
    /** legacy alternate key — accepted defensively */
    valueProp?: string | string[];
    /** WIRE: object keyed by slug. Array form also accepted defensively. */
    objectionHandlers?: Record<string, string> | Array<{ objection?: string; response?: string }>;
    close?: string;
    complianceFooter?: string;
    /** legacy alternate key — accepted defensively */
    disclosure?: string;
  };
}

/** camelCase / snake_case slug → "Current provider" (objection row labels). */
function humanizeSlug(slug: string): string {
  const words = String(slug).replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Objection";
}

/**
 * NORMALIZED shape the panel renders: objectionHandlers is ALWAYS an array
 * of {objection, response} rows. Normalization happens here — the single
 * choke point — so a wire-shaped object can never reach the render path and
 * crash the call screen mid-attempt.
 */
export interface LeadScript extends Omit<LeadScriptWire, "sections"> {
  sections?: Omit<NonNullable<LeadScriptWire["sections"]>, "objectionHandlers"> & {
    objectionHandlers?: Array<{ objection: string; response: string }>;
  };
}

export function normalizeLeadScript(wire: LeadScriptWire): LeadScript {
  const sections = wire.sections;
  if (!sections) return { ...wire, sections };
  const raw = sections.objectionHandlers;
  const objectionHandlers = Array.isArray(raw)
    ? raw.map(item => ({ objection: String(item?.objection ?? ""), response: String(item?.response ?? "") }))
    : Object.entries(raw ?? {}).map(([key, value]) => ({ objection: humanizeSlug(key), response: String(value) }));
  return { ...wire, sections: { ...sections, objectionHandlers } };
}

export async function getLeadScript(leadId: number): Promise<LeadScript> {
  const wire = await json<LeadScriptWire>(apiRequest("GET", `${ROOT}/leads/${leadId}/script`));
  return normalizeLeadScript(wire);
}

export function evaluateCallingLead(leadId: number): Promise<{ decisionId: string; evaluation: ComplianceEvaluation }> {
  return json(apiRequest("POST", `${ROOT}/leads/${leadId}/evaluate`, {}));
}

export function authorizeManualCall(leadId: number): Promise<{
  token: string;
  expiresAt: string;
  decisionId: string;
  maskedPhone: string;
  script: CallingStatus["activeScript"];
}> {
  return json<any>(apiRequest("POST", `${ROOT}/leads/${leadId}/authorize-call`, {
    action: "reveal_and_hand_dial", manualActionConfirmed: true,
  })).then(value => ({ ...value, token: value.authorizationToken }));
}

export function startManualCall(token: string): Promise<{
  attemptId: string;
  phoneNumber: string;
  script: NonNullable<CallingStatus["activeScript"]>;
  noAutomaticNextCall: true;
}> {
  return json(apiRequest("POST", `${ROOT}/attempts/start`, { authorizationToken: token }));
}

export function auditPhoneCopy(attemptId: string): Promise<{ audited: true }> {
  return json(apiRequest("POST", `${ROOT}/attempts/${encodeURIComponent(attemptId)}/copy-number`, {}));
}

export function saveDisposition(attemptId: string, input: {
  code: DispositionCode;
  notes?: string;
  callbackAt?: string;
  callbackTimeZone?: string;
  callbackConsentEvidenceRef?: string;
  idempotencyKey: string;
}): Promise<{ dispositionId: string; stage: string; replayed: boolean }> {
  return json(apiRequest("POST", `${ROOT}/attempts/${encodeURIComponent(attemptId)}/dispositions`, input));
}

export function addInternalOptOut(leadId: number, input: {
  reason: "do_not_call" | "stop_request" | "wrong_number" | "wrong_party" | "consent_revoked";
  channel: "live_call" | "voicemail_return" | "written" | "email" | "in_person" | "other";
  sourceRef?: string;
}): Promise<{
  dncId: string;
  alreadySuppressed: boolean;
}> {
  return json(apiRequest("POST", `${ROOT}/leads/${leadId}/opt-out`, input));
}

export function saveConsent(leadId: number, input: ConsentEvidence): Promise<{ id: string }> {
  return json<{ consentId: string }>(apiRequest("POST", `${ROOT}/leads/${leadId}/consent`, input)).then(value => ({ id: value.consentId }));
}

export function validateCallingPhone(leadId: number, input: {
  providerConfigId?: string;
  idempotencyKey: string;
}): Promise<unknown> {
  return json(apiRequest("POST", `${ROOT}/leads/${leadId}/validate-phone`, input));
}

export function enrichCallingLead(leadId: number): Promise<unknown> {
  return json(apiRequest("POST", `${ROOT}/leads/${leadId}/enrich`, { idempotencyKey: newIdempotencyKey() }));
}

/** Move this door onto another traced number. Any unused call authorization is
 *  invalidated server-side — one is issued against a specific phone. */
export function selectTracedPhone(leadId: number, tracedPhoneId: number): Promise<{
  invalidatedAuthorizations: number;
  alreadyActive: boolean;
  tracedPhones: TracedPhoneOption[];
}> {
  return json(apiRequest("POST", `${ROOT}/leads/${leadId}/traced-phones/${tracedPhoneId}/select`));
}

export function revokeCallingConsent(consentId: string, input: { scope: string; method: "live_call" | "written" | "email" | "in_person" | "other"; evidenceRef: string }): Promise<{ id: string }> {
  return json<{ revocationId: string }>(apiRequest("POST", `${ROOT}/consents/${encodeURIComponent(consentId)}/revoke`, input)).then(value => ({ id: value.revocationId }));
}

export function updateCallingProfile(input: Omit<CallingProfile, "tenantId" | "policyVersion">): Promise<CallingProfile> {
  return json<{ profile: CallingProfile }>(apiRequest("PATCH", `${ROOT}/compliance/config`, input)).then(value => value.profile);
}

export function importDncDataset(input: {
  sourceType: "national" | "state";
  state?: string;
  versionLabel: string;
  authorizedAccountRef: string;
  coveredAreaCodes: string[];
  phones: string[];
}): Promise<{ id: string; imported: number; rejected: number; checksum: string }> {
  return json(apiRequest("POST", `${ROOT}/compliance/dnc/import`, { ...input, maxAgeDays: 31 }));
}

export async function importSignedDncDataset(
  manifest: SignedDncImportManifest,
  phoneLines: string[],
  onProgress?: (progress: DncImportProgress) => void,
): Promise<{ datasetId: string; recordCount: number; checksum: string; expiresAt: string }> {
  const { tenantId: _tenantId, ...serverManifest } = manifest;
  if (phoneLines.length === 0) throw new Error("The selected DNC file is empty");
  const chunks: string[][] = [];
  for (let index = 0; index < phoneLines.length; index += manifest.chunkSize) {
    chunks.push(phoneLines.slice(index, index + manifest.chunkSize));
  }
  if (chunks.length !== manifest.expectedChunkCount) {
    throw new Error(`Signed manifest expects ${manifest.expectedChunkCount} chunks, but this file produces ${chunks.length}`);
  }
  onProgress?.({ phase: "starting", uploadedChunks: 0, totalChunks: chunks.length, stagedUnique: 0 });
  const started = await json<{ importId: string; status: "pending" | "finalized"; replayed: boolean;
    finalized?: { datasetId: string; recordCount: number; checksum: string; expiresAt: string } }>(
    apiRequest("POST", `${ROOT}/compliance/dnc/imports`, serverManifest),
  );
  if (started.status === "finalized" && started.finalized) {
    onProgress?.({ phase: "complete", uploadedChunks: chunks.length, totalChunks: chunks.length,
      stagedUnique: started.finalized.recordCount });
    return started.finalized;
  }
  let stagedUnique = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const result = await json<{ stagedUnique: number }>(apiRequest(
      "POST", `${ROOT}/compliance/dnc/imports/${encodeURIComponent(started.importId)}/chunks`,
      { chunkIndex, phones: chunks[chunkIndex] },
    ));
    stagedUnique = result.stagedUnique;
    onProgress?.({ phase: "uploading", uploadedChunks: chunkIndex + 1, totalChunks: chunks.length, stagedUnique });
  }
  onProgress?.({ phase: "finalizing", uploadedChunks: chunks.length, totalChunks: chunks.length, stagedUnique });
  const finalized = await json<{ datasetId: string; recordCount: number; checksum: string; expiresAt: string }>(
    apiRequest("POST", `${ROOT}/compliance/dnc/imports/${encodeURIComponent(started.importId)}/finalize`, {}),
  );
  onProgress?.({ phase: "complete", uploadedChunks: chunks.length, totalChunks: chunks.length, stagedUnique: finalized.recordCount });
  return finalized;
}

export function getProviderMetrics(): Promise<ProviderCostMetric[]> {
  return json<{ providers: ProviderCostMetric[] }>(apiRequest("GET", `${ROOT}/compliance/provider-usage`)).then(value => value.providers);
}

export function getCallingAudit(): Promise<CallingAuditEvent[]> {
  return json<{ events: CallingAuditEvent[] }>(apiRequest("GET", `${ROOT}/compliance/audit?limit=100`)).then(value => value.events);
}

export function getRepresentativeCallingHolds(): Promise<{
  representatives: CallingRepresentative[];
  history: RepresentativeCallingHold[];
}> {
  return json(apiRequest("GET", `${ROOT}/compliance/representative-holds`));
}

export function placeRepresentativeCallingHold(
  representativeUserId: number,
  reason: string,
): Promise<{ hold: RepresentativeCallingHold; changed: boolean; invalidatedAuthorizations: number; terminatedAttemptCount: number }> {
  return json(apiRequest("POST", `${ROOT}/compliance/representative-holds/${representativeUserId}`, { reason }));
}

export function releaseRepresentativeCallingHold(
  representativeUserId: number,
  reason: string,
): Promise<{ hold: RepresentativeCallingHold; released: true; requiresFreshComplianceEvaluation: true }> {
  return json(apiRequest("POST", `${ROOT}/compliance/representative-holds/${representativeUserId}/release`, { reason }));
}

export function formatDecision(value: string | null | undefined): string {
  if (!value) return "Not evaluated";
  return value.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}

export function formatStage(value: string): string {
  return value.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}

export function newIdempotencyKey(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
